import {
  DEFAULT_MEAL_PRICE,
  UPSIZE_MEAL_PRICE,
  MAX_DISHES_PER_USER_DEFAULT,
  MAX_DISHES_PER_USER_UPSIZE,
  UP_EMOJI,
  ZALO_SUMMARY_CELL_DEFAULT,
  dishIndexFromEmoji,
  formatPriceLabel,
} from './meal-constants.js';
import { findOrderForSheetRow, quoteSheetTabName, resolveOrdersSlackIdRange, resolveSlackUserProfiles } from './sheet-slack.js';
import { nowGmt7 } from './time-constants.js';
import { getDishesMenuForDate } from './dynamo-dishes.js';
import { getOrderOverridesByUserForDate } from './dynamo-order-overrides.js';
import {
  formatDishNamesWithQtyOverrides,
  userHasOrderContent,
  totalPortions,
} from './order-qty.js';

/**
 * @param {Array<{ emoji: string; dish_index: number; user_ids: string[] }>} orders
 * @param {Set<string>} upUserIds
 */
export function buildOrdersByUserId(
  orders,
  upUserIds = new Set(),
  defaultPrice = DEFAULT_MEAL_PRICE,
  upPrice = UPSIZE_MEAL_PRICE,
  maxDefaultDishes = MAX_DISHES_PER_USER_DEFAULT,
  maxUpsizeDishes = MAX_DISHES_PER_USER_UPSIZE
) {
  /** @type {Record<string, number[]>} */
  const userToDishIndices = {};
  for (const o of orders) {
    for (const uid of o.user_ids) {
      if (!userToDishIndices[uid]) userToDishIndices[uid] = [];
      if (!userToDishIndices[uid].includes(o.dish_index)) {
        userToDishIndices[uid].push(o.dish_index);
      }
    }
  }

  /** @type {Record<string, { dishIndices: number[]; price: number }>} */
  const ordersByUserId = {};
  /** @type {Array<{ userId: string; dishCount: number; maxDishes: number; price: number }>} */
  const cappedUserIds = [];

  for (const [uid, indices] of Object.entries(userToDishIndices)) {
    const sorted = [...indices].sort((a, b) => a - b);
    const isUpsize = upUserIds.has(uid);
    const maxDishes = isUpsize ? maxUpsizeDishes : maxDefaultDishes;
    const capped = sorted.slice(0, maxDishes);
    if (sorted.length > maxDishes) {
      cappedUserIds.push({
        userId: uid,
        dishCount: sorted.length,
        maxDishes,
        price: isUpsize ? upPrice : defaultPrice,
      });
    }
    ordersByUserId[uid] = {
      dishIndices: capped,
      price: isUpsize ? upPrice : defaultPrice,
    };
  }

  return { ordersByUserId, cappedUserIds };
}

/**
 * Bổ sung user vượt tổng phần (kể cả 2x–5x) vào cappedUserIds — chỉ để ping, không cắt đơn.
 * @param {Record<string, { dishIndices: number[]; price: number }>} ordersByUserId
 * @param {Array<{ userId: string; dishCount: number; maxDishes: number; price: number }>} cappedUserIds
 * @param {Record<string, Record<number, number>>} overridesByUserId
 */
export function mergeQtyOverLimitWarnings(
  ordersByUserId,
  cappedUserIds,
  overridesByUserId = {},
  defaultPrice = DEFAULT_MEAL_PRICE,
  upPrice = UPSIZE_MEAL_PRICE,
  maxDefaultDishes = MAX_DISHES_PER_USER_DEFAULT,
  maxUpsizeDishes = MAX_DISHES_PER_USER_UPSIZE
) {
  const already = new Set(cappedUserIds.map((c) => c.userId));
  const out = [...cappedUserIds];

  for (const [uid, order] of Object.entries(ordersByUserId)) {
    if (already.has(uid)) continue;
    const qtyOverrides = overridesByUserId[uid] || {};
    const portions = totalPortions(order.dishIndices, qtyOverrides);
    const isUpsize = order.price === upPrice;
    const maxDishes = isUpsize ? maxUpsizeDishes : maxDefaultDishes;
    if (portions > maxDishes) {
      out.push({
        userId: uid,
        dishCount: portions,
        maxDishes,
        price: order.price ?? (isUpsize ? upPrice : defaultPrice),
      });
      already.add(uid);
    }
  }

  return out;
}

