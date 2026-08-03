/**
 * EnsureMonthSheet — day 1 ~00:05 GMT+7 (EventBridge cron last-day 17:05 UTC).
 * Duplicates nearest prior `Tháng N / YYYY` tab and clears order/Zalo cells if current month missing.
 */

import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import { getSheetsClient } from '@slack-dishes/shared/sheets.js';
import { ensureCurrentMonthSheet } from '@slack-dishes/shared/ensure-month-sheet.js';
import { CACHE_TTL_MS } from '@slack-dishes/shared/time-constants.js';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  configCache = await loadConfigFromParameterStore();
  configCacheTime = Date.now();
  return configCache;
}

export async function handler(event) {
  console.log('EnsureMonthSheet invoked', JSON.stringify(event?.detail ?? event));

  const config = await getConfig();
  const sheetId = (config['sheet-id'] || '').trim();
  const credentials = (config['sheet-credentials'] || '').trim();
  if (!sheetId || !credentials) {
    throw new Error('Missing sheet-id or sheet-credentials in Parameter Store');
  }

  const sheets = getSheetsClient(credentials);
  const result = await ensureCurrentMonthSheet({ sheets, spreadsheetId: sheetId, config });
  console.log('EnsureMonthSheet result', result);
  return { ok: true, ...result };
}
