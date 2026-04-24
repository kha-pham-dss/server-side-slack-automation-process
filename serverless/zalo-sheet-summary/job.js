/**
 * Read non-empty lines from a sheet column range and send as one Zalo group message.
 * Before Zalo send: reactions.get on today's menu (DynamoDB + bot-token), compare counts to sheet text.
 * If TABLE_NAME is set and there is no menu row for today (e.g. post-menu skipped on "Bỏ qua hôm nay"),
 * skips sheet read and Zalo send entirely.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { google } from 'googleapis';
import { Zalo, ThreadType } from 'zca-js';

const DIGIT_EMOJI = ['one', 'two', 'three', 'four', 'five', 'six'];

/** @mention trong reply thread menu khi đối chiếu lệch. Ghi đè: RECONCILE_NOTIFY_SLACK_USER_ID. */
const RECONCILE_NOTIFY_SLACK_USER_ID = 'U02SJRNAM2M';

const dynamo = new DynamoDBClient();

/** Cùng khóa ngày với post-menu / collect-orders (UTC YYYY-MM-DD). */
function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getTodayMenuRow(tableName) {
  if (!tableName) return null;
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { date: { S: dateKey() } },
    })
  );
  if (!res.Item) return null;
  return unmarshall(res.Item);
}

async function getSlackBotUserId(botToken) {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) return null;
  return data.user_id ?? null;
}

/**
 * Tổng reaction món: :one:..:six: (mỗi user đếm 1), không bot, không :up:.
 * Tổng :up: (không bot) — so với số suất 40k trên sheet.
 */
async function slackDishAndUpCounts(botToken, channelId, messageTs) {
  const url = new URL('https://slack.com/api/reactions.get');
  url.searchParams.set('channel', channelId);
  url.searchParams.set('timestamp', messageTs);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack reactions.get: ${data.error ?? res.status}`);

  const botUserId = await getSlackBotUserId(botToken);
  const excludeBot = (ids) => (botUserId ? ids.filter((id) => id !== botUserId) : ids);

  let dishReactions = 0;
  let upReactions = 0;
  for (const r of data.message?.reactions ?? []) {
    const name = r.name;
    if (typeof name !== 'string') continue;
    const users = excludeBot(r.users ?? []);
    if (name === 'up') {
      upReactions += users.length;
      continue;
    }
    if (DIGIT_EMOJI.includes(name)) dishReactions += users.length;
  }
  return { dishReactions, upReactions };
}

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
 * Cộng mọi cụm "x 40k" (có khoảng trắng giữa số và 40k): `2 40k`, `10 40k`, `11 40k`, `(1 40k)`.
 * `x` là một hoặc nhiều chữ số (`\d+`). Không khớp "140k" (không có khoảng trước 40k).
 */
export function parseFortyKPortionsFromText(text) {
  if (!text || typeof text !== 'string') return 0;
  const re = /(?<![0-9])(\d+)\s+40k\b/gi;
  let sum = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    sum += parseInt(m[1], 10);
  }
  return sum;
}

/** Reply dưới tin menu hôm đó (thread). Cần chat:write. */
async function postSlackThreadReply(botToken, channelId, threadTs, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: channelId,
      thread_ts: threadTs,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.postMessage: ${data.error ?? res.status}`);
}

/**
 * @param {Record<string, unknown>} reconcile output of reconcileSlackVsSheet (có slack_menu)
 */
async function notifyReconcileMismatchOnSlack(botToken, reconcile) {
  const menu = reconcile.slack_menu;
  if (!menu?.channel_id || !menu?.message_ts) return;

  const uid = (process.env.RECONCILE_NOTIFY_SLACK_USER_ID || RECONCILE_NOTIFY_SLACK_USER_ID).trim();
  const mention = uid ? `<@${uid}> ` : '';

  const text = [
    `${mention} Có chênh lệch giữa reactions và số món ghi nhận.`,
    `Slack: suất (emoji) ${reconcile.slack_dish_reactions}, :up: ${reconcile.slack_up_reactions}.`,
    `Sheet: Tổng ${reconcile.sheet_total_servings ?? '—'}, 40k ${reconcile.sheet_40k_portions}.`,
  ].join(' ');

  try {
    await postSlackThreadReply(botToken, menu.channel_id, menu.message_ts, text);
    console.log('Zalo reconcile: posted Slack thread reply under menu', menu.message_ts);
  } catch (e) {
    console.warn('Zalo reconcile: Slack thread reply failed', e?.message || e);
  }
}

