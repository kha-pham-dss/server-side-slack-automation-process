/**
 * PostMenu Lambda (10:15 GMT+7 Mon–Fri).
 * Fetches dishes from latest message in DM with menu source user
 * (text: mỗi dòng một món; ảnh: Gemini đọc món → chọn ≤ MAX_DISHES theo lịch sử đặt),
 * posts menu to Slack channel (chỉ text, không nhúng ảnh),
 * stores message_ts + dish list + DM thread ref in DynamoDB.
 * On DM "Bỏ qua hôm nay": no Slack post, no DynamoDB rows.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import { CACHE_TTL_MS, POST_MENU_REACTION_DELAY_MS } from '@slack-dishes/shared/time-constants.js';
import { putDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import { putMenuMessageForDate } from '@slack-dishes/shared/dynamo-menu.js';
import { DISH_EMOJI_NAMES, MAX_DISHES, UP_EMOJI } from '@slack-dishes/shared/meal-constants.js';
import {
  buildMenuSlackBlocks,
  buildMenuSlackTextFallback,
} from '@slack-dishes/shared/menu-slack.js';
import {
  downloadSlackImage,
  fetchLatestMenuDmSource,
  MENU_DM_USER_ID_DEFAULT,
  replyInDmThread,
} from '@slack-dishes/shared/menu-dm.js';
import { loadDishPopularity } from '@slack-dishes/shared/dish-popularity.js';
import { selectMenuDishes } from '@slack-dishes/shared/menu-selection.js';
import { DEFAULT_MENU_VISION_MODELS, extractMenuDishesFromImages } from '@slack-dishes/shared/menu-vision.js';

const dynamo = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME;
const DISHES_TABLE_NAME = process.env.DISHES_TABLE_NAME;
const DISH_POPULARITY_TABLE_NAME = process.env.DISH_POPULARITY_TABLE_NAME;

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

/** Lịch sử chỉ để xếp hạng — lỗi đọc thì coi như chưa có lịch sử, vẫn post menu. */
async function loadDishPopularityOrEmpty() {
  if (!DISH_POPULARITY_TABLE_NAME) return new Map();
  try {
    return await loadDishPopularity(dynamo, DISH_POPULARITY_TABLE_NAME);
  } catch (err) {
    console.warn('PostMenu: dish popularity load failed; ranking without history', err?.message || err);
    return new Map();
  }
}

function menuVisionModels(config) {
  const fromConfig = String(config['menu-vision-models'] || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return fromConfig.length ? fromConfig : DEFAULT_MENU_VISION_MODELS;
}

async function buildDishesFromMenuImages(config, botToken, dmChannelId, dmParentTs, imageFiles) {
  try {
    const popularity = await loadDishPopularityOrEmpty();
    const images = await Promise.all(imageFiles.map((f) => downloadSlackImage(botToken, f)));
    const { model, dishes: candidates } = await extractMenuDishesFromImages({
      apiKey: config['gemini-api-key'],
      images,
      models: menuVisionModels(config),
      knownDishNames: [...popularity.values()].map((p) => p.name),
    });
    const { selected, dropped } = selectMenuDishes(candidates, popularity);
    console.log('PostMenu: menu vision', { model, candidates: candidates.length, selected: selected.length, dropped });
    await replyInDmThread(
      botToken,
      dmChannelId,
      dmParentTs,
      [
        `Đọc được ${candidates.length} món từ ${images.length} ảnh (${model}), lên menu ${selected.length} món.`,
        dropped.length ? `Không lên menu: ${dropped.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return selected.map((d, i) => ({ id: String(i), name: d.name }));
  } catch (err) {
    await replyInDmThread(
      botToken,
      dmChannelId,
      dmParentTs,
      `Không đọc được menu từ ảnh: ${String(err?.message || err).slice(0, 300)}\n` +
        'Gửi menu dạng text (mỗi dòng một món) rồi invoke lại PostMenu.'
    );
    throw err;
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

    const { channelId: dmChannelId, parentTs: dmParentTs, imageFiles } = dmSource;
    let { dishes } = dmSource;
    if (imageFiles?.length) {
      dishes = await buildDishesFromMenuImages(config, botToken, dmChannelId, dmParentTs, imageFiles);
    } else if (!dishes.length) {
      throw new Error('No dishes parsed from latest DM message');
    }
    const blocks = buildMenuSlackBlocks(dishes);
    const text = buildMenuSlackTextFallback(dishes);
    const shownCount = Math.min(dishes.length, MAX_DISHES);

    const { channel_id, message_ts } = await postToSlack(config, blocks, text);

    await putDishesMenuForDate(dynamo, DISHES_TABLE_NAME, dishes);
    await putMenuMessageForDate(dynamo, TABLE_NAME, {
      channelId: channel_id,
      messageTs: message_ts,
      dishCount: shownCount,
      menuDmChannelId: dmChannelId,
      menuDmParentTs: dmParentTs,
      // Members order by reaction only; marking images synced keeps slack-events / menu-images-sync from re-adding photos.
      imagesSyncComplete: true,
    });

    if (botToken) {
      const reactionNames = [...DISH_EMOJI_NAMES.slice(0, shownCount), UP_EMOJI];
      await addReactionsToMessage(botToken, channel_id, message_ts, reactionNames);
    }

    console.log('Posted menu', channel_id, message_ts);
    return {
      ok: true,
      channel_id,
      message_ts,
      dish_count: shownCount,
    };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