/** @param {number[]} dishIndices 0-based */
export function formatDishNumbers(dishIndices) {
  return dishIndices.map((i) => i + 1).join('+');
}

/** @param {Array<{ id?: string; name: string }>} dishes */
export function formatDishNames(dishIndices, dishes) {
  return dishIndices
    .map((i) => {
      const d = dishes[i];
      const name = d && typeof d === 'object' && d.name != null ? String(d.name).trim() : '';
      return name || String(i + 1);
    })
    .join('+');
}

/**
 * @param {string} userName
 * @param {{ dishIndices: number[]; price: number }} order
 * @param {Array<{ name: string }>} dishes
 */
export function formatOrderLine(
  userName,
  order,
  dishes,
  defaultPrice = DEFAULT_MEAL_PRICE,
  upPrice = UPSIZE_MEAL_PRICE,
  qtyOverrides = {}
) {
  const priceLabel = formatPriceLabel(order.price, defaultPrice, upPrice);
  const names = formatDishNamesWithQtyOverrides(order.dishIndices, dishes, qtyOverrides);
  return `suất ${priceLabel} ${names}, cho ${userName}`;
}

/**
 * @param {Record<string, { dishIndices: number[]; price: number }>} ordersByUserId
 * @param {Record<string, string>} userIdToName
 * @param {Array<{ name: string }>} dishes
 * @param {string[]} userOrderSlackIds — thứ tự dòng sheet (Slack user ID đã khớp)
 */
export function buildZaloSummaryText(
  ordersByUserId,
  userIdToName,
  dishes,
  userOrderSlackIds,
  defaultPrice = DEFAULT_MEAL_PRICE,
  upPrice = UPSIZE_MEAL_PRICE,
  overridesByUserId = {}
) {
  const lines = [];
  const seen = new Set();

  for (const uid of userOrderSlackIds) {
    const order = ordersByUserId[uid];
    const qtyOverrides = overridesByUserId[uid] || {};
    if (!order || !userHasOrderContent(order.dishIndices, qtyOverrides) || seen.has(uid)) continue;
    seen.add(uid);
    const name = userIdToName[uid] ?? uid;
    lines.push(formatOrderLine(name, order, dishes, defaultPrice, upPrice, qtyOverrides));
  }

  for (const [uid, order] of Object.entries(ordersByUserId)) {
    const qtyOverrides = overridesByUserId[uid] || {};
    if (seen.has(uid) || !userHasOrderContent(order.dishIndices, qtyOverrides)) continue;
    seen.add(uid);
    const name = userIdToName[uid] ?? uid;
    lines.push(formatOrderLine(name, order, dishes, defaultPrice, upPrice, qtyOverrides));
  }

  let count30k = 0;
  let count35k = 0;
  for (const order of Object.values(ordersByUserId)) {
    if (!order.dishIndices.length) continue;
    if (order.price === upPrice) count35k++;
    else count30k++;
  }

  const totalParts = [];
  if (count30k > 0) totalParts.push(`${count30k} suất 30k`);
  if (count35k > 0) totalParts.push(`${count35k} suất 35k`);
  if (totalParts.length) {
    lines.push(`Tổng ${totalParts.join(', ')} nhé ạ`);
  }

  return lines.join('\n');
}

/**
 * Slack reactions.get → orders + :up: user set.
 * @returns {{ orders: Array<{ emoji: string; dish_index: number; user_ids: string[] }>; upUserIds: Set<string> }}
 */
