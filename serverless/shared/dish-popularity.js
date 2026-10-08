import { ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { dateKeyGmt7 } from './time-constants.js';
import { MIN_QTY_OVERRIDE } from './order-qty.js';

/**
 * Khóa lịch sử món: giữ dấu tiếng Việt ("Gà" ≠ "Ga"), bỏ hoa/thường + dấu câu.
 * @param {string} name
 */
export function dishHistoryKey(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Số phần theo index món: reaction = 1, hệ số `2x` = hệ số; món chỉ có trong overrides vẫn tính
 * (cùng quy tắc với totalPortions).
 * @param {Record<string, { dishIndices: number[] }>} ordersByUserId
 * @param {Record<string, Record<number, number>>} overridesByUserId
 * @returns {Record<number, number>}
 */
export function countPortionsByDishIndex(ordersByUserId = {}, overridesByUserId = {}) {
  /** @type {Record<number, number>} */
  const counts = {};
  const add = (i, qty) => {
    counts[i] = (counts[i] ?? 0) + qty;
  };

  const userIds = new Set([...Object.keys(ordersByUserId), ...Object.keys(overridesByUserId)]);
  for (const uid of userIds) {
    const qtyOverrides = overridesByUserId[uid] || {};
    const seen = new Set();
    for (const i of ordersByUserId[uid]?.dishIndices || []) {
      seen.add(i);
      const qty = Number(qtyOverrides[i] ?? 1);
      add(i, Number.isFinite(qty) && qty >= 1 ? qty : 1);
    }
    for (const [idxStr, qtyRaw] of Object.entries(qtyOverrides)) {
      const i = Number(idxStr);
      if (!Number.isFinite(i) || seen.has(i)) continue;
      const qty = Number(qtyRaw);
      if (Number.isFinite(qty) && qty >= MIN_QTY_OVERRIDE) add(i, qty);
    }
  }
  return counts;
}

/**
 * Cộng lịch sử 1 ngày menu. Mỗi món chỉ được cộng 1 lần/ngày (Lambda async retry không đếm đôi).
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {Array<{ name: string }>} dishes menu hôm nay (index = dish index)
 * @param {Record<number, number>} portionsByIndex
 * @param {string} [date]
 * @returns {Promise<{ recorded: number; skipped: number }>}
 */
export async function recordDishPopularityForDate(dynamo, tableName, dishes, portionsByIndex, date = dateKeyGmt7()) {
  /** @type {Map<string, { name: string; portions: number }>} */
  const byKey = new Map();
  dishes.forEach((dish, i) => {
    const key = dishHistoryKey(dish?.name);
    if (!key) return;
    const prev = byKey.get(key);
    const portions = portionsByIndex[i] ?? 0;
    byKey.set(key, { name: String(dish.name).trim(), portions: (prev?.portions ?? 0) + portions });
  });

  let recorded = 0;
  let skipped = 0;
  for (const [key, { name, portions }] of byKey) {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { dish_key: { S: key } },
          UpdateExpression: 'SET #name = :name, last_date = :date ADD appearance_count :one, order_count :portions',
          ConditionExpression: 'attribute_not_exists(last_date) OR last_date <> :date',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: {
            ':name': { S: name },
            ':date': { S: date },
            ':one': { N: '1' },
            ':portions': { N: String(portions) },
          },
        })
      );
      recorded++;
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      skipped++;
    }
  }
  return { recorded, skipped };
}

/**
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @returns {Promise<Map<string, { name: string; orderCount: number; appearanceCount: number }>>}
 */
export async function loadDishPopularity(dynamo, tableName) {
  const byKey = new Map();
  let exclusiveStartKey;
  do {
    const res = await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }));
    for (const raw of res.Items || []) {
      const item = unmarshall(raw);
      if (!item.dish_key) continue;
      byKey.set(item.dish_key, {
        name: String(item.name ?? item.dish_key),
        orderCount: Number(item.order_count ?? 0),
        appearanceCount: Number(item.appearance_count ?? 0),
      });
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return byKey;
}
