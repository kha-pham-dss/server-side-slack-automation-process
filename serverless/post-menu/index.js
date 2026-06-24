/**
 * PostMenu Lambda (9:30 GMT+7 Mon–Fri).
 * Fetches dishes from latest message in DM with menu source user,
 * posts menu to Slack channel (ảnh có thể thêm sau qua menu-images-sync),
 * stores message_ts + dish list + DM thread ref in DynamoDB.
 * On DM "Bỏ qua hôm nay": no Slack post, no DynamoDB rows.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import { CACHE_TTL_MS, POST_MENU_REACTION_DELAY_MS } from '@slack-dishes/shared/time-constants.js';
import { putDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import { putMenuMessageForDate } from '@slack-dishes/shared/dynamo-menu.js';
import { DISH_EMOJI_NAMES, MAX_DISHES } from '@slack-dishes/shared/meal-constants.js';
import {
  buildMenuSlackBlocks,
  buildMenuSlackTextFallback,
} from '@slack-dishes/shared/menu-slack.js';
import {
  fetchImageFileIdsFromDmThread,
  fetchLatestMenuDmSource,
  MENU_DM_USER_ID_DEFAULT,
} from '@slack-dishes/shared/menu-dm.js';

const dynamo = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME;
const DISHES_TABLE_NAME = process.env.DISHES_TABLE_NAME;

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

async function postToSlack(config, blocks, text) {
  const channelId = config['channel-id'];
  const botToken = config['bot-token'];
  if (!botToken) throw new Error('Missing bot-token (required for menu post + later image update)');

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: channelId,
      blocks,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error ?? res.status}`);
  return {
    channel_id: data.channel ?? channelId,
    message_ts: data.ts ?? String(Date.now() / 1000),
  };
}

async function addReactionsToMessage(botToken, channelId, messageTs, emojiNames) {
  for (let i = 0; i < emojiNames.length; i++) {
    const name = emojiNames[i];
    const res = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: channelId,
        timestamp: messageTs,
        name,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('reactions.add failed for', name, data.error);
    }
    if (i > 0) await new Promise((r) => setTimeout(r, POST_MENU_REACTION_DELAY_MS));
  }
}

export async function handler(event) {
  console.log('PostMenu invoked', JSON.stringify(event?.detail ?? event));

  try {
    const config = await getConfig();
    const botToken = config['bot-token'];
    if (!botToken) throw new Error('Missing bot-token in Parameter Store (required to read menu from DM)');
    if (!DISHES_TABLE_NAME) throw new Error('DISHES_TABLE_NAME not set');
    if (!TABLE_NAME) throw new Error('TABLE_NAME not set');

    const menuDmUserId = config['menu-dm-user-id'] || MENU_DM_USER_ID_DEFAULT;
    const dmSource = await fetchLatestMenuDmSource(botToken, menuDmUserId);
    if (dmSource === null) {
      console.log('PostMenu: DM is skip text; no channel post or DynamoDB');
      return { ok: true, skipped: true, reason: 'skip_today_dm' };
    }

    const { channelId: dmChannelId, parentTs: dmParentTs, dishes } = dmSource;
    if (!dishes.length) throw new Error('No dishes parsed from latest DM message');

    const imageFileIds = await fetchImageFileIdsFromDmThread(botToken, dmChannelId, dmParentTs);
    const blocks = buildMenuSlackBlocks(dishes, imageFileIds);
    const text = buildMenuSlackTextFallback(dishes);
    const shownCount = Math.min(dishes.length, MAX_DISHES);

    if (imageFileIds.length) {
      console.log('PostMenu: embedding', imageFileIds.length, 'image(s) from DM thread');
    } else {
      console.log('PostMenu: no DM images yet; menu-images-sync will poll thread');
    }

    const { channel_id, message_ts } = await postToSlack(config, blocks, text);

    await putDishesMenuForDate(dynamo, DISHES_TABLE_NAME, dishes);
    await putMenuMessageForDate(dynamo, TABLE_NAME, {
      channelId: channel_id,
      messageTs: message_ts,
      dishCount: shownCount,
      menuDmChannelId: dmChannelId,
      menuDmParentTs: dmParentTs,
      slackImageFileIds: imageFileIds,
      imagesSyncComplete: imageFileIds.length > 0,
    });

    if (botToken) {
      const reactionNames = [...DISH_EMOJI_NAMES.slice(0, shownCount), 'up'];
      await addReactionsToMessage(botToken, channel_id, message_ts, reactionNames);
    }

    console.log('Posted menu', channel_id, message_ts, 'images', imageFileIds.length);
    return {
      ok: true,
      channel_id,
      message_ts,
      dish_count: shownCount,
      image_count: imageFileIds.length,
      images_sync_complete: imageFileIds.length > 0,
    };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
