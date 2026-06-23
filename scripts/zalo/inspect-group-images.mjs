#!/usr/bin/env node
/**
 * Inspect recent Zalo group messages — find kitchen user id and photo message shape.
 *
 *   npm install --prefix scripts/zalo
 *   node scripts/zalo/inspect-group-images.mjs [groupId]
 *
 * Prints uidFrom, msgType, content keys, and extracted image URL for each message.
 * Use output to set SSM zalo-menu-source-user-id.
 */

import { Zalo } from 'zca-js';
import { loadZaloCredentials } from './zaloCredentials.mjs';
import {
  extractZaloImageUrl,
  zaloMessageKey,
  zaloMessageSenderId,
  ZALO_PHOTO_MSG_TYPES,
} from '../../serverless/shared/zalo-message.js';

const groupId = process.argv[2] || process.env.ZALO_GROUP_ID?.trim();
if (!groupId) {
  console.error('Usage: node scripts/zalo/inspect-group-images.mjs <groupId>');
  console.error('Or set ZALO_GROUP_ID');
  process.exit(1);
}

const count = Number.parseInt(process.env.ZALO_HISTORY_COUNT || '30', 10) || 30;

const { imei, userAgent, cookie, language } = loadZaloCredentials();
const zalo = new Zalo();
const api = await zalo.login({ imei, cookie, userAgent, language });

const history = await api.getGroupChatHistory(groupId, count);
const msgs = history?.groupMsgs || [];

console.log(`Group ${groupId}: ${msgs.length} messages (newest last in API order — showing all)\n`);

for (const msg of msgs) {
  const data = msg.data ?? msg;
  const key = zaloMessageKey(msg);
  const from = zaloMessageSenderId(msg);
  const name = data.dName || '(no name)';
  const msgType = data.msgType || '?';
  const isPhoto = ZALO_PHOTO_MSG_TYPES.has(msgType);
  const imageUrl = extractZaloImageUrl(msg);

  let contentPreview = '';
  if (typeof data.content === 'string') {
    contentPreview = data.content.slice(0, 80);
  } else if (data.content && typeof data.content === 'object') {
    contentPreview = `{keys: ${Object.keys(data.content).join(', ')}}`;
  }

  console.log('---');
  console.log('msgId:', key, '| from:', from, `(${name})`, '| msgType:', msgType);
  console.log('ts:', data.ts, '| content:', contentPreview);
  if (isPhoto) {
    console.log('imageUrl:', imageUrl || '(extract failed — inspect content below)');
    if (data.content && typeof data.content === 'object') {
      console.log('content sample:', JSON.stringify(data.content, null, 2).slice(0, 500));
    }
  }
}

console.log('\nSet SSM zalo-menu-source-user-id to the kitchen account uidFrom (e.g. from photo rows above).');
