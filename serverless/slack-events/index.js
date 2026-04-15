/**
 * Slack Events API endpoint (Lambda Function URL).
 * - url_verification: return challenge.
 * - message in thread under today's menu: only if the message @-mentions Mr.Chef (Slack user id from MR_CHEF_SLACK_USER_ID or SSM /slack-dishes/mr-chef-user-id); then invoke CollectOrders (sheet + :white_check_mark: on the reply).
 */

import crypto from 'crypto';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const dynamo = new DynamoDBClient();
const lambda = new LambdaClient();
const ssm = new SSMClient();

const TABLE_NAME = process.env.TABLE_NAME;
const COLLECT_ORDERS_FUNCTION_NAME = process.env.COLLECT_ORDERS_FUNCTION_NAME;
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {{ value: string | null | undefined; at: number }} */
let mrChefUserIdCache = { value: undefined, at: 0 };
const MR_CHEF_CACHE_MS = 60_000;

function messageMentionsSlackUser(text, slackUserId) {
  if (!text || !slackUserId) return false;
  // Slack: <@U123> or <@U123|display name>
  return text.includes(`<@${slackUserId}`);
}

async function getMrChefSlackUserId() {
  const fromEnv = (process.env.MR_CHEF_SLACK_USER_ID || '').trim();
  if (fromEnv) return fromEnv;

  if (Date.now() - mrChefUserIdCache.at < MR_CHEF_CACHE_MS && mrChefUserIdCache.value !== undefined) {
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
  return new Date().toISOString().slice(0, 10);
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
  const fiveMinutes = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) return false;
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
async function invokeCollectOrders(replyChannelId, replyTs) {
  const payload = JSON.stringify({
    triggeredBy: 'slack_reply',
    replyChannelId,
    replyTs,
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
  if (!menu || menu.channel_id !== channel || menu.message_ts !== threadTs) {
    return { statusCode: 200, body: '' };
  }

  const mrChefId = await getMrChefSlackUserId();
  if (!mrChefId || !messageMentionsSlackUser(ev.text, mrChefId)) {
    return { statusCode: 200, body: '' };
  }

  await invokeCollectOrders(channel, replyTs);
  return { statusCode: 200, body: '' };
}