export function parseReactionsFromSlackMessage(reactions, botUserId = null) {
  const excludeBot = (ids) => (botUserId ? ids.filter((id) => id !== botUserId) : ids);
  /** @type {Array<{ emoji: string; dish_index: number; user_ids: string[] }>} */
  const orders = [];
  /** @type {Set<string>} */
  const upUserIds = new Set();

  for (const r of reactions ?? []) {
    const name = r.name;
    if (typeof name !== 'string') continue;
    const users = excludeBot(r.users ?? []);
    if (name === UP_EMOJI) {
      users.forEach((id) => upUserIds.add(id));
      continue;
    }
    const idx = dishIndexFromEmoji(name);
    if (idx < 0) continue;
    orders.push({ emoji: name, dish_index: idx, user_ids: users });
  }

  return { orders, upUserIds };
}

export async function fetchSlackReactions(botToken, channelId, messageTs) {
  const url = new URL('https://slack.com/api/reactions.get');
  url.searchParams.set('channel', channelId);
  url.searchParams.set('timestamp', messageTs);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack reactions.get error: ${data.error ?? res.status}`);

  let botUserId = null;
  try {
    const authRes = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const authData = await authRes.json();
    if (authData.ok) botUserId = authData.user_id ?? null;
  } catch {
    /* ignore */
  }

  return parseReactionsFromSlackMessage(data.message?.reactions, botUserId);
}

export function resolveZaloSummaryCell(config = {}) {
  return (
    (process.env.ZALO_SUMMARY_CELL || config['zalo-summary-cell'] || ZALO_SUMMARY_CELL_DEFAULT).trim() ||
    ZALO_SUMMARY_CELL_DEFAULT
  );
}

/**
 * Tổng hợp tin Zalo từ Slack reactions (in-memory). Tên món lấy từ DynamoDB (dishes menu table).
 */
export async function aggregateOrderSummaryFromReactions({
  config,
  sheets,
  sheetId,
  sheetName,
  channelId,
  messageTs,
  botToken,
  dynamo,
  dishesTableName,
  orderOverridesTableName,
  dishes: paramsDishes,
}) {
  const defaultPrice = parseInt(config['orders-default-price'] || String(DEFAULT_MEAL_PRICE), 10);
  const upPrice = parseInt(config['orders-upsize-price'] || String(UPSIZE_MEAL_PRICE), 10);

  const { orders, upUserIds } = await fetchSlackReactions(botToken, channelId, messageTs);
  const { userIdToName, userIdToNameKeys } = await resolveSlackUserProfiles(botToken);
  const { ordersByUserId, cappedUserIds: cappedFromReactions } = buildOrdersByUserId(
    orders,
    upUserIds,
    defaultPrice,
    upPrice
  );

  let dishes = paramsDishes;
  if (!dishes) {
    if (!dynamo || !dishesTableName) {
      throw new Error('aggregateOrderSummaryFromReactions: provide dishes or dynamo + dishesTableName');
    }
    dishes = (await getDishesMenuForDate(dynamo, dishesTableName)) ?? [];
  }

  const overridesByUserId =
    dynamo && orderOverridesTableName
      ? await getOrderOverridesByUserForDate(dynamo, orderOverridesTableName)
      : {};

  const cappedUserIds = mergeQtyOverLimitWarnings(
    ordersByUserId,
    cappedFromReactions,
    overridesByUserId,
    defaultPrice,
    upPrice
  );

  const ordersUserRange = config['orders-user-range'] || 'A15:A100';
  const ordersSlackIdRange = resolveOrdersSlackIdRange(config);
  const matchedUserIds = await listMatchedUserIds(
    sheets,
    sheetId,
    sheetName,
    ordersUserRange,
    ordersSlackIdRange,
    ordersByUserId,
    userIdToNameKeys,
    overridesByUserId
  );

  const summaryText = buildZaloSummaryText(
    ordersByUserId,
    userIdToName,
    dishes,
    matchedUserIds,
    defaultPrice,
    upPrice,
    overridesByUserId
  );

  const zaloCell = resolveZaloSummaryCell(config);

  return {
    summaryText,
    ordersByUserId,
    matchedUserIds,
    cappedUserIds,
    userIdToName,
    userIdToNameKeys,
    dishes,
    zaloCell,
    defaultPrice,
    upPrice,
    overridesByUserId,
  };
}

/** Ghi giá từng user + ô S62 (chỉ ghi, không đọc lại). */
export async function persistOrdersToSheet({
  config,
  sheets,
  sheetId,
  sheetName,
  ordersByUserId,
  userIdToNameKeys,
  userIdToName,
  summaryText,
  zaloCell,
  dishes,
  overridesByUserId = {},
}) {
  const ordersUserRange = config['orders-user-range'] || 'A15:A100';
  const ordersSlackIdRange = resolveOrdersSlackIdRange(config);
  const ordersDateRow = parseInt(config['orders-date-row'] || '12', 10);
  const ordersColumnStart = config['orders-column-start'] || 'B';
  const ordersMaxDays = parseInt(config['orders-max-days'] || '31', 10);

  const { unmatchedUserIds, matchedUserIds } = await writeOrdersToSheet(
    sheets,
    sheetId,
    sheetName,
    ordersUserRange,
    ordersSlackIdRange,
    ordersDateRow,
    ordersColumnStart,
    ordersMaxDays,
    ordersByUserId,
    userIdToNameKeys,
    userIdToName,
    dishes,
    overridesByUserId
  );

  if (summaryText) {
    await writeZaloSummaryCell(sheets, sheetId, sheetName, zaloCell, summaryText);
  }

  return { unmatchedUserIds, matchedUserIds };
}

/**
 * Tổng hợp in-memory rồi ghi sheet (dùng cho collect-orders).
 */
export async function syncOrdersToSheetAndSummary(params) {
  const agg = await aggregateOrderSummaryFromReactions(params);
  const orderCount = Object.entries(agg.ordersByUserId).filter(([uid, o]) =>
    userHasOrderContent(o.dishIndices, agg.overridesByUserId?.[uid])
  ).length;
  const summaryText =
    orderCount === 0 ? 'Nay bọn em không đặt gì anh nhé' : agg.summaryText;

  await persistOrdersToSheet({
    config: params.config,
    sheets: params.sheets,
    sheetId: params.sheetId,
    sheetName: params.sheetName,
    ordersByUserId: agg.ordersByUserId,
    userIdToNameKeys: agg.userIdToNameKeys,
    userIdToName: agg.userIdToName,
    summaryText,
    zaloCell: agg.zaloCell,
    dishes: agg.dishes,
    overridesByUserId: agg.overridesByUserId,
  });

  return { ...agg, summaryText };
}

async function listMatchedUserIds(
  sheets,
  spreadsheetId,
  ordersSheetName,
  ordersUserRange,
  ordersSlackIdRange,
  ordersByUserId,
  userIdToNameKeys,
  overridesByUserId = {}
) {
  const quoted = quoteSheetTabName(ordersSheetName);
  const userRange = `${quoted}!${ordersUserRange}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: userRange });
  const userRows = res.data.values || [];
  if (userRows.length === 0) return [];

  const idRange = `${quoted}!${ordersSlackIdRange}`;
  const idRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: idRange });
  const slackIdRows = idRes.data.values || [];

  const matchedUserIds = [];
  for (let i = 0; i < userRows.length; i++) {
    const userNameInSheet = userRows[i]?.[0] != null ? String(userRows[i][0]).trim() : '';
    const sheetSlackId = slackIdRows[i]?.[0] != null ? String(slackIdRows[i][0]).trim() : '';
    const hit = findOrderForSheetRow(userNameInSheet, sheetSlackId, ordersByUserId, userIdToNameKeys);
    const qtyOverrides = hit ? overridesByUserId[hit.userId] || {} : {};
    if (hit && userHasOrderContent(hit.order.dishIndices, qtyOverrides)) {
      matchedUserIds.push(hit.userId);
    }
  }
  return matchedUserIds;
}

