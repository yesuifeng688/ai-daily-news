#!/usr/bin/env node
/**
 * 一键执行：采集 + 部署
 * 用法：node scripts/run_all.js
 * 依次运行 collect.js 和 deploy.js，然后打印 summary.txt 供 cron 读取发送
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SUMMARY = path.join(ROOT, 'output', 'summary.txt');

function run(cmd) {
  console.log(`\n>>> ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return out;
  } catch (e) {
    console.error(`命令失败: ${cmd}`);
    console.error(e.message);
    process.exit(1);
  }
}

// 1. 采集 + 翻译 + 生成网页和摘要
run('node scripts/collect.js');

// 2. 部署到 GitHub Pages
run('node scripts/deploy.js');

// 3. 输出摘要内容（供 cron 读取）
if (fs.existsSync(SUMMARY)) {
  console.log('\n=====SUMMARY_START=====');
  console.log(fs.readFileSync(SUMMARY, 'utf8'));
  console.log('=====SUMMARY_END=====');
} else {
  console.error('❌ summary.txt 不存在');
  process.exit(1);
}
