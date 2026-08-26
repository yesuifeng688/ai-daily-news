#!/usr/bin/env node
/**
 * 直接发送每日AI新闻到微信（绕过 CLI，带 contextToken 确保送达）
 * 用法：node scripts/send_wechat.js
 * 从 openclaw-weixin 插件状态读取 contextToken，直接调用微信 ilink API
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUMMARY = path.join(__dirname, '..', 'output', 'summary.txt');
const ACCOUNT_ID = '2f550c2f433d-im-bot';
const USER_ID = 'o9cq80xSaJH4DSN0AwCgQLchIR-4@im.wechat';
const STATE_DIR = 'C:/Users/Administrator/.openclaw/openclaw-weixin';

function getAccount() {
  const f = path.join(STATE_DIR, 'accounts', `${ACCOUNT_ID}.json`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function getContextToken() {
  const f = path.join(STATE_DIR, 'accounts', `${ACCOUNT_ID}.context-tokens.json`);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return d[USER_ID];
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

async function sendText(baseUrl, token, to, text, contextToken) {
  const url = baseUrl.replace(/\/+$/, '') + '/ilink/bot/sendmessage';
  const clientId = 'openclaw-weixin:' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
    base_info: { channel_version: '1.0.3' },
  };

  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw}`);
  // 校验微信 ilink 业务码：ret=0 才代表真正发送成功（HTTP 200 可能携带业务失败）
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.ret === 'number' && j.ret !== 0) {
      throw new Error(`ilink 业务失败 ret=${j.ret}, errmsg=${j.errmsg || ''}`);
    }
  } catch (e) {
    if (e.message && e.message.startsWith('ilink')) throw e;
    // 非 JSON 响应则忽略，保持原行为
  }
  return raw;
}

async function main() {
  if (!fs.existsSync(SUMMARY)) {
    console.error('❌ summary.txt 不存在，先运行 run_all.js');
    process.exit(1);
  }
  const text = fs.readFileSync(SUMMARY, 'utf8');
  const acct = getAccount();
  const contextToken = getContextToken();

  console.log('📄 摘要长度:', text.length, '字符');
  console.log('🔑 contextToken:', contextToken ? '已获取 (len=' + contextToken.length + ')' : '缺失!');
  console.log('🔗 baseUrl:', acct.baseUrl);

  let resp;
  if (contextToken) {
    try {
      resp = await sendText(acct.baseUrl, acct.token, USER_ID, text, contextToken);
    } catch (e) {
      // contextToken 过期（prepare failed）时自动降级为无上下文发送，无需人工刷新 token
      if (e.message.includes('prepare failed')) {
        console.log('⚠️ contextToken 过期，自动降级为无上下文发送');
        resp = await sendText(acct.baseUrl, acct.token, USER_ID, text, undefined);
      } else {
        throw e;
      }
    }
  } else {
    console.log('⚠️ contextToken 缺失，使用无上下文发送');
    resp = await sendText(acct.baseUrl, acct.token, USER_ID, text, undefined);
  }
  console.log('✅ 发送成功! 响应:', resp.slice(0, 200));
}

main().catch(e => {
  console.error('❌ 发送失败:', e.message);
  process.exit(1);
});
