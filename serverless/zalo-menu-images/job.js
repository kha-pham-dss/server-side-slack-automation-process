/**
 * Zalo menu images: poll Zalo group từ sau POST_MENU đến trước ZALO_SUMMARY (mỗi 10 phút).
 */

import { Zalo } from 'zca-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import {
  getMenuMessageForDate,
  setMenuLatestImageSyncState,
} from '@slack-dishes/shared/dynamo-menu.js';
import {
  buildMenuSlackBlocks,
  buildMenuSlackTextFallback,
  uploadImageBufferToSlack,
  updateSlackMenuMessage,
} from '@slack-dishes/shared/menu-slack.js';
import {
  extractZaloImageUrl,
  zaloMessageKey,
  zaloMessageSenderId,
  zaloMessageTimeMs,
} from '@slack-dishes/shared/zalo-message.js';
import { dateKeyGmt7 } from '@slack-dishes/shared/time-constants.js';

const dynamo = new DynamoDBClient();

/**
 * true = bỏ qua kiểm tra menu/dishes DynamoDB + bỏ lọc timestamp ảnh (test).
 * Dùng `channel-id` + `zalo-menu-test-message-ts` (SSM) khi chưa có row menu.
 * Đổi false trước khi chạy prod.
 */
const SKIP_MENU_TODAY_CHECK = true;