/**
 * So khớp Slack vs sheet trước khi gửi Zalo.
 * @returns {Promise<Record<string, unknown>>}
 */
async function reconcileSlackVsSheet(config, lines, bodyForParse) {
  const tableName = (process.env.TABLE_NAME || '').trim();
  const botToken = (config['bot-token'] || '').trim();
  if (!tableName) {
    return { skipped: true, reason: 'no_table_name' };
  }
  if (!botToken) {
    return { skipped: true, reason: 'no_bot_token' };
  }

  let menu;
  try {
    menu = await getTodayMenuRow(tableName);
  } catch (e) {
    console.warn('Zalo reconcile: DynamoDB read failed', e?.message || e);
    return { skipped: true, reason: 'dynamo_error', error: String(e?.message || e) };
  }
  if (!menu?.channel_id || !menu?.message_ts) {
    return { skipped: true, reason: 'no_menu_row' };
  }

  let slackDish;
  let slackUp;
  try {
    const c = await slackDishAndUpCounts(botToken, menu.channel_id, menu.message_ts);
    slackDish = c.dishReactions;
    slackUp = c.upReactions;
  } catch (e) {
    console.warn('Zalo reconcile: Slack reactions.get failed', e?.message || e);
    return { skipped: true, reason: 'slack_reactions_error', error: String(e?.message || e) };
  }

  const sheetTotal = parseTotalServings(lines);
  const sheet40k = parseFortyKPortionsFromText(bodyForParse || '');

  const comparedTotal = sheetTotal != null;
  const totalMatch = !comparedTotal || slackDish === sheetTotal;
  const upMatch = slackUp === sheet40k;

  const out = {
    skipped: false,
    slack_dish_reactions: slackDish,
    slack_up_reactions: slackUp,
    sheet_total_servings: sheetTotal,
    sheet_40k_portions: sheet40k,
    total_compared: comparedTotal,
    total_match: totalMatch,
    up_match: upMatch,
  };

  if (comparedTotal && !totalMatch) {
    console.warn(
      'Zalo reconcile: suất từ Slack (emoji món, không :up:)',
      slackDish,
      '≠ sheet Tổng … suất',
      sheetTotal
    );
  }
  if (!upMatch) {
    console.warn('Zalo reconcile: :up: Slack (trừ bot)', slackUp, '≠ suất 40k trên sheet', sheet40k);
  }

  out.notify_mismatch =
    (comparedTotal && !totalMatch) || !upMatch ? { total: comparedTotal && !totalMatch, up: !upMatch } : null;

  out.slack_menu = { channel_id: menu.channel_id, message_ts: menu.message_ts };

  return out;
}

/**
 * @param {Record<string, string>} config keys like collect-orders SSM map (kebab-case)
 * @returns {Promise<{ ok?: true; skipped?: true; reason?: string }>}
 */
export async function runFromConfig(config) {
  const tableName = (process.env.TABLE_NAME || '').trim();
  if (tableName) {
    try {
      const menu = await getTodayMenuRow(tableName);
      if (!menu) {
        console.log(
          'Zalo sheet summary: no menu row for today in DynamoDB; skip sheet + Zalo (e.g. Bỏ qua hôm nay)'
        );
        return { skipped: true, reason: 'no_menu_today' };
      }
    } catch (e) {
      console.warn('Zalo sheet summary: DynamoDB menu lookup failed; continuing', e?.message || e);
    }
  }

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

  const reconcile = await reconcileSlackVsSheet(config, lines, body);
  if (!reconcile.skipped) {
    console.log('Zalo reconcile:', JSON.stringify(reconcile));
  }
  if (!reconcile.skipped && reconcile.notify_mismatch && config['bot-token']?.trim()) {
    await notifyReconcileMismatchOnSlack(config['bot-token'].trim(), reconcile);
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
  return {
    ok: true,
    line_count: lines.length,
    no_orders: noOrders,
    total_servings: totalServings,
    slack_reconcile: reconcile,
  };
}
