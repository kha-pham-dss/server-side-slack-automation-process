/**
 * PostMenu Lambda (10:00 GMT+7 Mon–Fri).
 * Fetches dishes from latest message in DM with menu source user (skip first line; rest = dish names),
 * posts menu to Slack channel, stores message_ts + dish list in DynamoDB.
 * On DM "Bỏ qua hôm nay": no Slack post, no DynamoDB rows.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { CACHE_TTL_MS, POST_MENU_REACTION_DELAY_MS, dateKeyGmt7 } from '@slack-dishes/shared/time-constants.js';
import { putDishesMenuForDate } from '@slack-dishes/shared/dynamo-dishes.js';
import { MAX_DISHES, DISH_EMOJI_NAMES } from '@slack-dishes/shared/meal-constants.js';
import { splitDishesIntoColumns, formatDishColumnText } from '@slack-dishes/shared/orders.js';

const ssm = new SSMClient();
const dynamo = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME;
const DISHES_TABLE_NAME = process.env.DISHES_TABLE_NAME;
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;

async function loadAllParametersByPath() {
  const pathPrefix = PARAMETER_PREFIX.endsWith('/') ? PARAMETER_PREFIX.slice(0, -1) : PARAMETER_PREFIX;
  const namePrefix = `${pathPrefix}/`;
  const map = {};
  let nextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: pathPrefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
        MaxResults: 10,
      })
    );
    for (const p of res.Parameters || []) {
      const name = p.Name?.replace(namePrefix, '') || '';
      if (name && p.Value != null && p.Value !== '') map[name] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return map;
}

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  configCache = await loadAllParametersByPath();
  configCacheTime = Date.now();
  return configCache;
}

const MENU_DM_USER_ID_DEFAULT = 'U02SJRNAM2M';

/** Nội dung DM đúng chuỗi này → không đăng menu, không ghi DynamoDB. */
const SKIP_TODAY_DM_TEXT = 'Bỏ qua hôm nay';

/**
 * Get latest message from DM with the given user and parse dishes.
 * Message format: first line = title (e.g. "Thực đơn ngày mai 12/1"), skip; next lines = dish names.
 * Returns [ { id: "0", name: "Dish A" }, ... ] (id = 0-based index), or null if DM is {@link SKIP_TODAY_DM_TEXT}.
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
    {
      headers: { Authorization: `Bearer ${botToken}` },
    }
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
  const dishNames = lines.slice(1);
  return dishNames.map((name, i) => ({ id: String(i), name }));
}

function buildSlackBlocks(dishes) {
  const shown = dishes.slice(0, MAX_DISHES);
  const columns = splitDishesIntoColumns(shown);
  let dishStartIndex = 0;
  const fields = columns.map((col) => {
    const text = formatDishColumnText(col, dishStartIndex, DISH_EMOJI_NAMES);
    dishStartIndex += col.length;
    return { type: 'mrkdwn', text };
  });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Thực đơn hôm nay:', emoji: true } },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '4 món + 1 rau => 30k',
          '5 món + 1 rau => 35k',
          'Mặc định 30k, có thể react ít hơn 4 món, nhà bếp sẽ tự thêm các món còn lại.',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    { type: 'section', fields },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':up: để upsize lên 35k' },
    },
  ];
  return blocks;
}

function buildSlackTextFallback(dishes) {
  const names = dishes
    .slice(0, MAX_DISHES)
    .map((d) => (typeof d === 'object' && d?.name ? d.name : d))
    .join(', ');
  return `Thực đơn hôm nay: ${names} — :up: để upsize lên 35k`;
}

async function postToSlack(config, blocks, text) {
  const webhookUrl = config['webhook-url'];
  const channelId = config['channel-id'];
  const botToken = config['bot-token'];

  const body = { blocks, text };

  if (webhookUrl && webhookUrl.trim()) {
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

function dateKey() {
  return dateKeyGmt7();
}

async function storeMenuMessage(channelId, messageTs, dishCount) {
  const date = dateKey();
  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall({
        date,
        channel_id: channelId,
        message_ts: messageTs,
        dish_count: dishCount,
      }),
    })
  );
}

export async function handler(event) {
  console.log('PostMenu invoked', JSON.stringify(event?.detail ?? event));

  try {
    const config = await getConfig();
    const botToken = config['bot-token'];
    if (!botToken) throw new Error('Missing bot-token in Parameter Store (required to read menu from DM)');
    if (!DISHES_TABLE_NAME) throw new Error('DISHES_TABLE_NAME not set');

    const menuDmUserId = config['menu-dm-user-id'] || MENU_DM_USER_ID_DEFAULT;
    const dishes = await fetchDishesFromSlackDM(botToken, menuDmUserId);
    if (dishes === null) {
      console.log(
        'PostMenu: DM is "%s"; skipping channel post and DynamoDB (collect-orders / Zalo will skip)',
        SKIP_TODAY_DM_TEXT
      );
      return { ok: true, skipped: true, reason: 'skip_today_dm' };
    }
    if (!dishes.length) throw new Error('No dishes parsed from latest DM message');

    const blocks = buildSlackBlocks(dishes);
    const text = buildSlackTextFallback(dishes);
    const shownCount = Math.min(dishes.length, MAX_DISHES);

    const { channel_id, message_ts } = await postToSlack(config, blocks, text);

    await putDishesMenuForDate(dynamo, DISHES_TABLE_NAME, dishes);
    await storeMenuMessage(channel_id, message_ts, shownCount);

    if (botToken) {
      const reactionNames = [...DISH_EMOJI_NAMES.slice(0, shownCount), 'up'];
      await addReactionsToMessage(botToken, channel_id, message_ts, reactionNames);
    }

    console.log('Posted menu to channel', channel_id, 'message_ts', message_ts, 'dishes saved to DynamoDB');
    return { ok: true, channel_id, message_ts, dish_count: shownCount };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
