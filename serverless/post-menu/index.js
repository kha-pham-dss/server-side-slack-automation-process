/**
 * PostMenu Lambda (9:30 UTC).
 * Fetches dishes from API, posts to Slack, stores message_ts in DynamoDB.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const ssm = new SSMClient();
const dynamo = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME;
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  const cmd = new GetParametersByPathCommand({
    Path: PARAMETER_PREFIX,
    Recursive: true,
    WithDecryption: true,
  });
  const res = await ssm.send(cmd);
  const map = {};
  for (const p of res.Parameters || []) {
    const name = p.Name?.replace(PARAMETER_PREFIX + '/', '') || '';
    if (name && p.Value) map[name] = p.Value;
  }
  configCache = map;
  configCacheTime = Date.now();
  return map;
}

/**
 * GET dishes API → { dishes: [ { id: "0", name: "Dish A" }, ... ] }
 */
async function fetchDishes(dishesApiUrl) {
  const res = await fetch(dishesApiUrl);
  if (!res.ok) throw new Error(`Dishes API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const dishes = data.dishes ?? [];
  return Array.isArray(dishes) ? dishes : [];
}

function buildSlackBlocks(dishes) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: "Today's menu", emoji: true } },
    { type: 'divider' },
  ];
  for (let i = 0; i < dishes.length; i++) {
    const d = dishes[i];
    const name = typeof d === 'object' && d != null && 'name' in d ? d.name : String(d);
    const emoji = `number${i}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `React with :${emoji}: for *${name}*`,
      },
    });
  }
  return blocks;
}

function buildSlackTextFallback(dishes) {
  return "Today's menu: " + dishes.map((d, i) => (typeof d === 'object' && d?.name ? d.name : d)).join(', ');
}

/**
 * Post to Slack via webhook or chat.postMessage.
 * Returns { channel_id, message_ts } (from response or from config for webhook).
 */
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

/**
 * Store today's menu message in DynamoDB.
 */
function dateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
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
    const dishesApiUrl = config['dishes-api-url'];
    if (!dishesApiUrl) throw new Error('Missing dishes-api-url in Parameter Store');

    const dishes = await fetchDishes(dishesApiUrl);
    const blocks = buildSlackBlocks(dishes);
    const text = buildSlackTextFallback(dishes);

    const { channel_id, message_ts } = await postToSlack(config, blocks, text);
    await storeMenuMessage(channel_id, message_ts, dishes.length);

    console.log('Posted menu to channel', channel_id, 'message_ts', message_ts);
    return { ok: true, channel_id, message_ts, dish_count: dishes.length };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
