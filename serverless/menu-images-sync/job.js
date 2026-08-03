/**
 * Poll DM thread (menu source user) mỗi 10 phút: khi có ảnh → chat.update menu channel, dừng poll.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import { getMenuMessageForDate, setMenuImagesSynced } from '@slack-dishes/shared/dynamo-menu.js';
import {
  buildMenuSlackBlocks,
  buildMenuSlackTextFallback,
  updateSlackMenuMessage,
} from '@slack-dishes/shared/menu-slack.js';
import {
  fetchImageFileIdsFromDmThread,
  fetchLatestMenuDmSource,
  MENU_DM_USER_ID_DEFAULT,
} from '@slack-dishes/shared/menu-dm.js';

const dynamo = new DynamoDBClient();

/** true = log file ids only, không chat.update. Đổi false trước prod. */
export const TEST_MODE = false;

export function isTestMode() {
  return TEST_MODE;
}

function sameFileIds(a, b) {
  const left = [...(a || [])].sort();
  const right = [...(b || [])].sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * @param {Record<string, string>} config
 */
export async function runFromConfig(config) {
  const testMode = isTestMode();
  const tableName = (process.env.TABLE_NAME || '').trim();
  const dishesTableName = (process.env.DISHES_TABLE_NAME || '').trim();
  const botToken = (config['bot-token'] || '').trim();
  const menuDmUserId = config['menu-dm-user-id'] || MENU_DM_USER_ID_DEFAULT;

  if (!botToken) return { skipped: true, reason: 'no_bot_token' };
  if (!testMode && (!tableName || !dishesTableName)) {
    return { skipped: true, reason: 'missing_table_env' };
  }

  const menu = testMode ? null : await getMenuMessageForDate(dynamo, tableName);
  if (!testMode) {
    if (!menu?.channel_id || !menu?.message_ts) {
      return { skipped: true, reason: 'no_menu_today' };
    }
    if (menu.images_sync_complete) {
      return { skipped: true, reason: 'images_already_synced' };
    }
  }

  const dishes = testMode
    ? [{ id: '0', name: '(test)' }]
    : await getDishesMenuForDate(dynamo, dishesTableName);
  if (!testMode && !dishes?.length) {
    return { skipped: true, reason: 'no_dishes_today' };
  }

  let dmChannelId = menu?.menu_dm_channel_id;
  let dmParentTs = menu?.menu_dm_parent_ts;

  if (!dmChannelId || !dmParentTs) {
    const dmSource = await fetchLatestMenuDmSource(botToken, menuDmUserId);
    if (!dmSource) return { skipped: true, reason: 'skip_today_dm' };
    dmChannelId = dmSource.channelId;
    dmParentTs = dmSource.parentTs;
  }

  const imageFileIds = await fetchImageFileIdsFromDmThread(botToken, dmChannelId, dmParentTs);
  if (!imageFileIds.length) {
    console.log('MenuImagesSync: no images in DM thread yet', dmParentTs);
    return { ok: true, new_images: 0, dm_parent_ts: dmParentTs };
  }

  const existing = menu?.slack_image_file_ids || [];
  if (!testMode && sameFileIds(imageFileIds, existing)) {
    console.log('MenuImagesSync: images unchanged, marking complete');
    await setMenuImagesSynced(dynamo, tableName, imageFileIds);
    return { ok: true, new_images: 0, already_synced: true, image_file_ids: imageFileIds };
  }

  console.log('MenuImagesSync: found', imageFileIds.length, 'image(s)', imageFileIds);

  if (testMode) {
    return {
      ok: true,
      test_mode: true,
      dry_run: true,
      dm_channel_id: dmChannelId,
      dm_parent_ts: dmParentTs,
      image_file_ids: imageFileIds,
    };
  }

  const blocks = buildMenuSlackBlocks(dishes, imageFileIds);
  const text = buildMenuSlackTextFallback(dishes);

  await updateSlackMenuMessage(botToken, menu.channel_id, menu.message_ts, blocks, text);
  await setMenuImagesSynced(dynamo, tableName, imageFileIds);

  return {
    ok: true,
    new_images: imageFileIds.length,
    image_file_ids: imageFileIds,
    channel_id: menu.channel_id,
    message_ts: menu.message_ts,
    images_sync_complete: true,
  };
}
