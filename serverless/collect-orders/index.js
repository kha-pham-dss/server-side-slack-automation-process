/**
 * CollectOrders Lambda (10:20 UTC).
 * Reads today's menu message from DynamoDB, calls Slack reactions.get, resolves user_id → user name
 * via Slack users.list, then writes each user's order into the Google Sheet (user rows).
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { google } from 'googleapis';

const ssm = new SSMClient();
const dynamo = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME;
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function loadAllParametersByPath() {
  const pathPrefix = PARAMETER_PREFIX.endsWith('/') ? PARAMETER_PREFIX.slice(0, -1) : PARAMETER_PREFIX;
  const namePrefix = `${pathPrefix}/`;
  const map = {};
  let nextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: pathPrefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
        MaxResults: 10,
      })
    );
    for (const p of res.Parameters || []) {
      const name = p.Name?.replace(namePrefix, '') || '';
      if (name && p.Value != null && p.Value !== '') map[name] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return map;
}

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  configCache = await loadAllParametersByPath();
  configCacheTime = Date.now();
  return configCache;
}

function dateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

/** Sheet tab name: "Tháng {month} / {year}" (e.g. Tháng 2 / 2026). Uses GMT+7. */
function getDishesSheetNameForCurrentMonth() {
  const gmt7 = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const month = gmt7.getUTCMonth() + 1;
  const year = gmt7.getUTCFullYear();
  return `Tháng ${month} / ${year}`;
}

async function getTodayMenuMessage() {
  const date = dateKey();
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { date: { S: date } },
    })
  );
  if (!res.Item) return null;
  return unmarshall(res.Item);
}

const DIGIT_EMOJI = ['one', 'two', 'three', 'four', 'five', 'six'];
const UP_EMOJI = 'up';

/** Lấy bot user ID (để bỏ qua reaction của chính bot). */
async function getBotUserId(botToken) {
  const res = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) return null;
  return data.user_id ?? null;
}

/**
 * Slack API reactions.get → orders (:one:..:six:) + set user_ids react :up:.
 * Bỏ qua reaction của bot. Returns { orders, upUserIds }.
 */
async function getReactions(botToken, channelId, messageTs) {
  const url = new URL('https://slack.com/api/reactions.get');
  url.searchParams.set('channel', channelId);
  url.searchParams.set('timestamp', messageTs);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack reactions.get error: ${data.error ?? res.status}`);

  const botUserId = await getBotUserId(botToken);
  const excludeBot = (ids) => (botUserId ? ids.filter((id) => id !== botUserId) : ids);

  const message = data.message;
  const reactions = message?.reactions ?? [];
  /** @type {Array<{ emoji: string; dish_index: number; user_ids: string[] }>} */
  const orders = [];
  /** @type {Set<string>} */
  const upUserIds = new Set();
  for (const r of reactions) {
    const name = r.name;
    if (typeof name !== 'string') continue;
    const users = excludeBot(r.users ?? []);
    if (name === UP_EMOJI) {
      users.forEach((id) => upUserIds.add(id));
      continue;
    }
    const idx = DIGIT_EMOJI.indexOf(name);
    if (idx < 0) continue;
    orders.push({ emoji: name, dish_index: idx, user_ids: users });
  }
  return { orders, upUserIds };
}

/**
 * Resolve Slack user IDs to display names. Uses users.list (one call).
 * Requires bot scope: users:read
 * @returns {Promise<Record<string, string>>} userId -> real_name (or display_name)
 */
async function resolveUserIdsToNames(botToken) {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack users.list error: ${data.error ?? res.status}`);

  const map = {};
  for (const m of data.members ?? []) {
    if (!m.id || m.is_bot) continue;
    const name = m.real_name?.trim() || m.profile?.display_name?.trim() || m.name || m.id;
    map[m.id] = name;
  }
  return map;
}

