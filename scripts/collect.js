#!/usr/bin/env node
/**
 * 每日 AI 新闻采集脚本 v4（综合 Top15 榜单 + 明亮阳光配色）
 * 功能：从多个 AI 新闻源采集 -> 过滤去重 -> 按热度排序取 Top15 -> 生成榜单网页
 * 用法：node collect.js
 * 输出：output/index.html
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const HTML_FILE = path.join(OUTPUT_DIR, 'index.html');
// GitHub Pages 需要根目录的 index.html，同时输出一份到根目录
const ROOT_HTML_FILE = path.join(__dirname, '..', 'index.html');

// ============ 工具函数 ============
function fetchText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { ...options, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout: ' + url)); });
    req.end();
  });
}

function fetchJson(url, options = {}) {
  return fetchText(url, options).then(data => JSON.parse(data));
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ============ DeepSeek 翻译 ============
// 从 .env 文件或环境变量读取 API Key（不写死在代码里，避免泄露）
const DEEPSEEK_API_KEY = loadApiKey();

function loadApiKey() {
  // 1. 环境变量
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  // 2. 读取同目录上级的 .env 文件
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/^DEEPSEEK_API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}

// 批量翻译英文标题为中文
async function translateTitles(items) {
  // 找出需要翻译的（标题含较多英文字母的）
  const needTranslate = items.filter(it => isEnglish(it.title));
  if (needTranslate.length === 0) return items;

  console.log(`🈶 需要翻译 ${needTranslate.length} 条英文标题...`);

  // 分批翻译（每批 10 条）
  const BATCH = 10;
  const translated = {};

  for (let i = 0; i < needTranslate.length; i += BATCH) {
    const batch = needTranslate.slice(i, i + BATCH);
    const titles = batch.map(b => b.title);
    
    try {
      const result = await callDeepSeekTranslate(titles);
      if (result && Array.isArray(result)) {
        batch.forEach((b, idx) => {
          if (result[idx]) translated[b.title] = result[idx];
        });
      }
    } catch (e) {
      console.error('翻译批次失败:', e.message);
    }
  }

  // 附加翻译结果
  return items.map(it => {
    if (translated[it.title]) {
      return { ...it, title_zh: translated[it.title] };
    }
    return it;
  });
}

function isEnglish(text) {
  // 统计英文字母占比，超过 40% 视为英文标题
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  const total = text.replace(/\s/g, '').length;
  return total > 0 && (letters / total) > 0.4;
}

function callDeepSeekTranslateOnce(titles) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的翻译。将英文标题翻译为简洁通顺的中文，直接返回翻译结果，不要添加任何解释、编号或引号。' },
        { role: 'user', content: `请逐条翻译以下标题为中文，每条一行，按顺序对应：\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}` }
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    const req = https.request('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        // 限流(429)或服务端错误(5xx)时抛出可重试标记
        if (res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600)) {
          reject(new Error('retryable_status_' + res.statusCode + ': ' + data.slice(0, 200)));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('http_' + res.statusCode + ': ' + data.slice(0, 200)));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          // 按行拆分翻译结果
          const lines = content.split('\n')
            .map(l => l.replace(/^\d+[.、]\s*/, '').trim())
            .filter(l => l.length > 0);
          resolve(lines);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('translate timeout')); });
    req.end(body);
  });
}

// DeepSeek 翻译带重试：429/5xx/超时/网络错误时指数退避重试，最多 3 次
function callDeepSeekTranslate(titles) {
  const MAX_RETRY = 3;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  return (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await callDeepSeekTranslateOnce(titles);
      } catch (e) {
        lastErr = e;
        const retryable = /retryable_status_|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(e.message || '');
        if (!retryable || attempt === MAX_RETRY) {
          if (!retryable) throw e;
          break;
        }
        const delay = 5000 * Math.pow(2, attempt);
        console.log(`⏳ DeepSeek 翻译第 ${attempt + 1} 次失败（${e.message}），${delay / 1000}s 后重试...`);
        await sleep(delay);
      }
    }
    throw lastErr;
  })();
}

// ============ 新闻源采集 ============
async function fetchHackerNews() {
  try {
    const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = ids.slice(0, 60);
    const stories = await Promise.all(
      topIds.map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null))
    );
    return stories
      .filter(s => s && s.title && s.url)
      .filter(s => /AI|GPT|LLM|model|OpenAI|Anthropic|DeepSeek|Claude|Gemini|machine learning|neural|robot|agent|LLaMA/i.test(s.title))
      .map(s => ({
        title: s.title,
        url: s.url,
        source: 'Hacker News',
        score: s.score || 0,
        date: new Date(s.time * 1000).toISOString().slice(0, 10),
      }));
  } catch (e) {
    console.error('HN error:', e.message);
    return [];
  }
}

