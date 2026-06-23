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
 * @param {{
 *   channelId: string;
 *   messageTs: string;
 *   dishCount: number;
 *   postedAt?: string;
 *   menuDmChannelId?: string;
 *   menuDmParentTs?: string;
 *   slackImageFileIds?: string[];
 *   imagesSyncComplete?: boolean;
 * }} row
 * @param {string} [date]
 */
export async function putMenuMessageForDate(
  dynamo,
  tableName,
  {
    channelId,
    messageTs,
    dishCount,
    postedAt,
    menuDmChannelId,
    menuDmParentTs,
    slackImageFileIds = [],
    imagesSyncComplete = false,
  },
  date = dateKeyGmt7()
) {
  const hasImages = slackImageFileIds.length > 0;
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall({
        date,
        channel_id: channelId,
        message_ts: messageTs,
        dish_count: dishCount,
        posted_at: postedAt || new Date().toISOString(),
        menu_dm_channel_id: menuDmChannelId || '',
        menu_dm_parent_ts: menuDmParentTs || '',
        slack_image_file_ids: slackImageFileIds,
        images_sync_complete: hasImages || imagesSyncComplete,
      }),
    })
  );
}

/**
 * Sau khi gắn ảnh từ DM thread lên tin menu channel — dừng poll 10 phút.
 * @param {import('@aws-sdk/client-dynamodb').DynamoDBClient} dynamo
 * @param {string} tableName
 * @param {string[]} slackImageFileIds
 * @param {string} [date]
 */
export async function setMenuImagesSynced(dynamo, tableName, slackImageFileIds, date = dateKeyGmt7()) {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { date: { S: date } },
      UpdateExpression:
        'SET updated_at = :u, slack_image_file_ids = :files, images_sync_complete = :done',
      ExpressionAttributeValues: {
        ':u': { S: new Date().toISOString() },
        ':files': { L: slackImageFileIds.map((id) => ({ S: id })) },
        ':done': { BOOL: true },
      },
    })
  );
}
