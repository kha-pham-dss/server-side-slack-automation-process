/**
 * CollectOrders Lambda — invoke từ Slack Events khi user @Mr.Chef dưới menu.
 * Đọc reactions, ghi đơn lên sheet + ô Zalo summary (S62), ping reconcile sau 11h GMT+7.
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  getDishesSheetNameForCurrentMonth,
  getSheetsClient,
  loadConfigFromParameterStore,
  formatOrderLine,
  fetchSlackReactions,
  syncOrdersToSheetAndSummary,
  DEFAULT_MEAL_PRICE,
  UPSIZE_MEAL_PRICE,
} from '@slack-dishes/shared';
import {
  CACHE_TTL_MS,
  dateKeyGmt7,
  isAfterZaloSummaryCutoffNow,
} from '@slack-dishes/shared/time-constants.js';

const dynamo = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME;
const DISHES_TABLE_NAME = process.env.DISHES_TABLE_NAME;
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
    const sheetName = config['dishes-sheet-name'] || getDishesSheetNameForCurrentMonth();
    const sheets = getSheetsClient(credentials);

    const defaultPrice = parseInt(config['orders-default-price'] || String(DEFAULT_MEAL_PRICE), 10);
    const upPrice = parseInt(config['orders-upsize-price'] || String(UPSIZE_MEAL_PRICE), 10);

    const { orders, upUserIds } = await fetchSlackReactions(botToken, channel_id, message_ts);
    if (orders.length === 0 && upUserIds.size === 0) {
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
    });

    const { ordersByUserId, userIdToName, dishes, zaloCell, summaryText, cappedUserIds } = syncResult;

    const triggeredBySlackReply = event?.triggeredBy === 'slack_reply';
    const afterZaloCutoff = event?.afterZaloCutoff === true || isAfterZaloSummaryCutoffNow();
    const triggeringUserId = event?.userId;

    for (const { userId, dishCount } of cappedUserIds) {
      try {
        await postReplyInThread(
          botToken,
          channel_id,
          message_ts,
          `<@${userId}> Bạn đang đặt ${dishCount} món, hệ thống chỉ ghi nhận tối đa 5 món đầu`
        );
      } catch (err) {
        console.warn('Failed to ping capped-order user', userId, err);
      }
    }

    if (triggeredBySlackReply && event?.replyChannelId && event?.replyTs) {
      await addReactionToMessage(botToken, event.replyChannelId, event.replyTs, 'white_check_mark');
    }

    if (afterZaloCutoff && triggeringUserId) {
      const order = ordersByUserId[triggeringUserId];
      const reconcileUid = (
        process.env.RECONCILE_NOTIFY_SLACK_USER_ID || RECONCILE_NOTIFY_SLACK_USER_ID
      ).trim();
      const ping = reconcileUid ? `<@${reconcileUid}> ` : '';
      if (order?.dishIndices?.length) {
        const userName = userIdToName[triggeringUserId] ?? triggeringUserId;
        const line = formatOrderLine(userName, order, dishes, defaultPrice, upPrice, {
          includeNames: false,
        });
        await postReplyInThread(botToken, channel_id, message_ts, `${ping}${line}`);
      } else {
        await postReplyInThread(
          botToken,
          channel_id,
          message_ts,
          `${ping}Có cập nhật đặt món sau khi đã gửi Zalo (user chưa chọn món).`
        );
      }
    } else if (triggeredBySlackReply && !afterZaloCutoff) {
      await postReplyInThread(botToken, channel_id, message_ts, 'Đã ghi nhận danh sách đặt món :bee-like:');
    }

    return {
      ok: true,
      message_ts,
      order_count: Object.keys(ordersByUserId).length,
      zalo_cell: zaloCell,
      summary_preview: summaryText?.slice(0, 120),
    };
  } catch (err) {
    console.error('CollectOrders error:', err);
    throw err;
  }
}
