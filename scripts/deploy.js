#!/usr/bin/env node
/**
 * 自动推送网页到 GitHub Pages
 * 用法：node deploy.js
 * 前置：项目目录已是 git 仓库，且已配置 remote 指向 GitHub
 * 说明：运行 collect.js 生成网页后，自动 commit + push，GitHub Pages 自动更新
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'index.html');

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function main() {
  if (!fs.existsSync(OUTPUT)) {
    console.error('❌ 未找到 index.html，请先运行 node scripts/collect.js');
    process.exit(1);
  }

  console.log('🚀 开始部署到 GitHub Pages...');

  // 检查是否 git 仓库
  try {
    run('git rev-parse --is-inside-work-tree');
  } catch {
    console.error('❌ 不是 git 仓库，请先执行: git init');
    process.exit(1);
  }

  // 检查 remote
  try {
    run('git remote get-url origin');
  } catch {
    console.error('❌ 未配置远程仓库，请先执行: git remote add origin <你的GitHub仓库URL>');
    process.exit(1);
  }

  // 添加、提交、推送
  run('git add -A');
  run(`git commit -m "更新每日AI新闻: ${new Date().toLocaleDateString('zh-CN')}"`);
  run('git push origin main');
  
  console.log('✅ 部署完成！GitHub Pages 将自动更新');
  console.log('🌐 访问: https://<你的用户名>.github.io/<仓库名>/');
}

main();