/** Chia món thành các cột, tối đa 5 món/cột (1–5 | 6–10 | 11–15 | …). */
export function splitDishesIntoColumns(dishes) {
  const count = dishes.length;
  if (count === 0) return [];

  const MAX_PER_COL = 5;
  /** @type {typeof dishes[]} */
  const columns = [];
  for (let start = 0; start < count; start += MAX_PER_COL) {
    columns.push(dishes.slice(start, start + MAX_PER_COL));
  }
  return columns;
}

/**
 * @param {Array<{ name: string }>} dishes
 * @param {string[]} dishEmojiNames
 */
export function formatDishColumnText(dishes, startIndex, dishEmojiNames) {
  return dishes
    .map((d, i) => {
      const idx = startIndex + i;
      const emoji = dishEmojiNames[idx] ?? String(idx + 1);
      const name = d?.name != null ? String(d.name).trim() : '';
      return `:${emoji}: (${name})`;
    })
    .join('\n');
}

export { findOrderForSheetRow };

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

/** Ghi tin nhắn Zalo tổng hợp vào một ô (vd. S62). */
export async function writeZaloSummaryCell(sheets, spreadsheetId, sheetName, cellRef, text) {
  const quoted = quoteSheetTabName(sheetName);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoted}!${cellRef}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[text]] },
  });
}