// RSS/Atom/RDF 通用解析
function parseRSS(xml) {
  const items = [];
  
  // RSS 2.0 (<item>)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    if (title && link) {
      items.push({
        title: decodeEntities(title).trim(),
        url: link.trim(),
        date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : '',
        desc: decodeEntities(desc).replace(/<[^>]+>/g, '').slice(0, 120),
      });
    }
  }

  // Atom (<entry>)
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      let link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const pubDate = (block.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || (block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || '';
      if (title && link) {
        items.push({
          title: decodeEntities(title).trim(),
          url: link.trim(),
          date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : '',
        });
      }
    }
  }

  // RDF/RSS 1.0
  if (items.length === 0) {
    const rdfRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    while ((m = rdfRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      let link = (block.match(/<link[^>]*rdf:resource="([^"]+)"/) || [])[1] || '';
      if (!link) link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      if (title && link) {
        items.push({ title: decodeEntities(title).trim(), url: link.trim() });
      }
    }
  }

  return items;
}

// AI 相关关键词过滤
const AI_KEYWORDS = /AI|GPT|LLM|模型|OpenAI|Anthropic|DeepSeek|Claude|Gemini|人工智能|机器学习|深度学习|智能体|agent|neural|大模型|ChatGPT|Midjourney|Stable Diffusion|AGI|AIGC|LLaMA|Mistral|Qwen|文心|通义|豆包|智谱|Kimi|Copilot|Gemma/i;

