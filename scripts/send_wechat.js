#!/usr/bin/env node
/**
 * 直接发送每日AI新闻到微信（不依赖 agent）
 * 用法：node scripts/send_wechat.js
 * 读取 output/summary.txt 并通过 openclaw CLI 发送到用户微信
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SUMMARY = path.join(__dirname, '..', 'output', 'summary.txt');
const WECHAT_TARGET = 'o9cq80xSaJH4DSN0AwCgQLchIR-4@im.wechat';
const ACCOUNT_ID = '2f550c2f433d-im-bot';

function main() {
  if (!fs.existsSync(SUMMARY)) {
    console.error('❌ summary.txt 不存在，先运行 run_all.js');
    process.exit(1);
  }

  const content = fs.readFileSync(SUMMARY, 'utf8');
  console.log('📄 读取摘要内容，长度:', content.length, '字符');

  // 用 openclaw CLI 发送（避免 agent 的 target 解析问题）
  const cmd = `openclaw message send --channel openclaw-weixin --target "${WECHAT_TARGET}" --account "${ACCOUNT_ID}" --message "${content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" --json`;

  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
    console.log('✅ 发送成功');
    console.log(out);
  } catch (e) {
    console.error('❌ 发送失败:', e.message);
    if (e.stdout) console.log('stdout:', e.stdout);
    if (e.stderr) console.log('stderr:', e.stderr);
    process.exit(1);
  }
}

main();
