import { normalizeMenuDishName } from './text-transforms.js';

/** Nội dung DM đúng chuỗi này → không đăng menu. */
export const SKIP_TODAY_DM_TEXT = 'Bỏ qua hôm nay';

export const MENU_DM_USER_ID_DEFAULT = 'U02SJRNAM2M';

export function normalizeSlackTs(ts) {
  if (ts == null || ts === '') return '';
  const n = parseFloat(String(ts));
  return Number.isFinite(n) ? n.toFixed(6) : String(ts).trim();
}

/** DM channel (Slack id D… hoặc channel_type im). */
export function isSlackImMessage(channelId, channelType) {
  if (channelType === 'im') return true;
  return String(channelId || '').startsWith('D');
}

/**
 * Reply trong thread dưới tin menu DM hôm nay (theo DynamoDB).
 * @param {string} dmChannelId
 * @param {string} threadTs
 * @param {{ menu_dm_channel_id?: string; menu_dm_parent_ts?: string }} menu
 */
export function isReplyUnderMenuDmThread(dmChannelId, threadTs, menu) {
  if (!menu?.menu_dm_channel_id || !menu?.menu_dm_parent_ts) return false;
  if (String(dmChannelId || '').trim() !== String(menu.menu_dm_channel_id).trim()) return false;
  return normalizeSlackTs(threadTs) === normalizeSlackTs(menu.menu_dm_parent_ts);
}

/** Slack message event có ít nhất một file ảnh. */
export function slackMessageHasImageFiles(ev) {
  for (const f of ev?.files || []) {
    if (f.mimetype?.startsWith('image/') && f.id) return true;
  }
  return false;
}

/**
 * @param {string} botToken
 * @param {string} userId
 * @returns {Promise<string>} DM channel id
 */
export async function openDmChannelWithUser(botToken, userId) {
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openRes.json();
  if (!openData.ok) throw new Error(`Slack conversations.open error: ${openData.error ?? openRes.status}`);
  const channelId = openData.channel?.id;
  if (!channelId) throw new Error('Slack conversations.open did not return channel id');
  return channelId;
}

/**
 * Image file IDs from thread replies under the menu DM parent message.
 * @param {string} botToken
 * @param {string} dmChannelId
 * @param {string} parentTs
 * @returns {Promise<string[]>}
 */
export async function fetchImageFileIdsFromDmThread(botToken, dmChannelId, parentTs) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(dmChannelId)}&ts=${encodeURIComponent(parentTs)}&limit=100`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const data = await res.json();
  if (!data.ok) {
    console.warn('menu-dm: conversations.replies failed', data.error);
    return [];
  }

  const fileIds = [];
  for (const msg of (data.messages || []).slice(1)) {
    for (const f of msg.files || []) {
      if (f.mimetype?.startsWith('image/') && f.id) fileIds.push(f.id);
    }
  }
  return fileIds;
}

/**
 * Latest menu text message in DM (parent for dish list + image thread).
 * @returns {{ channelId: string; parentTs: string; dishes: { id: string; name: string }[] } | null}
 */
export async function fetchLatestMenuDmSource(botToken, userId) {
  const channelId = await openDmChannelWithUser(botToken, userId);

  const histRes = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=1`,
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  const histData = await histRes.json();
  if (!histData.ok) throw new Error(`Slack conversations.history error: ${histData.error ?? histRes.status}`);
  const latest = (histData.messages || [])[0];
  if (!latest?.text) throw new Error('No message or empty text in DM with menu source user');
  if (latest.text.trim() === SKIP_TODAY_DM_TEXT) return null;

  const lines = latest.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    channelId,
    parentTs: latest.ts,
    dishes: lines.map((name, i) => ({ id: String(i), name: normalizeMenuDishName(name) })),
  };
}