/** @param {{ posted_at?: string; message_ts?: string }} menuRow */
function menuPostedCutoffMs(menuRow) {
  if (menuRow.posted_at) {
    const ms = Date.parse(menuRow.posted_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (menuRow.message_ts) {
    const ms = parseFloat(menuRow.message_ts) * 1000;
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/**
 * Ảnh mới nhất từ nhà bếp trong group history.
 * @param {unknown[]} groupMsgs
 * @param {string} sourceUserId
 * @param {number | null} minTimeMs null = không lọc thời gian (test mode)
 */
function findLatestKitchenPhoto(groupMsgs, sourceUserId, minTimeMs) {
  let latest = null;
  let latestTs = -1;

  for (const msg of groupMsgs) {
    if (zaloMessageSenderId(msg) !== sourceUserId) continue;
    if (!extractZaloImageUrl(msg)) continue;

    const ts = zaloMessageTimeMs(msg.data?.ts);
    if (minTimeMs != null && ts < minTimeMs) continue;

    if (ts > latestTs) {
      latestTs = ts;
      latest = msg;
    }
  }

  return latest;
}

/**
 * @param {Record<string, string>} config
 * @returns {Promise<{ api: import('zca-js').API; groupId: string } | null>}
 */
async function loginZaloFromConfig(config) {
  const groupId = (config['zalo-group-id'] || '').trim();
  const cookiesRaw = (config['zalo-cookies-json'] || '').trim();
  const imei = (config['zalo-imei'] || '').trim();
  const userAgent = (config['zalo-user-agent'] || '').trim();
  if (!groupId || !cookiesRaw || !imei || !userAgent) return null;

  let cookie;
  try {
    cookie = JSON.parse(cookiesRaw);
  } catch {
    return null;
  }

  const zalo = new Zalo();
  const api = await zalo.login({
    imei,
    cookie,
    userAgent,
    language: (config['zalo-language'] || 'vi').trim() || 'vi',
  });
  return { api, groupId };
}

/**
 * @param {string} url
 * @param {string} [userAgent]
 */
async function downloadImage(url, userAgent) {
  const res = await fetch(url, {
    headers: userAgent ? { 'User-Agent': userAgent } : undefined,
  });
  if (!res.ok) throw new Error(`Image download ${res.status}: ${url.slice(0, 80)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  return { buffer: buf, ext };
}

/**
 * @param {Record<string, string>} config
 */
export async function runFromConfig(config) {
  const tableName = (process.env.TABLE_NAME || '').trim();
  const dishesTableName = (process.env.DISHES_TABLE_NAME || '').trim();
  const botToken = (config['bot-token'] || '').trim();
  const sourceUserId = (config['zalo-menu-source-user-id'] || '').trim();

  if (!sourceUserId) {
    return { skipped: true, reason: 'no_zalo_menu_source_user_id' };
  }
  if (!tableName || !dishesTableName) {
    return { skipped: true, reason: 'missing_table_env' };
  }
  if (!botToken) {
    return { skipped: true, reason: 'no_bot_token' };
  }

  const menu = await getMenuMessageForDate(dynamo, tableName);
  const dishesFromDb = await getDishesMenuForDate(dynamo, dishesTableName);

  let menuRow = menu;
  let dishes = dishesFromDb;

  if (SKIP_MENU_TODAY_CHECK) {
    if (!menuRow?.channel_id || !menuRow?.message_ts) {
      const channelId = (config['channel-id'] || '').trim();
      const messageTs = (config['zalo-menu-test-message-ts'] || '').trim();
      if (!channelId || !messageTs) {
        return { skipped: true, reason: 'test_mode_missing_channel_or_message_ts' };
      }
      menuRow = {
        channel_id: channelId,
        message_ts: messageTs,
        zalo_latest_synced_msg_id: '',
        _testModeNoDynamo: true,
      };
      console.log('Zalo menu images: SKIP_MENU_TODAY_CHECK — using test target', channelId, messageTs);
    }
    if (!dishes?.length) {
      dishes = [{ id: '0', name: '(test menu)' }];
    }
  } else {
    if (!menuRow?.channel_id || !menuRow?.message_ts) {
      return { skipped: true, reason: 'no_menu_today' };
    }
    if (!dishes?.length) {
      return { skipped: true, reason: 'no_dishes_today' };
    }
  }

  const zaloSession = await loginZaloFromConfig(config);
  if (!zaloSession) {
    return { skipped: true, reason: 'incomplete_zalo_config' };
  }

  const { api, groupId } = zaloSession;
  const historyCount = Number.parseInt(config['zalo-menu-history-count'] || '50', 10) || 50;
  const history = await api.getGroupChatHistory(groupId, historyCount);
  const groupMsgs = history?.groupMsgs || [];

  const minTimeMs = SKIP_MENU_TODAY_CHECK ? null : menuPostedCutoffMs(menuRow);
  const latestMsg = findLatestKitchenPhoto(groupMsgs, sourceUserId, minTimeMs);

  if (!latestMsg) {
    console.log('Zalo menu images: no photo from', sourceUserId, minTimeMs != null ? `after ${minTimeMs}` : '(no time filter)');
    return { ok: true, new_images: 0 };
  }

  const latestKey = zaloMessageKey(latestMsg);
  const lastSynced = (menuRow.zalo_latest_synced_msg_id || '').trim();
  if (latestKey && latestKey === lastSynced) {
    console.log('Zalo menu images: latest photo already synced', latestKey);
    return { ok: true, new_images: 0, zalo_msg_id: latestKey, already_synced: true };
  }

  const imageUrl = extractZaloImageUrl(latestMsg);
  if (!imageUrl || !latestKey) {
    return { ok: true, new_images: 0, reason: 'latest_msg_no_image_url' };
  }

  const userAgent = (config['zalo-user-agent'] || '').trim();

  let fileId;
  try {
    const { buffer, ext } = await downloadImage(imageUrl, userAgent);
    fileId = await uploadImageBufferToSlack(
      botToken,
      buffer,
      `zalo-menu-${dateKeyGmt7()}-latest.${ext}`
    );
    console.log('Zalo menu images: synced latest', latestKey, '→ Slack file', fileId);
  } catch (err) {
    console.warn('Zalo menu images: failed for latest msg', latestKey, err?.message || err);
    throw err;
  }

  const blocks = buildMenuSlackBlocks(dishes, [fileId]);
  const text = buildMenuSlackTextFallback(dishes);

  await updateSlackMenuMessage(botToken, menuRow.channel_id, menuRow.message_ts, blocks, text);

  if (!menuRow._testModeNoDynamo) {
    await setMenuLatestImageSyncState(dynamo, tableName, {
      slackImageFileId: fileId,
      zaloMsgId: latestKey,
    });
  } else {
    console.log('Zalo menu images: test mode — skipped DynamoDB sync state update');
  }

  return {
    ok: true,
    new_images: 1,
    zalo_msg_id: latestKey,
    channel_id: menuRow.channel_id,
    message_ts: menuRow.message_ts,
    test_mode: !!SKIP_MENU_TODAY_CHECK,
  };
}
