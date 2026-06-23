import { GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { dateKeyGmt7 } from './time-constants.js';

/**
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string} [date]
 */
export async function getMenuMessageForDate(dynamo, tableName, date = dateKeyGmt7()) {
  if (!tableName) return null;
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { date: { S: date } },
    })
  );
  if (!res.Item) return null;
  return unmarshall(res.Item);
}

/**
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {{ channelId: string; messageTs: string; dishCount: number; postedAt?: string }} row
 * @param {string} [date]
 */
export async function putMenuMessageForDate(
  dynamo,
  tableName,
  { channelId, messageTs, dishCount, postedAt },
  date = dateKeyGmt7()
) {
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        date,
        channel_id: channelId,
        message_ts: messageTs,
        dish_count: dishCount,
        posted_at: postedAt || new Date().toISOString(),
        slack_image_file_ids: [],
        zalo_synced_msg_ids: [],
        zalo_latest_synced_msg_id: '',
      }),
    })
  );
}

/**
 * Merge new Slack file ids and Zalo msg ids onto today's menu row.
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {{ slackImageFileIds?: string[]; zaloSyncedMsgIds?: string[] }} patch
 * @param {string} [date]
 */
export async function patchMenuMessageSyncState(
  dynamo,
  tableName,
  { slackImageFileIds = [], zaloSyncedMsgIds = [] },
  date = dateKeyGmt7()
) {
  if (!slackImageFileIds.length && !zaloSyncedMsgIds.length) return;

  const parts = ['updated_at = :u'];
  const names = {};
  const values = { ':u': { S: new Date().toISOString() } };

  if (slackImageFileIds.length) {
    parts.push('slack_image_file_ids = list_append(if_not_exists(slack_image_file_ids, :empty), :newFiles)');
    values[':newFiles'] = { L: slackImageFileIds.map((id) => ({ S: id })) };
    values[':empty'] = { L: [] };
  }
  if (zaloSyncedMsgIds.length) {
    parts.push('zalo_synced_msg_ids = list_append(if_not_exists(zalo_synced_msg_ids, :empty2), :newZalo)');
    values[':newZalo'] = { L: zaloSyncedMsgIds.map((id) => ({ S: id })) };
    values[':empty2'] = { L: [] };
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { date: { S: date } },
      UpdateExpression: `SET ${parts.join(', ')}`,
      ExpressionAttributeValues: values,
    })
  );
}

/**
 * Ghi ảnh menu mới nhất (thay thế, không append).
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {{ slackImageFileId: string; zaloMsgId: string }} state
 * @param {string} [date]
 */
export async function setMenuLatestImageSyncState(
  dynamo,
  tableName,
  { slackImageFileId, zaloMsgId },
  date = dateKeyGmt7()
) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { date: { S: date } },
      UpdateExpression:
        'SET updated_at = :u, slack_image_file_ids = :files, zalo_latest_synced_msg_id = :zalo, zalo_synced_msg_ids = :zaloList',
      ExpressionAttributeValues: {
        ':u': { S: new Date().toISOString() },
        ':files': { L: [{ S: slackImageFileId }] },
        ':zalo': { S: zaloMsgId },
        ':zaloList': { L: [{ S: zaloMsgId }] },
      },
    })
  );
}
