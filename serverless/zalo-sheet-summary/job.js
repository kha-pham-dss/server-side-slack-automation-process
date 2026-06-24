/**
 * Zalo sheet summary: 11:00 GMT+7 — tổng hợp đơn từ Slack reactions, ghi sheet (S62 + giá/user), gửi Zalo.
 * Tin gửi Zalo lấy trực tiếp từ biến in-memory (aggregateOrderSummaryFromReactions), không đọc lại sheet.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Zalo, ThreadType } from 'zca-js';
import { dateKeyGmt7 } from '@slack-dishes/shared/time-constants.js';
import {
  getDishesSheetNameForCurrentMonth,
  getSheetsClient,
  aggregateOrderSummaryFromReactions,
  persistOrdersToSheet,
} from '@slack-dishes/shared';

/** Ngày đầu vendor mới: manual gửi Zalo; set false sau khi ổn định. */
const ZALO_SEND_DISABLED = false;

const NO_ORDERS_MSG = 'Nay bọn em không đặt gì anh nhé';

const dynamo = new DynamoDBClient();

function dateKey() {
  return dateKeyGmt7();
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

/**
 * @param {Record<string, string>} config
 * @returns {Promise<{ ok?: true; skipped?: true; reason?: string }>}
 */
export async function runFromConfig(config) {
  const tableName = (process.env.TABLE_NAME || '').trim();
  const dishesTableName = (process.env.DISHES_TABLE_NAME || '').trim();
  const orderOverridesTableName = (process.env.ORDER_OVERRIDES_TABLE_NAME || '').trim();
  const botToken = (config['bot-token'] || '').trim();
  const sheetId = (config['sheet-id'] || config['sheet_id'] || '').trim();
  const credentials = (config['sheet-credentials'] || config['sheet_credentials'] || '').trim();

  if (!sheetId || !credentials) {
    console.warn('Zalo sheet summary: missing sheet-id or sheet-credentials');
    return { skipped: true, reason: 'missing_sheet_config' };
  }
  if (!botToken) {
    console.warn('Zalo sheet summary: missing bot-token');
    return { skipped: true, reason: 'no_bot_token' };
  }
  if (!dishesTableName) {
    console.warn('Zalo sheet summary: DISHES_TABLE_NAME not set');
    return { skipped: true, reason: 'no_dishes_table_name' };
  }

  let menu = null;
  if (tableName) {
    try {
      menu = await getTodayMenuRow(tableName);
      if (!menu) {
        console.log('Zalo sheet summary: no menu row for today; skip');
        return { skipped: true, reason: 'no_menu_today' };
      }
    } catch (e) {
      console.warn('Zalo sheet summary: DynamoDB menu lookup failed', e?.message || e);
      return { skipped: true, reason: 'dynamo_error' };
    }
  } else {
    console.warn('Zalo sheet summary: TABLE_NAME not set');
    return { skipped: true, reason: 'no_table_name' };
  }

  const sheetName = (config['dishes-sheet-name'] || '').trim() || getDishesSheetNameForCurrentMonth();
  const sheets = getSheetsClient(credentials);

  const agg = await aggregateOrderSummaryFromReactions({
    config,
    sheets,
    sheetId,
    sheetName,
    channelId: menu.channel_id,
    messageTs: menu.message_ts,
    botToken,
    dynamo,
    dishesTableName,
    orderOverridesTableName,
  });

  const orderCount = Object.entries(agg.ordersByUserId).filter(([uid, o]) => {
    const ov = agg.overridesByUserId?.[uid];
    return o.dishIndices?.length || (ov && Object.keys(ov).length);
  }).length;
  const noOrders = orderCount === 0;
  /** Tin Zalo: build trên Lambda, không đọc từ sheet. */
  const zaloMessage = noOrders ? NO_ORDERS_MSG : agg.summaryText;

  await persistOrdersToSheet({
    config,
    sheets,
    sheetId,
    sheetName,
    ordersByUserId: agg.ordersByUserId,
    userIdToNameKeys: agg.userIdToNameKeys,
    userIdToName: agg.userIdToName,
    summaryText: zaloMessage,
    zaloCell: agg.zaloCell,
    dishes: agg.dishes,
    overridesByUserId: agg.overridesByUserId,
  });

  if (ZALO_SEND_DISABLED) {
    console.log(
      `Zalo sheet summary [dry-run] cell=${agg.zaloCell} orders=${orderCount} msg=${JSON.stringify(zaloMessage)}`
    );
    return {
      ok: true,
      dry_run: true,
      zalo_cell: agg.zaloCell,
      order_count: orderCount,
      no_orders: noOrders,
      msg: zaloMessage,
    };
  }

  const groupId = (config['zalo-group-id'] || '').trim();
  const cookiesRaw = (config['zalo-cookies-json'] || '').trim();
  const imei = (config['zalo-imei'] || '').trim();
  const userAgent = (config['zalo-user-agent'] || '').trim();

  if (!groupId || !cookiesRaw || !imei || !userAgent) {
    console.warn('Zalo sheet summary: missing Zalo credentials');
    return { skipped: true, reason: 'incomplete_zalo_config' };
  }

  let cookie;
  try {
    cookie = JSON.parse(cookiesRaw);
  } catch {
    return { skipped: true, reason: 'invalid_cookies_json' };
  }

  const zalo = new Zalo();
  const api = await zalo.login({
    imei,
    cookie,
    userAgent,
    language: (config['zalo-language'] || 'vi').trim() || 'vi',
  });

  await api.sendMessage({ msg: zaloMessage }, groupId, ThreadType.Group);
  console.log(
    'Zalo sheet summary: sent to group',
    groupId,
    noOrders ? '(no orders)' : `${orderCount} orders`,
    '(from lambda aggregate, not sheet)'
  );

  return {
    ok: true,
    zalo_cell: agg.zaloCell,
    order_count: orderCount,
    no_orders: noOrders,
    msg: zaloMessage,
  };
}
