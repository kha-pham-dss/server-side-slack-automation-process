/**
 * Slack Events API endpoint (Lambda Function URL).
 * - url_verification: return challenge.
 * - Reply trong thread menu + @Mr.Chef → CollectOrders (sheet + :white_check_mark: trên reply).
 * - Cùng luồng đó nhưng sau 11:00 GMT+7 → collect-orders cập nhật sheet + ping RECONCILE_NOTIFY_SLACK_USER_ID kèm món user đặt.
 */

import crypto from 'crypto';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  CACHE_TTL_MS,
  SLACK_SIGNATURE_MAX_AGE_SEC,
  dateKeyGmt7,
  isAfterZaloSummaryCutoffNow,
} from '@slack-dishes/shared/time-constants.js';

const dynamo = new DynamoDBClient();
const lambda = new LambdaClient();
const ssm = new SSMClient();

const TABLE_NAME = process.env.TABLE_NAME;
const COLLECT_ORDERS_FUNCTION_NAME = process.env.COLLECT_ORDERS_FUNCTION_NAME;
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {{ value: string | null | undefined; at: number }} */
let mrChefUserIdCache = { value: undefined, at: 0 };

function messageMentionsSlackUser(text, slackUserId) {
  if (!text || !slackUserId) return false;
  // Slack: <@U123> or <@U123|display name>
  return text.includes(`<@${slackUserId}`);
}

async function getMrChefSlackUserId() {
  const fromEnv = (process.env.MR_CHEF_SLACK_USER_ID || '').trim();
  if (fromEnv) return fromEnv;

  if (Date.now() - mrChefUserIdCache.at < CACHE_TTL_MS && mrChefUserIdCache.value !== undefined) {
    return mrChefUserIdCache.value;
  }

  try {
    const res = await ssm.send(
      new GetParameterCommand({
        Name: `${PARAMETER_PREFIX}/mr-chef-user-id`,
        WithDecryption: false,
      })
    );
    const v = (res.Parameter?.Value ?? '').trim();
    const id = v || null;
    mrChefUserIdCache = { value: id, at: Date.now() };
    return id;
  } catch (e) {
    if (e?.name === 'ParameterNotFound') {
      mrChefUserIdCache = { value: null, at: Date.now() };
      return null;
    }
    throw e;
  }
}

function dateKey() {
  return dateKeyGmt7();
}

/** So khớp ts menu (DynamoDB) với reaction item.ts dù Slack khác độ chính xác chuỗi. */
function normalizeSlackTs(ts) {
  if (ts == null || ts === '') return '';
  const n = parseFloat(String(ts));
  return Number.isFinite(n) ? n.toFixed(6) : String(ts).trim();
}

function isReplyUnderTodayMenu(channel, threadTs, menu) {
  if (!menu) return false;
  if (String(channel || '').trim() !== String(menu.channel_id || '').trim()) return false;
  return normalizeSlackTs(threadTs) === normalizeSlackTs(menu.message_ts);
}

async function getSigningSecret() {
  const res = await ssm.send(
    new GetParameterCommand({
      Name: `${PARAMETER_PREFIX}/signing-secret`,
      WithDecryption: true,
    })
  );
  return res.Parameter?.Value ?? '';
}

function verifySlackSignature(rawBody, signature, timestamp, signingSecret) {
  if (!signingSecret || !signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_SEC) return false;
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(sigBasestring);
  const mySig = 'v0=' + hmac.digest('hex');
  const a = Buffer.from(mySig, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
 * Invoke CollectOrders with payload so it adds reaction to the reply and does not post schedule message.
 */
async function invokeCollectOrders(replyChannelId, replyTs, userId, afterZaloCutoff) {
  const payload = JSON.stringify({
    triggeredBy: 'slack_reply',
    replyChannelId,
    replyTs,
    userId,
    afterZaloCutoff,
  });
  await lambda.send(
    new InvokeCommand({
      FunctionName: COLLECT_ORDERS_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: payload,
    })
  );
}

export async function handler(event) {
  const rawBody =
    typeof event.body === 'string'
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body
      : '';

  const signature = event.headers?.['x-slack-signature'] || event.headers?.['X-Slack-Signature'] || '';
  const timestamp = event.headers?.['x-slack-request-timestamp'] || event.headers?.['X-Slack-Request-Timestamp'] || '';

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Bad request' };
  }

  if (body.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: body.challenge }),
    };
  }

  const signingSecret = await getSigningSecret();
  if (!verifySlackSignature(rawBody, signature, timestamp, signingSecret)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (body.type !== 'event_callback') {
    return { statusCode: 200, body: '' };
  }

  const ev = body.event;
  if (ev?.type !== 'message' || ev.bot_id) {
    return { statusCode: 200, body: '' };
  }

  const threadTs = ev.thread_ts || ev.ts;
  const channel = ev.channel;
  const replyTs = ev.ts;

  const menu = await getTodayMenuMessage();
  if (!isReplyUnderTodayMenu(channel, threadTs, menu)) {
    return { statusCode: 200, body: '' };
  }

  const mrChefId = await getMrChefSlackUserId();
  if (!mrChefId || !messageMentionsSlackUser(ev.text, mrChefId)) {
    return { statusCode: 200, body: '' };
  }

  const afterZaloCutoff = isAfterZaloSummaryCutoffNow();
  await invokeCollectOrders(channel, replyTs, ev.user, afterZaloCutoff);

  return { statusCode: 200, body: '' };
}
