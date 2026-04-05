#!/usr/bin/env node
/**
 * List Zalo groups (groupId + name) for picking ZALO_GROUP_ID / SSM zalo-group-id.
 *
 * Setup:
 *   npm install --prefix scripts/zalo
 *   cp config/zalo-cookies.example.json config/zalo-cookies.local.json
 *   # paste Chrome export JSON into zalo-cookies.local.json
 *
 * Run:
 *   ZALO_IMEI='...' ZALO_USER_AGENT='...' node scripts/zalo/list-groups.mjs
 *
 * Or use config/zalo-credentials.local.json:
 *   { "imei": "...", "userAgent": "...", "cookies": { "url": "https://chat.zalo.me", "cookies": [ ... ] } }
 */

import { Zalo } from 'zca-js';
import { loadZaloCredentials } from './zaloCredentials.mjs';

const { imei, userAgent, cookie, language } = loadZaloCredentials();
const zalo = new Zalo();
const api = await zalo.login({ imei, cookie, userAgent, language });

const all = await api.getAllGroups();
const ids = Object.keys(all.gridVerMap || {});
if (ids.length === 0) {
  console.log('No groups returned.');
  process.exit(0);
}

const info = await api.getGroupInfo(ids);
const map = info.gridInfoMap || {};
for (const id of ids) {
  const g = map[id];
  const name = g?.name ?? '(unknown name)';
  console.log(`${id}\t${name}`);
}
