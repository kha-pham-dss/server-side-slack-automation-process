import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { dateKeyGmt7, dynamoTtlFromDateKey, DYNAMO_TTL_DISHES_MENU_DAYS } from './time-constants.js';

/**
 * @param {DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string} [date] GMT+7 YYYY-MM-DD
 * @returns {Promise<Array<{ id: string; name: string }> | null>}
 */
export async function getDishesMenuForDate(dynamo, tableName, date = dateKeyGmt7()) {
  if (!tableName) return null;
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { date: { S: date } },
    })
  );
  if (!res.Item) return null;
  const item = unmarshall(res.Item);
  const dishes = item.dishes;
  if (!Array.isArray(dishes)) return null;
  return dishes.map((d, i) => ({
    id: String(d?.id ?? i),
    name: String(d?.name ?? '').trim(),
  })).filter((d) => d.name);
}

/**
 * @param {DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {Array<{ id?: string; name: string }>} dishes
 * @param {string} [date]
 */
export async function putDishesMenuForDate(dynamo, tableName, dishes, date = dateKeyGmt7()) {
  if (!tableName) throw new Error('DISHES_TABLE_NAME not set');
  const normalized = dishes.map((d, i) => ({
    id: String(d?.id ?? i),
    name: String(d?.name ?? d ?? '').trim(),
  })).filter((d) => d.name);

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        date,
        dishes: normalized,
        updated_at: new Date().toISOString(),
        ttl: dynamoTtlFromDateKey(date, DYNAMO_TTL_DISHES_MENU_DAYS),
      }),
    })
  );
  return normalized;
}
