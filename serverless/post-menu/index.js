/**
 * PostMenu Lambda (9:30 UTC).
 * Fetches dishes from Google Sheet (dish-range), posts to Slack, stores message_ts in DynamoDB.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { google } from 'googleapis';

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

function getSheetsClient(credentialsJson) {
  const cred = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Read dishes from Google Sheet (specific sheet tab + range, e.g. N4:N8).
 * Returns [ { id: "0", name: "Dish A" }, ... ] (id = 0-based index).
 */
async function fetchDishesFromSheet(sheets, spreadsheetId, sheetName, rangeSpec) {
  const quoted = /[\s']/.test(sheetName) ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  const range = `${quoted}!${rangeSpec}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = res.data.values || [];
  const dishes = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = row?.[0] != null ? String(row[0]).trim() : '';
    if (!name) continue;
    dishes.push({ id: String(i), name });
  }
  return dishes;
}

const DIGIT_EMOJI = ['one', 'two', 'three', 'four', 'five', 'six'];
const MAX_DISHES = 6;

function buildSlackBlocks(dishes) {
  const shown = dishes.slice(0, MAX_DISHES);
  const menuLines = shown.map((d, i) => {
    const name = typeof d === 'object' && d != null && 'name' in d ? d.name : String(d);
    const emoji = DIGIT_EMOJI[i];
    return `:${emoji}: (${name})`;
  });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Thực đơn hôm nay:', emoji: true } },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: menuLines.join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':up: để upsize lên 40k',
      },
    },
  ];
  return blocks;
}

function buildSlackTextFallback(dishes) {
  return 'Thực đơn hôm nay: ' + dishes.map((d, i) => (typeof d === 'object' && d?.name ? d.name : d)).join(', ') + ' — :up: để upsize lên 40k';
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
 * Thêm reaction vào message (cần bot token + scope reactions:write).
 * emojiNames: ['one', 'two', ..., 'up'] (không có dấu hai chấm).
 */
async function addReactionsToMessage(botToken, channelId, messageTs, emojiNames) {
  for (const name of emojiNames) {
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
  }
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
    let dishes;

    const sheetId = config['sheet-id'];
    const credentials = config['sheet-credentials'];
    if (sheetId && credentials) {
      const sheetName = config['dishes-sheet-name'] || 'Dishes';
      const dishesRange = config['dishes-range'] || 'N3:N8';
      const sheets = getSheetsClient(credentials);
      dishes = await fetchDishesFromSheet(sheets, sheetId, sheetName, dishesRange);
    } else {
      throw new Error('Missing sheet-id or sheet-credentials in Parameter Store');
    }
    const blocks = buildSlackBlocks(dishes);
    const text = buildSlackTextFallback(dishes);
    const shownCount = Math.min(dishes.length, MAX_DISHES);

    const { channel_id, message_ts } = await postToSlack(config, blocks, text);
    await storeMenuMessage(channel_id, message_ts, shownCount);

    const botToken = config['bot-token'];
    if (botToken) {
      const reactionNames = [...DIGIT_EMOJI.slice(0, shownCount), 'up'];
      await addReactionsToMessage(botToken, channel_id, message_ts, reactionNames);
    }

    console.log('Posted menu to channel', channel_id, 'message_ts', message_ts);
    return { ok: true, channel_id, message_ts, dish_count: shownCount };
  } catch (err) {
    console.error('PostMenu error:', err);
    throw err;
  }
}
