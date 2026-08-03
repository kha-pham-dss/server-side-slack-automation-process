/**
 * CollectOrders Lambda — chỉ invoke từ Slack Events khi user @Mr.Chef trong thread menu hôm nay.
 * Parse `2x`–`5x` + tên món từ tin reply → lưu DynamoDB; đọc reactions + overrides → sheet + S62.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import { mergeOrderOverridesForUser } from '@slack-dishes/shared/dynamo-order-overrides.js';
import { ensureCurrentMonthSheet } from '@slack-dishes/shared/ensure-month-sheet.js';
import { getSheetsClient } from '@slack-dishes/shared/sheets.js';
import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import {
  formatOrderLine,
  fetchSlackReactions,
  syncOrdersToSheetAndSummary,
} from '@slack-dishes/shared/orders.js';
import { DEFAULT_MEAL_PRICE, UPSIZE_MEAL_PRICE, formatPriceLabel } from '@slack-dishes/shared/meal-constants.js';
import { parseQtyOverridesFromMessage } from '@slack-dishes/shared/order-qty.js';
import {
  CACHE_TTL_MS,
  dateKeyGmt7,
  isAfterZaloSummaryCutoffNow,
} from '@slack-dishes/shared/time-constants.js';

const dynamo = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME;
const DISHES_TABLE_NAME = process.env.DISHES_TABLE_NAME;
const ORDER_OVERRIDES_TABLE_NAME = process.env.ORDER_OVERRIDES_TABLE_NAME;
const RECONCILE_NOTIFY_SLACK_USER_ID = 'U02SJRNAM2M';

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

async function getTodayMenuMessage() {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { date: { S: dateKeyGmt7() } },
    })
  );
  if (!res.Item) return null;
  return unmarshall(res.Item);
}

async function postReplyInThread(botToken, channelId, threadTs, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.postMessage error: ${data.error ?? res.status}`);
}

async function addReactionToMessage(botToken, channelId, messageTs, emojiName) {
  const res = await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, timestamp: messageTs, name: emojiName }),
  });
  const data = await res.json();
  if (!data.ok) console.warn('reactions.add failed for', emojiName, data.error);
}

export async function handler(event) {
  console.log('CollectOrders invoked', JSON.stringify(event?.detail ?? event));

  if (event?.triggeredBy !== 'slack_reply') {
    console.log('CollectOrders: skipped — chỉ chạy khi user @Mr.Chef trong thread menu hôm nay');
    return { ok: true, skipped: true, reason: 'not_slack_reply_trigger' };
  }

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
    const sheets = getSheetsClient(credentials);
    const ensured = await ensureCurrentMonthSheet({ sheets, spreadsheetId: sheetId, config });
    const sheetName = ensured.sheetName;
    if (ensured.created) {
      console.log('CollectOrders: created month sheet', ensured);
    }

    const defaultPrice = parseInt(config['orders-default-price'] || String(DEFAULT_MEAL_PRICE), 10);
    const upPrice = parseInt(config['orders-upsize-price'] || String(UPSIZE_MEAL_PRICE), 10);

    const dishes = (await getDishesMenuForDate(dynamo, DISHES_TABLE_NAME)) ?? [];
    const triggeringUserId = event?.userId;
    const messageText = event?.messageText || '';
    const dateKey = dateKeyGmt7();

    let savedOverrides = null;
    if (!ORDER_OVERRIDES_TABLE_NAME) {
      console.warn('CollectOrders: ORDER_OVERRIDES_TABLE_NAME not set — skip DynamoDB qty overrides');
    } else if (triggeringUserId && messageText) {
      const parsed = parseQtyOverridesFromMessage(messageText, dishes);
      if (Object.keys(parsed).length) {
        await mergeOrderOverridesForUser(dynamo, ORDER_OVERRIDES_TABLE_NAME, triggeringUserId, parsed, {
          date: dateKey,
          messageTs: event?.replyTs,
        });
        savedOverrides = parsed;
        console.log('CollectOrders: saved qty overrides', {
          table: ORDER_OVERRIDES_TABLE_NAME,
          date: dateKey,
          userId: triggeringUserId,
          overrides: parsed,
        });
      } else {
        console.warn('CollectOrders: qty parse empty', {
          userId: triggeringUserId,
          messageText: messageText.slice(0, 200),
          dishNames: dishes.map((d) => d.name),
          hint: 'Cần format 2x–5x + tên món khớp menu hôm nay (vd. 2x chả cá)',
        });
      }
    } else {
      console.warn('CollectOrders: skip qty parse', {
        hasUserId: !!triggeringUserId,
        hasMessageText: !!messageText,
        messageTextLen: messageText.length,
      });
    }

    const { orders, upUserIds } = await fetchSlackReactions(botToken, channel_id, message_ts);
    if (orders.length === 0 && upUserIds.size === 0 && !savedOverrides) {
      console.log('No reactions on menu message');
      return { ok: true, message_ts, order_count: 0 };
    }

    const syncResult = await syncOrdersToSheetAndSummary({
      config,
      sheets,
      sheetId,
      sheetName,
      channelId: channel_id,
      messageTs: message_ts,
      botToken,
      dynamo,
      dishesTableName: DISHES_TABLE_NAME,
      orderOverridesTableName: ORDER_OVERRIDES_TABLE_NAME,
      dishes,
    });

    const { ordersByUserId, userIdToName, zaloCell, summaryText, cappedUserIds, overridesByUserId } =
      syncResult;

    const afterZaloCutoff = event?.afterZaloCutoff === true || isAfterZaloSummaryCutoffNow();

    for (const { userId, dishCount, price } of cappedUserIds) {
      const priceLabel = formatPriceLabel(price, defaultPrice, upPrice);
      try {
        await postReplyInThread(
          botToken,
          channel_id,
          message_ts,
          `<@${userId}> Bạn đang đặt ${dishCount} món / suất ${priceLabel}`
        );
      } catch (err) {
        console.warn('Failed to ping over-limit user', userId, err);
      }
    }

    if (event?.replyChannelId && event?.replyTs) {
      await addReactionToMessage(botToken, event.replyChannelId, event.replyTs, 'white_check_mark');
    }

    if (afterZaloCutoff && triggeringUserId) {
      const order = ordersByUserId[triggeringUserId];
      const qtyOverrides = overridesByUserId?.[triggeringUserId] || {};
      const reconcileUid = (
        process.env.RECONCILE_NOTIFY_SLACK_USER_ID || RECONCILE_NOTIFY_SLACK_USER_ID
      ).trim();
      const ping = reconcileUid ? `<@${reconcileUid}> ` : '';
      if (order?.dishIndices?.length) {
        const userName = userIdToName[triggeringUserId] ?? triggeringUserId;
        const line = formatOrderLine(userName, order, dishes, defaultPrice, upPrice, qtyOverrides);
        await postReplyInThread(botToken, channel_id, message_ts, `${ping}${line}`);
      } else {
        await postReplyInThread(
          botToken,
          channel_id,
          message_ts,
          `${ping}Có cập nhật đặt món sau khi đã gửi Zalo (user chưa chọn món).`
        );
      }
    }

    return {
      ok: true,
      message_ts,
      order_count: Object.keys(ordersByUserId).length,
      qty_overrides_saved: savedOverrides,
      zalo_cell: zaloCell,
      summary_preview: summaryText?.slice(0, 120),
    };
  } catch (err) {
    console.error('CollectOrders error:', err);
    throw err;
  }
}
