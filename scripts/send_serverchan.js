#!/usr/bin/env node
/**
 * 通过 Server酱³ 推送每日AI新闻（无需会话，长期有效）
 * 用法：node scripts/send_serverchan.js
 * SendKey 从 .env 的 SERVERCHAN_SENDKEY 读取（.env 已被 .gitignore 忽略，不会推送）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUMMARY = path.join(ROOT, 'output', 'summary.txt');
const ENV_FILE = path.join(ROOT, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main() {
  const env = loadEnv();
  const key = process.env.SERVERCHAN_SENDKEY || env.SERVERCHAN_SENDKEY;
  if (!key) {
    console.error('❌ 未找到 SERVERCHAN_SENDKEY（检查 .env 或环境变量）');
    process.exit(1);
  }
  if (!fs.existsSync(SUMMARY)) {
    console.error('❌ summary.txt 不存在，先运行 run_all.js');
    process.exit(1);
  }

  const raw = fs.readFileSync(SUMMARY, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  const title = (lines[0] || '每日 AI 动态').replace(/^🤖\s*/, '').trim().slice(0, 32);
  const desp = lines.slice(1).join('\n').trim();

  console.log('📄 标题:', title);
  console.log('📄 内容长度:', desp.length, '字符');

  const url = `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
  const body = new URLSearchParams({ title, desp });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  if (!j) throw new Error(`响应非 JSON: ${text.slice(0, 200)}`);
  const ok = j.code === 0 && (!j.data || j.data.errno === 0 || j.data.error === 'SUCCESS');
  if (!ok) {
    throw new Error(`Server酱推送失败: code=${j.code}, message=${j.message || ''}, data=${JSON.stringify(j.data || {})}`);
  }
  console.log('✅ 推送成功! 响应:', text.slice(0, 200));
}

main().catch(e => {
  console.error('❌ 发送失败:', e.message);
  process.exit(1);
});