/**
 * Ghi đơn từng user (cột món = tên món "Phở+Bún+...", cột giá) + trả về thứ tự Slack user ID đã khớp.
 * @returns {Promise<{ unmatchedUserIds: string[]; matchedUserIds: string[] }>}
 */
export async function writeOrdersToSheet(
  sheets,
  spreadsheetId,
  ordersSheetName,
  ordersUserRange,
  ordersSlackIdRange,
  ordersDateRow,
  ordersColumnStart,
  ordersMaxDays,
  ordersByUserId,
  userIdToNameKeys,
  userIdToName,
  dishes = [],
  overridesByUserId = {}
) {
  const quoted = quoteSheetTabName(ordersSheetName);
  const userRange = `${quoted}!${ordersUserRange}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: userRange });
  const userRows = res.data.values || [];
  if (userRows.length === 0) {
    console.warn('Orders sheet user range is empty:', userRange);
    return { unmatchedUserIds: Object.keys(ordersByUserId), matchedUserIds: [] };
  }

  const idRange = `${quoted}!${ordersSlackIdRange}`;
  const idRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: idRange });
  const slackIdRows = idRes.data.values || [];

  const match =
    ordersUserRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i) ||
    ordersUserRange.match(/^([A-Z]+)(\d+)$/i);
  const startRow = match ? parseInt(match[2], 10) : 15;
  const todayDay = nowGmt7().getUTCDate();

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
  const dateRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: dateRange });
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
    throw new Error(
      `Không tìm thấy cột ngày ${todayDay} ở hàng ${ordersDateRow}. Bạn cần tạo và merge ô cho ngày này thủ công.`
    );
  }

  const dishCol = sheetColumnToLetter(startCol1Based + 2 * pairIndex);
  const priceCol = sheetColumnToLetter(startCol1Based + 2 * pairIndex + 1);
  const blockRange = `${quoted}!${dishCol}${startRow}:${priceCol}${startRow + userRows.length - 1}`;

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: blockRange });

  const matchedUserIds = [];
  const newBlock = [];
  for (let i = 0; i < userRows.length; i++) {
    const userNameInSheet = userRows[i]?.[0] != null ? String(userRows[i][0]).trim() : '';
    const sheetSlackId = slackIdRows[i]?.[0] != null ? String(slackIdRows[i][0]).trim() : '';
    const hit = findOrderForSheetRow(userNameInSheet, sheetSlackId, ordersByUserId, userIdToNameKeys);
    const qtyOverrides = hit ? overridesByUserId[hit.userId] || {} : {};
    if (hit && userHasOrderContent(hit.order.dishIndices, qtyOverrides)) {
      matchedUserIds.push(hit.userId);
      newBlock.push([
        formatDishNamesWithQtyOverrides(hit.order.dishIndices, dishes, qtyOverrides),
        hit.order.price,
      ]);
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

  const unmatchedUserIds = Object.keys(ordersByUserId).filter(
    (uid) => !matchedUserIds.includes(uid) && ordersByUserId[uid].dishIndices.length > 0
  );
  if (unmatchedUserIds.length > 0) {
    console.warn(
      'Orders not written (no matching sheet row). Add Slack user ID column or fix name:',
      unmatchedUserIds.map((uid) => ({ userId: uid, slackName: userIdToName[uid] ?? uid }))
    );
  }

  return { unmatchedUserIds, matchedUserIds };
}
