import { MAX_DISHES, DISH_EMOJI_NAMES } from './meal-constants.js';
import { splitDishesIntoColumns, formatDishColumnText } from './orders.js';

/**
 * @param {Array<{ id?: string; name: string }>} dishes
 * @param {string[]} [imageFileIds]
 */
export function buildMenuSlackBlocks(dishes, imageFileIds = []) {
  const shown = dishes.slice(0, MAX_DISHES);
  const columns = splitDishesIntoColumns(shown);
  let dishStartIndex = 0;
  const fields = columns.map((col) => {
    const text = formatDishColumnText(col, dishStartIndex, DISH_EMOJI_NAMES);
    dishStartIndex += col.length;
    return { type: 'mrkdwn', text };
  });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Thực đơn hôm nay:', emoji: true } },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '4 món + 1 rau => 30k',
          '5 món + 1 rau => 35k',
          'Mặc định 30k, có thể react ít hơn 4 món, nhà bếp sẽ tự thêm các món còn lại.',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    { type: 'section', fields },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':up: để upsize lên 35k' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Nếu muốn sửa *số lượng món* (sau khi react): reply thread @Mr.Chef',
          '• `2x chả cá` => 2 phần chả cá',
          '• `2x chả cá, 2x thịt kho` => 2 phần chả cá + 2 phần thịt kho',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '11h sẽ chốt đơn gửi sang quán.',
          'Sau 11h, vui lòng ping @Mr.Chef để xác nhận lại.',
        ].join('\n'),
      },
    },
  ];

  if (imageFileIds.length) {
    blocks.push({ type: 'divider' });
    for (let i = 0; i < imageFileIds.length; i++) {
      blocks.push({
        type: 'image',
        slack_file: { id: imageFileIds[i] },
        alt_text: `Ảnh món ${i + 1}`,
      });
    }
  }

  return blocks;
}

/** @param {Array<{ name?: string } | string>} dishes */
export function buildMenuSlackTextFallback(dishes) {
  const names = dishes
    .slice(0, MAX_DISHES)
    .map((d) => (typeof d === 'object' && d?.name ? d.name : d))
    .join(', ');
  return `Thực đơn hôm nay: ${names} — :up: upsize 35k — @Mr.Chef 2x tên món nếu cần 2+ phần`;
}

export function menuBlocksNeedBotToken(blocks) {
  return blocks.some((b) => b.type === 'image' && b.slack_file?.id);
}

/**
 * @param {string} botToken
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>} Slack file id
 */
export async function uploadImageBufferToSlack(botToken, buffer, filename) {
  const length = buffer.length;
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ filename, length }),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`Slack files.getUploadURLExternal: ${urlData.error}`);

  const putRes = await fetch(urlData.upload_url, {
    method: 'POST',
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!putRes.ok) throw new Error(`Slack upload PUT failed: ${putRes.status}`);

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title: filename }],
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`Slack files.completeUploadExternal: ${completeData.error}`);
  return urlData.file_id;
}

/**
 * @param {string} botToken
 * @param {string} channelId
 * @param {string} messageTs
 * @param {object[]} blocks
 * @param {string} text
 */
export async function updateSlackMenuMessage(botToken, channelId, messageTs, blocks, text) {
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: channelId,
      ts: messageTs,
      blocks,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.update: ${data.error}`);
  return data;
}