function getSheetsClient(credentialsJson) {
  const cred = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Read dishes from sheet (same config as PostMenu). Returns [ { id: "0", name: "Dish A" }, ... ].
 */
async function fetchDishesFromSheet(sheets, spreadsheetId, sheetName, rangeSpec) {
  const quoted = /[\s']/.test(sheetName) ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  const range = `${quoted}!${rangeSpec}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = res.data.values || [];
  const dishes = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row?.[0] != null ? String(row[0]).trim() : '';
    if (!name) continue;
    dishes.push({ id: String(i), name });
  }
  return dishes;
}

/**
 * Build map: userName -> { dishNumber (1-based), price }.
 * User nào react :up: thì price = upPrice (40k), còn lại defaultPrice (35k).
 * Also returns multiOrderUserIds: users who reacted to 2+ dishes (we only count first); firstDishIndex is 1-based.
 */
function buildOrdersByUserName(orders, userIdToName, dishes, defaultPrice = 35000, upUserIds = new Set(), upPrice = 40000) {
  /** @type {Record<string, number[]>} */
  const userToDishIndices = {};
  for (const o of orders) {
    for (const uid of o.user_ids) {
      if (!userToDishIndices[uid]) userToDishIndices[uid] = [];
      userToDishIndices[uid].push(o.dish_index);
    }
  }
  /** @type {Record<string, { dishNumber: number; price: number }>} */
  const ordersByUserName = {};
  /** @type {Array<{ userId: string; firstDishIndex1Based: number }>} */
  const multiOrderUserIds = [];
  for (const [uid, indices] of Object.entries(userToDishIndices)) {
    const name = userIdToName[uid] ?? uid;
    const sorted = [...indices].sort((a, b) => a - b);
    const firstDishIndex = sorted[0];
    const price = upUserIds.has(uid) ? upPrice : defaultPrice;
    ordersByUserName[name] = {
      dishNumber: firstDishIndex + 1,
      price,
    };
    if (sorted.length > 1) {
      multiOrderUserIds.push({ userId: uid, firstDishIndex1Based: firstDishIndex + 1 });
    }
  }
  return { ordersByUserName, multiOrderUserIds };
}

/** Chuyển cột 1-based sang chữ (1=A, 2=B, ..., 27=AA). */
function sheetColumnToLetter(oneBased) {
  if (oneBased <= 0) return '';
  let n = oneBased;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/**
 * Cột order: từ cột B, mỗi ngày = 2 cột (số món, giá). Hàng 12: 2 ô merge = ngày (1-31).
 * Tìm block cho ngày hôm nay; xóa block đó rồi ghi lại số món (1-based) và giá vào từng hàng user.
 */
async function writeOrdersToSheet(sheets, spreadsheetId, ordersSheetName, ordersUserRange, ordersDateRow, ordersColumnStart, ordersDefaultPrice, ordersMaxDays, ordersByUserName) {
  const quoted = /[\s']/.test(ordersSheetName) ? `'${ordersSheetName.replace(/'/g, "''")}'` : ordersSheetName;
  const userRange = `${quoted}!${ordersUserRange}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: userRange,
  });
  const userRows = res.data.values || [];
  if (userRows.length === 0) {
    console.warn('Orders sheet user range is empty:', userRange);
    return;
  }

  const match = ordersUserRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i) || ordersUserRange.match(/^([A-Z]+)(\d+)$/i);
  const startRow = match ? parseInt(match[2], 10) : 15;
  const todayDay = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCDate();

  let startCol1Based = 2;
  const colStr = ordersColumnStart.toUpperCase();
  if (colStr.length === 1) {
    startCol1Based = colStr.charCodeAt(0) - 64;
  } else {
    startCol1Based = (colStr.charCodeAt(0) - 64) * 26 + (colStr.charCodeAt(1) - 64);
  }

  const numCols = ordersMaxDays * 2;
  const endCol1Based = startCol1Based + numCols - 1;
  const dateRange = `${quoted}!${sheetColumnToLetter(startCol1Based)}${ordersDateRow}:${sheetColumnToLetter(endCol1Based)}${ordersDateRow}`;
  const dateRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: dateRange,
  });
  const dateRowValues = (dateRes.data.values || [])[0] || [];

  let pairIndex = -1;
  for (let i = 0; i < ordersMaxDays; i++) {
    const cell = dateRowValues[2 * i];
    const val = cell != null ? Number(String(cell).trim()) : NaN;
    if (val === todayDay) {
      pairIndex = i;
      break;
    }
  }
  if (pairIndex < 0) {
    throw new Error(`Không tìm thấy cột ngày ${todayDay} ở hàng ${ordersDateRow}. Bạn cần tạo và merge ô cho ngày này thủ công.`);
  }

  const dishCol = sheetColumnToLetter(startCol1Based + 2 * pairIndex);
  const priceCol = sheetColumnToLetter(startCol1Based + 2 * pairIndex + 1);
  const blockRange = `${quoted}!${dishCol}${startRow}:${priceCol}${startRow + userRows.length - 1}`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: blockRange,
  });

  const normalized = (s) => String(s ?? '').trim().toLowerCase();
  const newBlock = [];
  for (let i = 0; i < userRows.length; i++) {
    const userNameInSheet = userRows[i]?.[0] != null ? String(userRows[i][0]).trim() : '';
    const key = Object.keys(ordersByUserName).find((k) => normalized(k) === normalized(userNameInSheet));
    if (key) {
      const { dishNumber, price } = ordersByUserName[key];
      newBlock.push([dishNumber, price]);
    } else {
      newBlock.push(['', '']);
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: blockRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: newBlock },
  });
}

