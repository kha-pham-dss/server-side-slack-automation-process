/**
 * Read non-empty lines from a sheet column range and send as one Zalo group message.
 */

import { google } from 'googleapis';
import { Zalo, ThreadType } from 'zca-js';

function getSheetsClient(credentialsJson) {
  const cred = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/** Tab "Tháng M / YYYY" theo GMT+7 (giống collect-orders). */
export function getDishesSheetNameForCurrentMonth() {
  const gmt7 = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const month = gmt7.getUTCMonth() + 1;
  const year = gmt7.getUTCFullYear();
  return `Tháng ${month} / ${year}`;
}

/**
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {string} a1Range e.g. M58:M72
 * @returns {string[]} non-empty trimmed lines in row order
 */
export async function fetchNonEmptyLinesFromRange(sheets, spreadsheetId, sheetName, a1Range) {
  const quoted = /[\s']/.test(sheetName) ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  const range = `${quoted}!${a1Range}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'ROWS',
  });
  const rows = res.data.values || [];
  /** @type {string[]} */
  const lines = [];
  for (const row of rows) {
    const cell = row?.[0];
    const s = cell != null ? String(cell).trim() : '';
    if (s) lines.push(s);
  }
  return lines;
}

/** Tìm số suất trong dòng kiểu "Tổng 8 suất anh nhé" / "tổng 0 suất" (không phân biệt hoa thường). */
export function parseTotalServings(lines) {
  const re = /Tổng\s*(\d+)\s*suất/i;
  let last = null;
  for (const line of lines) {
    const m = line.match(re);
    if (m) last = parseInt(m[1], 10);
  }
  return last;
}

/**
 * @param {Record<string, string>} config keys like collect-orders SSM map (kebab-case)
 * @returns {Promise<{ ok?: true; skipped?: true; reason?: string }>}
 */
export async function runFromConfig(config) {
  const groupId = (config['zalo-group-id'] || '').trim();
  const cookiesRaw = (config['zalo-cookies-json'] || '').trim();
  const imei = (config['zalo-imei'] || '').trim();
  const userAgent = (config['zalo-user-agent'] || '').trim();

  if (!groupId || !cookiesRaw || !imei || !userAgent) {
    console.warn('Zalo sheet summary: missing zalo-group-id, zalo-cookies-json, zalo-imei, or zalo-user-agent');
    return { skipped: true, reason: 'incomplete_zalo_or_sheet_config' };
  }

  const sheetId = (config['sheet-id'] || config['sheet_id'] || '').trim();
  const credentials = (config['sheet-credentials'] || config['sheet_credentials'] || '').trim();
  if (!sheetId || !credentials) {
    const hint = Object.keys(config)
      .filter((k) => k.toLowerCase().includes('sheet'))
      .sort()
      .join(', ');
    console.warn(
      'Zalo sheet summary: missing sheet-id or sheet-credentials (SSM names must be kebab-case). Keys containing "sheet":',
      hint || '(none)'
    );
    return { skipped: true, reason: 'missing_sheet_config' };
  }

  const sheetName = (config['dishes-sheet-name'] || '').trim() || getDishesSheetNameForCurrentMonth();
  const cellRange = (config['zalo-summary-range'] || 'M58:M72').trim();

  const sheets = getSheetsClient(credentials);
  const lines = await fetchNonEmptyLinesFromRange(sheets, sheetId, sheetName, cellRange);
  const body = lines.join('\n').trim();
  const totalServings = parseTotalServings(lines);
  const noOrdersMsg = 'Nay bọn em không đặt gì anh nhé';

  let msg;
  let noOrders = false;
  if (totalServings === 0) {
    msg = noOrdersMsg;
    noOrders = true;
    console.log('Zalo sheet summary: Tổng 0 suất — sending no-order message');
  } else if (body) {
    msg = body;
  } else {
    console.warn('Zalo sheet summary: no text in', cellRange, 'and no Tổng … suất line');
    return { skipped: true, reason: 'empty_range' };
  }

  let cookie;
  try {
    cookie = JSON.parse(cookiesRaw);
  } catch {
    console.warn('Zalo sheet summary: zalo-cookies-json is not valid JSON');
    return { skipped: true, reason: 'invalid_cookies_json' };
  }

  const zalo = new Zalo();
  const api = await zalo.login({
    imei,
    cookie,
    userAgent,
    language: (config['zalo-language'] || 'vi').trim() || 'vi',
  });

  await api.sendMessage({ msg }, groupId, ThreadType.Group);
  console.log(
    'Zalo sheet summary: sent to group',
    groupId,
    noOrders ? '(Tổng 0 suất)' : `${lines.length} lines`
  );
  return { ok: true, line_count: lines.length, no_orders: noOrders, total_servings: totalServings };
}
