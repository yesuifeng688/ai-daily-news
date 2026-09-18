#!/usr/bin/env node
/**
 * 每日 AI 新闻采集脚本 v5（国内中文源 + 技术文档模块）
 * 功能：中文 AI 新闻源 + 技术团队博客采集 -> 多源交叉/重大发布打分 -> 各取 Top10 -> 生成榜单网页
 * 用法：node collect.js
 * 输出：output/index.html、根目录 index.html、output/summary.txt
 * 热度口径：RSS 不提供阅读量，用「多源交叉报道 + 源权威加权 + 重大发布关键词 + 时效」综合打分
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const HTML_FILE = path.join(OUTPUT_DIR, 'index.html');
// GitHub Pages 需要根目录的 index.html，同时输出一份到根目录
const ROOT_HTML_FILE = path.join(__dirname, '..', 'index.html');

const TOP_N = 10;

// ============ 工具函数 ============
function fetchText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { ...options, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(new URL(res.headers.location, url).href, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    // 思否等站点响应稳定在 15s 左右，超时留足余量
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout: ' + url)); });
    req.end();
  });
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function cleanTitle(str) {
  return decodeEntities(stripCdata(str))
    .replace(/:[a-z][a-z0-9_+-]{1,}:/gi, '')  // 掘金等站点用的 :fire: 短代码
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 部分源（如 36氪）的 <link> 用 CDATA 包裹，需去掉包裹并还原实体，否则链接不可用
function cleanUrl(str) {
  return decodeEntities(stripCdata(str)).trim();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============ 新闻源采集 ============
// RSS/Atom/RDF 通用解析
function parseRSS(xml) {
  const items = [];

  // RSS 2.0 (<item>)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    if (title && link) {
      items.push({
        title: cleanTitle(title),
        url: cleanUrl(link),
        date: pubDate ? safeDate(pubDate) : '',
      });
    }
  }

  // Atom (<entry>)
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const pubDate = (block.match(/<published[^>]*>([\s\S]*?)<\/published>/) || [])[1] || (block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '';
      if (title && link) {
        items.push({
          title: cleanTitle(title),
          url: cleanUrl(link),
          date: pubDate ? safeDate(pubDate) : '',
        });
      }
    }
  }

  // RDF/RSS 1.0
  if (items.length === 0) {
    const rdfRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    while ((m = rdfRegex.exec(xml)) !== null) {
      const block = m[1];
      const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
      let link = (block.match(/<link[^>]*rdf:resource="([^"]+)"/) || [])[1] || '';
      if (!link) link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      if (title && link) {
        items.push({
          title: cleanTitle(title),
          url: cleanUrl(link),
          date: (block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/) || [])[1] ? safeDate((block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/) || [])[1]) : '',
        });
      }
    }
  }

  return items.filter(i => i.title && i.url);
}

function stripCdata(str) {
  return String(str).replace(/<!\[CDATA\[|\]\]>/g, '');
}

function safeDate(str) {
  const d = new Date(stripCdata(str).trim().replace(/^\s+|\s+$/g, ''));
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// AI 相关关键词过滤
const NEWS_KEYWORDS = /(?:^|[^A-Za-z])AI(?:[^A-Za-z]|$)|大模型|人工智能|机器学习|深度学习|智能体|AIGC|AGI|LLM|GPT|OpenAI|Anthropic|DeepSeek|Claude|Gemini|Qwen|通义|文心|豆包|智谱|Kimi|MiniMax|月之暗面|阶跃|百川|ChatGPT|Copilot|Midjourney|Stable Diffusion|扩散模型|多模态|具身智能|机器人|算力|神经网络|强化学习/i;
const DOC_KEYWORDS = new RegExp(NEWS_KEYWORDS.source + '|Agent|RAG|LangChain|向量数据库|微调|蒸馏|量化|推理加速|分布式训练|PyTorch|vLLM|Prompt|数字人|搜索推荐|评测|架构', 'i');

// 国内中文源（weight = 源权威度，AI 垂直源优先）
const NEWS_SOURCES = [
  { url: 'https://www.qbitai.com/feed', name: '量子位', weight: 20 },
  { url: 'https://www.leiphone.com/feed', name: '雷锋网', weight: 18 },
  { url: 'https://www.infoq.cn/feed', name: 'InfoQ', weight: 14 },
  { url: 'https://www.ithome.com/rss/', name: 'IT之家', weight: 12 },
  { url: 'https://www.36kr.com/feed', name: '36氪', weight: 12 },
  { url: 'https://www.ifanr.com/feed', name: '爱范儿', weight: 10 },
  { url: 'https://www.tmtpost.com/feed', name: '钛媒体', weight: 10 },
];

// 中文技术团队博客 / 技术社区（技术文档模块）
const DOC_SOURCES = [
  { url: 'https://tech.meituan.com/feed', name: '美团技术团队', weight: 20 },
  { url: 'https://segmentfault.com/feeds/blogs', name: '思否', weight: 16 },
  { url: 'https://www.infoq.cn/feed?type=article', name: 'InfoQ 文章', weight: 16 },
  { url: 'https://juejin.cn/rss', name: '掘金', weight: 14 },
];

// 早报/汇总类聚合帖不是单条新闻，直接剔除
const DIGEST_RE = /早报|日报|晚报|周报|月报|盘点|汇总|速览|一览|简报|周刊|要闻回顾|一周/;

async function fetchSources(sources, keywords, dropRe) {
  const all = [];
  await Promise.all(sources.map(async (src) => {
    // 思否等站点并发抓取时偶发超时，失败重试一次
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const xml = await fetchText(src.url);
        const items = parseRSS(xml)
          .filter(i => keywords.test(i.title))
          .filter(i => !dropRe || !dropRe.test(i.title));
        for (const it of items) all.push({ ...it, source: src.name, weight: src.weight });
        console.log(`  ✓ ${src.name}: ${items.length} 条`);
        return;
      } catch (e) {
        if (attempt === 2) console.log(`  ✗ ${src.name}: ${e.message}`);
      }
    }
  }));
  return all;
}

// ============ 热度打分 ============
const BASE_SCORE = 50;      // 基准分
const CROSS_BONUS = 30;     // 每多一个源报道同一事件
const SIGNAL_BONUS = 20;    // 要闻看重大发布/融资，技术文档看技术含量
const FRESH_BONUS = 10;     // 时效加分：越新越高（思否等源会混入多年前的推荐文章）

const RELEASE_RE = /发布|推出|开源|上线|首发|官宣|融资|亮相|正式|登顶|夺冠|重磅|获批|量产|接入|首款|首次|破纪录/;
const TECH_RE = /实践|原理|解析|架构|源码|优化|指南|入门|深入|实现|教程|详解|复盘|白皮书|评测|设计|方案|避坑|性能|调优|总结|踩坑|迁移|重构|源码分析/;

// 标题拆成连续 2 字组（中文按字、英文按词），用于判断两条标题是否在讲同一件事
function bigrams(str) {
  const s = String(str).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

// 同一事件在不同源里的标题措辞差异很大（实测 Jaccard 仅 0.1~0.3），
// 改用「重合字数占较短标题的比例」判定：短标题基本被长标题覆盖即视为同一事件
function isSameEvent(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (A.size < 5 || B.size < 5) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter >= 3 && inter / Math.min(A.size, B.size) >= 0.33;
}

// 完全同标题只留权威源那条，避免同源重复占位
function dedupeExact(items) {
  const best = new Map();
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    const prev = best.get(key);
    if (!prev || it.weight > prev.weight) best.set(key, it);
  }
  return [...best.values()];
}

// 同一来源在单个榜单里的最大占位数，防止被单一源刷屏
const MAX_PER_SOURCE = 3;

// 时效加分：当天/昨天最高，一个月内次之，更早的不加分
function freshness(date, today) {
  if (!date) return 0;
  const days = (Date.parse(today) - Date.parse(date)) / 86400000;
  if (days <= 1) return FRESH_BONUS;
  return days <= 30 ? 5 : 0;
}

function rankTop(items, n, bonusRe) {
  const today = new Date().toISOString().slice(0, 10);
  const groups = [];
  for (const it of dedupeExact(items)) {
    const g = groups.find(g => isSameEvent(g.title, it.title));
    if (g) g.items.push(it);
    else groups.push({ title: it.title, items: [it] });
  }

  const ranked = groups.map((g) => {
    // 同一事件取权威源最高的那条作为展示条目
    const best = g.items.slice().sort((a, b) => b.weight - a.weight)[0];
    const sources = [...new Set(g.items.map(i => i.source))];
    const score = BASE_SCORE
      + best.weight
      + (sources.length - 1) * CROSS_BONUS
      + (bonusRe.test(best.title) ? SIGNAL_BONUS : 0)
      + freshness(best.date, today);
    return { ...best, sources, score };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  const used = new Map();
  for (const it of ranked) {
    const c = used.get(it.source) || 0;
    if (c >= MAX_PER_SOURCE) continue;
    used.set(it.source, c + 1);
    picked.push(it);
    if (picked.length === n) return picked;
  }
  // 候选不够时放宽来源限制补足
  for (const it of ranked) {
    if (picked.includes(it)) continue;
    picked.push(it);
    if (picked.length === n) break;
  }
  return picked;
}

// ============ 生成 HTML（要闻 + 技术文档 双模块） ============
// 模块切换用纯 CSS（隐藏 radio + :checked 兄弟选择器），页面无需 JS
function renderList(items) {
  return items.map((item, i) => `
        <li>
          <div class="rk ${i < 3 ? 'top' : ''}">${i + 1}</div>
          <div class="main">
            <a class="ttl" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
            <div class="meta">
              <span class="src">${escapeHtml(item.source || '综合')}</span>
              ${item.sources && item.sources.length > 1 ? `<span class="cross">🔁 ${item.sources.length} 源报道</span>` : ''}
              <span class="heat">🔥 ${item.score}</span>
              ${item.date ? `<span class="date">${item.date}</span>` : ''}
            </div>
          </div>
        </li>`).join('');
}

// 主题变量集中在此，改配色/圆角只需动这一块
const THEME_VARS = `
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --bg: linear-gradient(180deg, #effcf9 0, #f2fbfd 45%, #f6f5ff 100%);
    --text: #0f172a;
    --hero-bg: linear-gradient(135deg, #5eead4, #7dd3fc 52%, #c4b5fd);
    --hero-color: #0f3b3a;
    --hero-shadow: 0 12px 26px rgba(45, 212, 191, .22);
    --tabbar-bg: rgba(255, 255, 255, .85);
    --tabbar-shadow: 0 6px 16px rgba(13, 148, 136, .12);
    --tab-idle: #5b7c7a;
    --tab-idle-count: #94a3b8;
    --tab-hover: #0f766e;
    --accent: linear-gradient(135deg, #2dd4bf, #38bdf8);
    --accent-text: #064e4b;
    --card-bg: #fff;
    --card-border: 1px solid #e6f5f4;
    --card-radius: 18px;
    --card-shadow: 0 6px 16px rgba(13, 148, 136, .08);
    --card-shadow-hover: 0 12px 24px rgba(13, 148, 136, .16);
    --rk-color: #0f766e;
    --rk-bg: #ccfbf1;
    --title: #0f172a;
    --title-hover: #0d9488;
    --chip-bg: #ecfeff;
    --chip-color: #0e7490;
    --cross: #e11d48;
    --heat: #f59e0b;
    --date: #94a3b8;
    --foot: #94a3b8;`;

function generateHTML(news, docs, dateStr) {
  const srcCount = new Set([...news, ...docs].map((it) => it.source).filter(Boolean)).size;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>每日 AI 动态 · ${dateStr}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {${THEME_VARS}
    }
    body { font-family: var(--font); background: var(--bg); color: var(--text); padding-bottom: 30px; }
    .tabin { position: absolute; opacity: 0; pointer-events: none; }
    .panel { display: none; }
    #t1:checked ~ .wrap .p1 { display: block; }
    #t2:checked ~ .wrap .p2 { display: block; }
    .wrap { max-width: 680px; margin: 0 auto; }
    .topbar {
      margin: 0 12px; padding: 26px 18px 30px; border-radius: 0 0 26px 26px;
      background: var(--hero-bg); color: var(--hero-color); box-shadow: var(--hero-shadow);
    }
    .topbar h1 { font-size: 24px; font-weight: 700; letter-spacing: .5px; }
    .topbar .d { margin-top: 8px; font-size: 12.5px; opacity: .94; }
    .tabs {
      position: sticky; top: 0; z-index: 9; display: flex; gap: 6px;
      margin: -18px 12px 0; padding: 6px; border-radius: 16px;
      background: var(--tabbar-bg); backdrop-filter: blur(10px); box-shadow: var(--tabbar-shadow);
    }
    .tabs label {
      flex: 1; padding: 11px 8px; text-align: center; border-radius: 11px;
      font-size: 14px; font-weight: 700; color: var(--tab-idle); cursor: pointer; transition: .18s;
    }
    .tabs label b { margin-left: 4px; font-size: 11px; color: var(--tab-idle-count); }
    .tabs label:hover { color: var(--tab-hover); }
    #t1:checked ~ .wrap .tabs label[for=t1],
    #t2:checked ~ .wrap .tabs label[for=t2] { background: var(--accent); color: var(--accent-text); }
    #t1:checked ~ .wrap .tabs label[for=t1] b,
    #t2:checked ~ .wrap .tabs label[for=t2] b { color: var(--accent-text); opacity: .85; }
    .panel { padding: 16px 12px 0; }
    ul { list-style: none; display: flex; flex-direction: column; gap: 9px; }
    li {
      display: flex; gap: 13px; padding: 14px 15px; border-radius: var(--card-radius);
      background: var(--card-bg); border: var(--card-border); box-shadow: var(--card-shadow); transition: .18s;
    }
    li:hover { transform: translateY(-2px); box-shadow: var(--card-shadow-hover); }
    .rk {
      flex: 0 0 29px; height: 29px; border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 800; color: var(--rk-color); background: var(--rk-bg);
    }
    .rk.top { background: var(--accent); color: var(--accent-text); }
    .main { flex: 1; min-width: 0; }
    .ttl {
      display: block; font-size: 14.5px; font-weight: 600; line-height: 1.55;
      color: var(--title); text-decoration: none;
    }
    .ttl:hover { color: var(--title-hover); }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 7px; }
    .src { padding: 2px 8px; border-radius: 999px; background: var(--chip-bg); color: var(--chip-color); font-size: 11px; font-weight: 600; }
    .cross { font-size: 11px; font-weight: 600; color: var(--cross); }
    .heat { font-size: 11px; color: var(--heat); }
    .date { font-size: 11px; color: var(--date); }
    .ft { padding: 22px 0 4px; text-align: center; font-size: 11.5px; color: var(--foot); }
  </style>
</head>
<body>
  <input class="tabin" type="radio" name="tb" id="t1" checked>
  <input class="tabin" type="radio" name="tb" id="t2">
  <div class="wrap">
    <div class="topbar">
      <h1>☀️ 每日 AI 动态</h1>
      <div class="d">${dateStr} · 要闻 ${news.length} 条 · 技术文档 ${docs.length} 条 · ${srcCount} 个来源</div>
    </div>
    <div class="tabs">
      <label for="t1">📰 AI 要闻 <b>${news.length}</b></label>
      <label for="t2">📚 AI 技术文档 <b>${docs.length}</b></label>
    </div>
    <section class="panel p1"><ul>${renderList(news)}</ul></section>
    <section class="panel p2"><ul>${renderList(docs)}</ul></section>
    <div class="ft">由 OpenClaw 自动生成 · 每天早上 8:00 更新</div>
  </div>
</body>
</html>`;
}

// ============ 主流程 ============
async function main() {
  console.log('🚀 开始采集每日 AI 新闻...');

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('📡 采集国内 AI 新闻源...');
  const newsItems = await fetchSources(NEWS_SOURCES, NEWS_KEYWORDS, DIGEST_RE);
  console.log('📡 采集 AI 技术文档源...');
  const docItems = await fetchSources(DOC_SOURCES, DOC_KEYWORDS, DIGEST_RE);

  let news = rankTop(newsItems, TOP_N, RELEASE_RE);
  // 技术文档与要闻同源事件只展示一次，避免同一条内容在两个模块里重复出现
  const docs = rankTop(docItems.filter(d => !newsItems.some(n => isSameEvent(d.title, n.title))), TOP_N, TECH_RE);

  // 采集太少时用备用数据兜底，避免推空页面
  if (news.length < 5) {
    console.log('⚠️ 新闻采集数量不足，使用备用数据');
    const today = new Date().toISOString().slice(0, 10);
    news = rankTop([
      { title: '国产大模型密集发布，多模态与推理能力成竞争焦点', url: 'https://www.qbitai.com', source: 'AI快讯', weight: 10, date: today },
      { title: '多家厂商宣布开源新模型，中文能力进一步提升', url: 'https://www.jiqizhixin.com', source: 'AI快讯', weight: 10, date: today },
      { title: 'AI 智能体落地加速，办公与研发场景率先规模化', url: 'https://www.infoq.cn', source: 'AI快讯', weight: 10, date: today },
      { title: '算力基础设施持续扩容，国产芯片生态加速适配', url: 'https://www.ithome.com', source: 'AI快讯', weight: 10, date: today },
      { title: 'AI 应用层融资活跃，垂类场景受资本关注', url: 'https://www.36kr.com', source: 'AI快讯', weight: 10, date: today },
    ], TOP_N, RELEASE_RE);
  }

  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const html = generateHTML(news, docs, dateStr);
  fs.writeFileSync(HTML_FILE, html, 'utf8');
  // 同时输出到根目录（GitHub Pages 需要）
  fs.writeFileSync(ROOT_HTML_FILE, html, 'utf8');

  // 生成推送摘要（供 cron 直接读取发送）
  const summary = [
    `🤖 每日 AI 动态 · ${dateStr}`,
    '',
    `【AI 要闻 Top ${news.length}】`,
    ...news.map((it, i) => `${i + 1}. ${it.title}`),
    '',
    `【AI 技术文档 Top ${docs.length}】`,
    ...docs.map((it, i) => `${i + 1}. ${it.title}`),
    '',
    '📄 完整榜单（含链接）：https://yesuifeng688.github.io/ai-daily-news/',
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.txt'), summary, 'utf8');

  console.log(`✅ 已生成 ${HTML_FILE}`);
  console.log(`📄 今日要闻 ${news.length} 条 / 技术文档 ${docs.length} 条`);

  return { file: HTML_FILE, news, docs };
}

if (require.main === module) {
  main().catch(e => { console.error('❌ 错误:', e.message); process.exit(1); });
}

module.exports = { main };
