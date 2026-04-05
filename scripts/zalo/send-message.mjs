#!/usr/bin/env node
/**
 * Send a plain text message to a Zalo group.
 *
 *   npm install --prefix scripts/zalo
 *   node scripts/zalo/send-message.mjs <groupId> "message text"
 *
 * Credentials: config/zalo-credentials.local.json (see list-groups.mjs).
 */

import { Zalo, ThreadType } from 'zca-js';
import { loadZaloCredentials } from './zaloCredentials.mjs';

const groupId = process.argv[2];
const msg = process.argv[3];
if (!groupId || !msg) {
  console.error('Usage: node scripts/zalo/send-message.mjs <groupId> "message"');
  process.exit(1);
}

const { imei, userAgent, cookie, language } = loadZaloCredentials();
const zalo = new Zalo();
const api = await zalo.login({ imei, cookie, userAgent, language });
await api.sendMessage({ msg }, groupId, ThreadType.Group);
console.log('Sent OK to group', groupId);