/** Post a message in a Slack thread (channel + thread_ts). Requires chat:write. */
async function postReplyInThread(botToken, channelId, threadTs, text) {
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
  if (!data.ok) throw new Error(`Slack chat.postMessage error: ${data.error ?? res.status}`);
}

/** Add a single reaction to a message. Requires reactions:write. */
async function addReactionToMessage(botToken, channelId, messageTs, emojiName) {
  const res = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: channelId,
      timestamp: messageTs,
      name: emojiName,
    }),
  });
  const data = await res.json();
  if (!data.ok) console.warn('reactions.add failed for', emojiName, data.error);
}

export async function handler(event) {
  console.log('CollectOrders invoked', JSON.stringify(event?.detail ?? event));

  try {
    const config = await getConfig();
    const botToken = config['bot-token'];
    const sheetId = config['sheet-id'];
    const credentials = config['sheet-credentials'];
    if (!botToken) throw new Error('Missing bot-token in Parameter Store');
    if (!sheetId || !credentials) throw new Error('Missing sheet-id or sheet-credentials in Parameter Store');

    const menu = await getTodayMenuMessage();
    if (!menu) {
      console.warn('No menu message for today; skipping order collection');
      return { ok: true, skipped: true, reason: 'no_menu_today' };
    }

    const { channel_id, message_ts } = menu;
    const { orders, upUserIds } = await getReactions(botToken, channel_id, message_ts);
    if (orders.length === 0) {
      console.log('No reactions on menu message');
      return { ok: true, message_ts, order_count: 0 };
    }

    const userIdToName = await resolveUserIdsToNames(botToken);
    console.log('Resolved users:', Object.keys(userIdToName).length, 'Upsize users:', upUserIds.size);

    const sheetName = config['dishes-sheet-name'] || getDishesSheetNameForCurrentMonth();
    const dishesRange = config['dishes-range'] || 'N4:N8';
    const ordersUserRange = config['orders-user-range'] || 'A15:A100';
    const ordersDateRow = parseInt(config['orders-date-row'] || '12', 10);
    const ordersColumnStart = config['orders-column-start'] || 'B';
    const ordersDefaultPrice = parseInt(config['orders-default-price'] || '35000', 10);
    const ordersUpsizePrice = parseInt(config['orders-upsize-price'] || '40000', 10);
    const ordersMaxDays = parseInt(config['orders-max-days'] || '31', 10);

    const sheets = getSheetsClient(credentials);
    const dishes = await fetchDishesFromSheet(sheets, sheetId, sheetName, dishesRange);
    const { ordersByUserName, multiOrderUserIds } = buildOrdersByUserName(
      orders,
      userIdToName,
      dishes,
      ordersDefaultPrice,
      upUserIds,
      ordersUpsizePrice
    );
    console.log('Orders by user:', JSON.stringify(ordersByUserName, null, 2));

    await writeOrdersToSheet(
      sheets,
      sheetId,
      sheetName,
      ordersUserRange,
      ordersDateRow,
      ordersColumnStart,
      ordersDefaultPrice,
      ordersMaxDays,
      ordersByUserName
    );
    console.log('Wrote orders to sheet');

    const triggeredBySlackReply = event?.triggeredBy === 'slack_reply';

    // Ping users who reacted to 2+ dishes: only first dish is recorded.
    for (const { userId, firstDishIndex1Based } of multiOrderUserIds) {
      const text = `<@${userId}> Bạn đang đặt 2 món, nhà bếp chỉ ghi nhận món ${firstDishIndex1Based}`;
      try {
        await postReplyInThread(botToken, channel_id, message_ts, text);
      } catch (err) {
        console.warn('Failed to ping multi-order user', userId, err);
      }
    }

    if (triggeredBySlackReply && event?.replyChannelId && event?.replyTs) {
      await addReactionToMessage(botToken, event.replyChannelId, event.replyTs, 'white_check_mark');
    } else {
      // Schedule run: post confirmation reply under today's menu.
      await postReplyInThread(botToken, channel_id, message_ts, 'Đã ghi nhận danh sách đặt món :bee-like:');
    }

    return { ok: true, message_ts, order_count: Object.keys(ordersByUserName).length };
  } catch (err) {
    console.error('CollectOrders error:', err);
    throw err;
  }
}