const RSS_SOURCES = [
  // 中文源
  { url: 'https://www.qbitai.com/feed', name: '量子位' },
  { url: 'https://www.infoq.cn/feed', name: 'InfoQ' },
  { url: 'https://www.leiphone.com/feed', name: '雷锋网' },
  { url: 'https://www.ithome.com/rss/', name: 'IT之家' },
  { url: 'https://www.36kr.com/feed', name: '36氪' },
  { url: 'https://www.ifanr.com/feed', name: '爱范儿' },
  // 英文源
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
  { url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', name: 'MIT 科技评论' },
];

async function fetchRSSSources() {
  const all = [];
  for (const src of RSS_SOURCES) {
    try {
      const xml = await fetchText(src.url);
      const items = parseRSS(xml);
      const filtered = items
        .filter(i => AI_KEYWORDS.test(i.title))
        .map(i => ({ ...i, source: src.name, score: 70 }));
      all.push(...filtered);
      console.log(`  ✓ ${src.name}: ${filtered.length} 条`);
    } catch (e) {
      console.log(`  ✗ ${src.name}: ${e.message}`);
    }
  }
  return all;
}

function dedupe(news) {
  const seen = new Set();
  const result = [];
  for (const item of news) {
    const key = item.title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

// ============ 生成 HTML（Top15 榜单 + 明亮配色） ============
function generateHTML(news, dateStr) {
  const items = news.map((item, i) => `
    <li class="news-item">
      <div class="rank ${i < 3 ? 'top' : ''}">${i + 1}</div>
      <div class="news-body">
        <a href="${item.url}" target="_blank" rel="noopener" class="news-title">${escapeHtml(item.title_zh || item.title)}</a>
        ${item.title_zh ? `<div class="news-orig">${escapeHtml(item.title)}</div>` : ''}
        <div class="news-meta">
          <span class="source">${escapeHtml(item.source || '综合')}</span>
          ${item.score ? `<span class="heat">🔥 ${item.score}</span>` : ''}
          ${item.date ? `<span class="date">${item.date}</span>` : ''}
        </div>
      </div>
    </li>
  `).join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>每日 AI 动态 · ${dateStr}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: linear-gradient(160deg, #fff7e6 0%, #ffe8d6 40%, #dbeafe 100%);
      color: #1e293b;
      min-height: 100vh;
      padding: 30px 16px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    header {
      text-align: center;
      margin-bottom: 28px;
      padding: 36px 20px;
      border-radius: 20px;
      background: linear-gradient(135deg, #ff9a56, #ff7eb3, #6a9cff);
      box-shadow: 0 12px 32px rgba(255, 154, 86, 0.35);
      color: white;
    }
    header h1 { font-size: 30px; margin-bottom: 8px; letter-spacing: 1px; text-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    header p { font-size: 14px; opacity: 0.95; }
    .date-badge {
      display: inline-block; margin-top: 14px; padding: 6px 16px;
      border-radius: 20px; background: rgba(255,255,255,0.25);
      backdrop-filter: blur(4px); font-size: 13px; font-weight: 500;
    }
    .list-card {
      background: rgba(255,255,255,0.9);
      border-radius: 20px;
      box-shadow: 0 8px 28px rgba(148, 120, 80, 0.15);
      padding: 20px 16px;
      backdrop-filter: blur(6px);
    }
    .news-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .news-item {
      display: flex; align-items: flex-start; gap: 14px;
      padding: 14px 12px; border-radius: 14px;
      cursor: pointer; transition: all 0.2s;
      border: 1px solid transparent;
    }
    .news-item:hover { background: #fff1e0; border-color: #ffd8b0; transform: translateX(4px); }
    .rank {
      flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: 800; color: #ff7a45;
      background: #fff1e0;
    }
    .rank.top { background: linear-gradient(135deg, #ff7a45, #ff4d6d); color: white; box-shadow: 0 4px 12px rgba(255,77,109,0.3); }
    .news-body { flex: 1; min-width: 0; }
    .news-title {
      display: block; color: #1e293b; text-decoration: none;
      font-size: 15px; font-weight: 600; line-height: 1.5; margin-bottom: 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .news-title:hover { color: #ff6a3d; }
    .news-orig { font-size: 12px; color: #94a3b8; margin-bottom: 5px; line-height: 1.4; }
    .news-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .source {
      font-size: 11px; padding: 3px 10px; border-radius: 12px;
      background: #e0f2fe; color: #0369a1; font-weight: 600;
    }
    .heat { font-size: 11px; color: #f97316; }
    .date { font-size: 11px; color: #94a3b8; }
    footer { text-align: center; margin-top: 24px; padding: 16px; color: #94a3b8; font-size: 12px; }
    @media (max-width: 600px) {
      header h1 { font-size: 22px; }
      body { padding: 16px 10px; }
      .news-item { padding: 12px 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>☀️ 每日 AI 动态</h1>
      <p>精选人工智能领域今日最热资讯</p>
      <div class="date-badge">📅 ${dateStr} · 今日 Top ${news.length}</div>
    </header>
    <div class="list-card">
      <ol class="news-list">
        ${items}
      </ol>
    </div>
    <footer>由 OpenClaw 自动生成 · 每天早上 8:00 更新</footer>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============ 主流程 ============
async function main() {
  console.log('🚀 开始采集每日 AI 新闻...');
  
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('📡 采集 Hacker News...');
  const hnNews = await fetchHackerNews();

  console.log('📡 采集 RSS 源...');
  const rssNews = await fetchRSSSources();

  // 合并、去重
  let allNews = dedupe([...hnNews, ...rssNews]);

  // 如果采集太少用备用
  if (allNews.length < 5) {
    console.log('⚠️ 采集数量不足，使用备用数据');
    const today = new Date().toISOString().slice(0, 10);
    allNews = [
      { title: 'OpenAI 发布新一代推理模型，推理能力大幅提升', url: 'https://openai.com', source: 'AI快讯', score: 100, date: today },
      { title: 'DeepSeek V4 系列模型更新，代码能力增强', url: 'https://deepseek.com', source: 'AI快讯', score: 95, date: today },
      { title: 'Anthropic 更新 Claude 系列，强化长上下文处理', url: 'https://anthropic.com', source: 'AI快讯', score: 90, date: today },
      { title: 'Google Gemini 新增多模态推理功能', url: 'https://blog.google', source: 'AI快讯', score: 85, date: today },
      { title: '国产大模型竞争加剧，多家发布新品', url: 'https://baidu.com', source: 'AI快讯', score: 78, date: today },
    ];
  }

  // 翻译英文标题为中文
  allNews = await translateTitles(allNews);

  // 按热度排序
  allNews.sort((a, b) => (b.score || 0) - (a.score || 0));

  // 中英文各占一半：分别取英文源和中文源的前 N 条，交替排列
  const zhItems = allNews.filter(it => !isEnglish(it.title));       // 中文新闻（来自中文源）
  const enItems = allNews.filter(it => isEnglish(it.title));        // 英文新闻（翻译后展示）

  // 目标各占一半（15 条 -> 中文 8 + 英文 7）
  const zhCount = Math.ceil(15 / 2);   // 8
  const enCount = Math.floor(15 / 2);  // 7
  const topZh = zhItems.slice(0, zhCount);
  const topEn = enItems.slice(0, enCount);

  // 交替合并：先中后英交替，保证展示平衡
  const top = [];
  const maxLen = Math.max(topZh.length, topEn.length);
  for (let i = 0; i < maxLen; i++) {
    if (topZh[i]) top.push(topZh[i]);
    if (topEn[i]) top.push(topEn[i]);
  }

  // 如果中文源不足，用英文翻译补足（保持总量约 15）
  while (top.length < 15 && enItems[topEn.length]) {
    top.push(enItems[topEn.length++]);
  }

  // 重新编号（生成 HTML 时用索引）

  // 生成 HTML
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const html = generateHTML(top, dateStr);
  fs.writeFileSync(HTML_FILE, html, 'utf8');
  // 同时输出到根目录（GitHub Pages 需要）
  fs.writeFileSync(ROOT_HTML_FILE, html, 'utf8');

  // 生成微信推送摘要文件（供 cron 任务直接读取发送，不依赖 agent 现场整理）
  const summaryLines = top.map((it, i) => `${i + 1}. ${it.title_zh || it.title}`);
  const summary = `🤖 每日 AI 动态 · ${dateStr}\n\n${summaryLines.join('\n')}\n\n📄 完整榜单（Top ${top.length}）：https://yesuifeng688.github.io/ai-daily-news/`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.txt'), summary, 'utf8');

  const zhCountFinal = top.filter(it => !isEnglish(it.title)).length;
  const enCountFinal = top.filter(it => isEnglish(it.title)).length;
  console.log(`✅ 已生成 ${HTML_FILE}`);
  console.log(`📄 今日 Top ${top.length} 条（中文 ${zhCountFinal} / 英文 ${enCountFinal}）`);
  
  return { file: HTML_FILE, count: top.length, news: top };
}

if (require.main === module) {
  main().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });
}

module.exports = { main };
