/**
 * CollectOrders Lambda (10:20 UTC) – Option A.
 * Reads today's menu message from DynamoDB, calls Slack reactions.get, aggregates, POSTs to order API.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

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

function dateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

async function getTodayMenuMessage() {
  const date = dateKey();
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { date: { S: date } },
    })
  );
  if (!res.Item) return null;
  return unmarshall(res.Item);
}

/**
 * Slack API reactions.get → aggregate by emoji (number0, number1, ...) → user_ids.
 */
async function getReactions(botToken, channelId, messageTs) {
  const url = new URL('https://slack.com/api/reactions.get');
  url.searchParams.set('channel', channelId);
  url.searchParams.set('timestamp', messageTs);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack reactions.get error: ${data.error ?? res.status}`);

  const message = data.message;
  const reactions = message?.reactions ?? [];
  /** @type {Array<{ emoji: string; user_ids: string[] }>} */
  const orders = [];
  for (const r of reactions) {
    const name = r.name;
    if (typeof name !== 'string' || !name.startsWith('number')) continue;
    const num = parseInt(name.replace('number', ''), 10);
    if (Number.isNaN(num) || num < 0) continue;
    const users = r.users ?? [];
    orders.push({ emoji: name, dish_index: num, user_ids: users });
  }
  return orders;
}

/**
 * POST to ordering API: { message_ts, orders: [ { dish_index, emoji, user_ids }, ... ] }
 */
async function postOrders(orderApiUrl, messageTs, orders) {
  const body = JSON.stringify({ message_ts: messageTs, orders });
  const res = await fetch(orderApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`Order API error: ${res.status} ${await res.text()}`);
}

export async function handler(event) {
  console.log('CollectOrders invoked', JSON.stringify(event?.detail ?? event));

  try {
    const config = await getConfig();
    const botToken = config['bot-token'];
    const orderApiUrl = config['order-api-url'];
    if (!botToken) throw new Error('Missing bot-token in Parameter Store');
    if (!orderApiUrl) throw new Error('Missing order-api-url in Parameter Store');

    const menu = await getTodayMenuMessage();
    if (!menu) {
      console.warn('No menu message for today; skipping order collection');
      return { ok: true, skipped: true, reason: 'no_menu_today' };
    }

    const { channel_id, message_ts, dish_count } = menu;
    const orders = await getReactions(botToken, channel_id, message_ts);
    await postOrders(orderApiUrl, message_ts, orders);

    console.log('Collected orders:', orders.length, 'emoji groups, posted to order API');
    return { ok: true, message_ts, order_count: orders.length };
  } catch (err) {
    console.error('CollectOrders error:', err);
    throw err;
  }
}
