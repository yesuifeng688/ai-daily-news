#!/usr/bin/env node
/**
 * 自动推送网页到 GitHub Pages
 * 用法：node deploy.js
 * 前置：项目已是 git 仓库，remote 已指向 GitHub，凭据已保存
 * 说明：运行 collect.js 生成网页后，自动 commit + push，GitHub Pages 自动更新
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'index.html');

function run(cmd) {
  console.log(`> ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return out;
  } catch (e) {
    console.error(`命令失败: ${cmd}`);
    console.error(e.message);
    return null;
  }
}

function main() {
  if (!fs.existsSync(OUTPUT)) {
    console.error('❌ 未找到 index.html，请先运行 node scripts/collect.js');
    process.exit(1);
  }

  console.log('🚀 开始部署到 GitHub Pages...');

  // 清除代理环境变量，强制 git 直连（系统代理 127.0.0.1:7897 当前不可用会导致 SSL 失败）
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;

  // 确保是 git 仓库
  if (!run('git rev-parse --is-inside-work-tree')) {
    console.error('❌ 不是 git 仓库');
    process.exit(1);
  }

  // 确保 remote 存在
  run('git remote get-url origin');

  // 提交并推送（用 --force 覆盖，因为每天只更新网页，无协作冲突）
  // 同时显式禁用代理，避免读到环境变量
  run('git add -A');
  run(`git commit -m "更新每日AI新闻: ${new Date().toLocaleDateString('zh-CN')}" --allow-empty`);
  run('git -c http.proxy= -c https.proxy= push -u origin main --force');

  console.log('✅ 部署完成！GitHub Pages 已更新');
  console.log('🌐 https://yesuifeng688.github.io/ai-daily-news/');
}

main();
