import { GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { dateKeyGmt7, dynamoTtlFromDateKey, DYNAMO_TTL_ORDER_OVERRIDES_DAYS } from './time-constants.js';

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<number, number>}
 */
function normalizeOverridesMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<number, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    const qty = Number(v);
    if (Number.isFinite(idx) && qty >= 2 && qty <= 5) out[idx] = qty;
  }
  return out;
}

/**
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string} userId
 * @param {string} [date]
 */
export async function getOrderOverridesForUser(dynamo, tableName, userId, date = dateKeyGmt7()) {
  if (!tableName || !userId) return {};
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { date: { S: date }, user_id: { S: userId } },
    })
  );
  if (!res.Item) return {};
  const row = unmarshall(res.Item);
  return normalizeOverridesMap(row.overrides);
}

/**
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string} [date]
 * @returns {Promise<Record<string, Record<number, number>>>}
 */
export async function getOrderOverridesByUserForDate(dynamo, tableName, date = dateKeyGmt7()) {
  if (!tableName) return {};
  const res = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#d = :d',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':d': { S: date } },
    })
  );
  /** @type {Record<string, Record<number, number>>} */
  const out = {};
  for (const item of res.Items || []) {
    const row = unmarshall(item);
    if (row.user_id) out[row.user_id] = normalizeOverridesMap(row.overrides);
  }
  return out;
}

/**
 * Ghi đè qty theo món (2–5) cho user trong ngày GMT+7.
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string} userId
 * @param {Record<number, number>} newOverrides
 * @param {{ date?: string; messageTs?: string }} [opts]
 */
export async function mergeOrderOverridesForUser(
  dynamo,
  tableName,
  userId,
  newOverrides,
  { date, messageTs } = {}
) {
  if (!tableName || !userId || !Object.keys(newOverrides).length) return;

  const dateKey = date || dateKeyGmt7();
  const existing = await getOrderOverridesForUser(dynamo, tableName, userId, dateKey);
  const merged = { ...existing, ...newOverrides };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        date: dateKey,
        user_id: userId,
        overrides: Object.fromEntries(
          Object.entries(merged).map(([k, v]) => [String(k), v])
        ),
        updated_at: new Date().toISOString(),
        last_message_ts: messageTs || '',
        ttl: dynamoTtlFromDateKey(dateKey, DYNAMO_TTL_ORDER_OVERRIDES_DAYS),
      }),
    })
  );
}
