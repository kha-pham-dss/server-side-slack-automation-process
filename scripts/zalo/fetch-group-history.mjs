#!/usr/bin/env node
/**
 * Test Zalo getGroupChatHistory (same API as zalo-menu-images Lambda).
 *
 *   npm install --prefix scripts/zalo
 *   node scripts/zalo/fetch-group-history.mjs [groupId]
 */

import { Zalo } from 'zca-js';
import { loadZaloCredentials } from './zaloCredentials.mjs';

const groupId = process.argv[2] || process.env.ZALO_GROUP_ID?.trim();
if (!groupId) {
  console.error('Usage: node scripts/zalo/fetch-group-history.mjs <groupId>');
  process.exit(1);
}

const count = Number.parseInt(process.env.ZALO_HISTORY_COUNT || '50', 10) || 50;

const { imei, userAgent, cookie, language } = loadZaloCredentials();
const zalo = new Zalo();
const api = await zalo.login({ imei, cookie, userAgent, language });

console.log('Login OK, fetching group', groupId);

const info = await api.getGroupInfo(groupId);
const name = info?.gridInfoMap?.[groupId]?.name;
if (!name) {
  console.error('Group not in gridInfoMap — wrong id or not a member:', groupId);
  process.exit(1);
}
console.log('Group:', groupId, name);

const history = await api.getGroupChatHistory(groupId, count);
const msgs = history?.groupMsgs || [];
console.log('groupMsgs:', msgs.length);
if (msgs.length) {
  const last = msgs[msgs.length - 1];
  const d = last.data ?? last;
  console.log('Latest msg:', {
    msgId: d.msgId,
    uidFrom: d.uidFrom,
    msgType: d.msgType,
    ts: d.ts,
  });
}
