/**
 * PostMenu Lambda (10:00 GMT+7 Mon–Fri).
 * Fetches dishes from latest message in DM with menu source user (every non-empty line = dish name),
 * images from thread replies under that DM message (or later via Zalo group poll),
 * posts menu to Slack channel, stores message_ts + dish list in DynamoDB.
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
  menuBlocksNeedBotToken,
} from '@slack-dishes/shared/menu-slack.js';

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

const MENU_DM_USER_ID_DEFAULT = 'U02SJRNAM2M';

/** Nội dung DM đúng chuỗi này → không đăng menu, không ghi DynamoDB. */
const SKIP_TODAY_DM_TEXT = 'Bỏ qua hôm nay';

/**
 * Image file IDs from thread replies under the menu DM message (not the parent message itself).
 * @param {string} botToken
 * @param {string} dmChannelId
 * @param {string} parentTs
 * @returns {Promise<string[]>}
 */
async function fetchImageFileIdsFromDmThread(botToken, dmChannelId, parentTs) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(dmChannelId)}&ts=${encodeURIComponent(parentTs)}&limit=100`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const data = await res.json();
  if (!data.ok) {
    console.warn('PostMenu: conversations.replies failed', data.error);
    return [];
  }

  const fileIds = [];
  for (const msg of (data.messages || []).slice(1)) {
    for (const f of msg.files || []) {
      if (f.mimetype?.startsWith('image/') && f.id) fileIds.push(f.id);
    }
  }
  return fileIds;
}

/**
 * Get latest message from DM with the given user and parse dishes + thread images.
 * @returns {{ dishes: { id: string, name: string }[], imageFileIds: string[] } | null}
 */
async function fetchDishesFromSlackDM(botToken, userId) {
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openRes.json();
  if (!openData.ok) throw new Error(`Slack conversations.open error: ${openData.error ?? openRes.status}`);
  const channelId = openData.channel?.id;
  if (!channelId) throw new Error('Slack conversations.open did not return channel id');

  const histRes = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=1`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const histData = await histRes.json();
  if (!histData.ok) throw new Error(`Slack conversations.history error: ${histData.error ?? histRes.status}`);
  const messages = histData.messages || [];
  const latest = messages[0];
  if (!latest?.text) throw new Error('No message or empty text in DM with menu source user');

  if (latest.text.trim() === SKIP_TODAY_DM_TEXT) {
    return null;
  }

  const lines = latest.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const imageFileIds = await fetchImageFileIdsFromDmThread(botToken, channelId, latest.ts);
  return {
    dishes: lines.map((name, i) => ({ id: String(i), name })),
    imageFileIds,
  };
}

async function postToSlack(config, blocks, text, forceBotPost = false) {
  const webhookUrl = config['webhook-url'];
  const channelId = config['channel-id'];
  const botToken = config['bot-token'];

  const body = { blocks, text };
  const useBot = forceBotPost || menuBlocksNeedBotToken(blocks);

  if (webhookUrl && webhookUrl.trim() && !useBot) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack webhook error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return {
      channel_id: data.channel ?? channelId,
      message_ts: data.ts ?? data.message?.ts ?? String(Date.now() / 1000),
    };
  }

  if (!botToken) throw new Error('Missing bot-token and webhook-url in config');
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      channel: channelId,
      blocks: body.blocks,
      text: body.text,
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
    const zaloImageSyncEnabled = !!(config['zalo-menu-source-user-id'] || '').trim();

    const menuSource = await fetchDishesFromSlackDM(botToken, menuDmUserId);
    if (menuSource === null) {
      console.log(
        'PostMenu: DM is "%s"; skipping channel post and DynamoDB (collect-orders / Zalo will skip)',
        SKIP_TODAY_DM_TEXT
      );
      return { ok: true, skipped: true, reason: 'skip_today_dm' };
    }

    const { dishes, imageFileIds } = menuSource;
    if (!dishes.length) throw new Error('No dishes parsed from latest DM message');

    const blocks = buildMenuSlackBlocks(dishes, imageFileIds);
    const text = buildMenuSlackTextFallback(dishes);
    const shownCount = Math.min(dishes.length, MAX_DISHES);

    if (imageFileIds.length) {
      console.log('PostMenu: embedding', imageFileIds.length, 'image(s) from DM thread');
    } else if (zaloImageSyncEnabled) {
      console.log('PostMenu: no DM images yet; Zalo group poll will update menu later');
    }

    const { channel_id, message_ts } = await postToSlack(config, blocks, text, zaloImageSyncEnabled);

    await putDishesMenuForDate(dynamo, DISHES_TABLE_NAME, dishes);
    await putMenuMessageForDate(dynamo, TABLE_NAME, {
      channelId: channel_id,
      messageTs: message_ts,
      dishCount: shownCount,
    });

    if (botToken) {
      const reactionNames = [...DISH_EMOJI_NAMES.slice(0, shownCount), 'up'];
      await addReactionsToMessage(botToken, channel_id, message_ts, reactionNames);
    }

    console.log(
      'Posted menu to channel',
      channel_id,
      'message_ts',
      message_ts,
      'dishes saved to DynamoDB',
      'images',
      imageFileIds.length,
      'zalo_poll',
      zaloImageSyncEnabled
    );
    return {
      ok: true,
      channel_id,
      message_ts,
      dish_count: shownCount,
      image_count: imageFileIds.length,
      zalo_image_poll: zaloImageSyncEnabled,
    };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
