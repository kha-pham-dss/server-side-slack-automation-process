/** Cột ghi Slack user ID trên sheet; ghi đè bằng SSM orders-slack-id-column. */
export const DEFAULT_ORDERS_SLACK_ID_COLUMN = 'BZ';

export function getOrdersSlackIdColumn(config) {
  const col = config['orders-slack-id-column']?.trim();
  if (col) return col.toUpperCase();
  return DEFAULT_ORDERS_SLACK_ID_COLUMN;
}

/**
 * Hàng bắt đầu/kết thúc từ orders-user-range (e.g. A15:A100).
 * @param {string} ordersUserRange
 */
export function parseA1RowBounds(ordersUserRange) {
  const m =
    ordersUserRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i) ||
    ordersUserRange.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return { startRow: 15, endRow: 100 };
  const startRow = parseInt(m[2], 10);
  const endRow = m[4] ? parseInt(m[4], 10) : startRow;
  return { startRow, endRow };
}

/** Ví dụ: A15:A100 + BZ → BZ15:BZ100 */
export function slackIdRangeForUserRange(ordersUserRange, slackIdColumn) {
  const { startRow, endRow } = parseA1RowBounds(ordersUserRange);
  const col = slackIdColumn.toUpperCase();
  return `${col}${startRow}:${col}${endRow}`;
}

/**
 * Range cột Slack ID: ưu tiên orders-slack-id-range (legacy), không thì cột SSM (mặc định BZ) + hàng từ orders-user-range.
 * @param {Record<string, string>} config
 */
export function resolveOrdersSlackIdRange(config) {
  const legacy = config['orders-slack-id-range']?.trim();
  if (legacy) return legacy;
  const userRange = config['orders-user-range']?.trim() || 'A15:A100';
  return slackIdRangeForUserRange(userRange, getOrdersSlackIdColumn(config));
}

export function quoteSheetTabName(sheetName) {
  return /[\s']/.test(sheetName) ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
}

export function normalizeSheetName(s) {
  return String(s ?? '').trim().toLowerCase();
}

export function slackMemberNameKeys(m) {
  const keys = new Set();
  for (const field of [m.real_name, m.profile?.real_name, m.profile?.display_name, m.name]) {
    const n = field != null ? String(field).trim() : '';
    if (n) keys.add(normalizeSheetName(n));
  }
  return keys;
}

/**
 * @returns {Promise<{ userIdToName: Record<string, string>; userIdToNameKeys: Record<string, Set<string>> }>}
 */
export async function resolveSlackUserProfiles(botToken) {
  const userIdToName = {};
  const userIdToNameKeys = {};
  let cursor = '';
  do {
    const url = new URL('https://slack.com/api/users.list');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack users.list error: ${data.error ?? res.status}`);

    for (const m of data.members ?? []) {
      if (!m.id || m.is_bot || m.deleted) continue;
      userIdToNameKeys[m.id] = slackMemberNameKeys(m);
      userIdToName[m.id] =
        m.real_name?.trim() || m.profile?.display_name?.trim() || m.name || m.id;
    }
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  return { userIdToName, userIdToNameKeys };
}

/** Tên trên sheet → Slack user ID (khớp alias profile). */
export function findSlackUserIdForSheetName(sheetName, userIdToNameKeys) {
  const normName = normalizeSheetName(sheetName);
  if (!normName) return null;
  for (const [uid, keys] of Object.entries(userIdToNameKeys)) {
    if (keys.has(normName)) return uid;
  }
  return null;
}

export function findOrderForSheetRow(sheetName, sheetSlackId, ordersByUserId, userIdToNameKeys) {
  const sid = String(sheetSlackId ?? '').trim();
  if (/^U[A-Z0-9]+$/i.test(sid) && ordersByUserId[sid]) {
    return { userId: sid, order: ordersByUserId[sid] };
  }
  const normName = normalizeSheetName(sheetName);
  if (!normName) return null;
  for (const [uid, order] of Object.entries(ordersByUserId)) {
    if (userIdToNameKeys[uid]?.has(normName)) return { userId: uid, order };
  }
  return null;
}

export function getDishesSheetNameForCurrentMonth() {
  const gmt7 = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const month = gmt7.getUTCMonth() + 1;
  const year = gmt7.getUTCFullYear();
  return `Tháng ${month} / ${year}`;
}
