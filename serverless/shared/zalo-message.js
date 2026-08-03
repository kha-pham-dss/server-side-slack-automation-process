/** Zalo group/DM message types that carry a photo (zca-js / Zalo web). */
export const ZALO_PHOTO_MSG_TYPES = new Set(['chat.photo', 'chat.gif']);

/**
 * Extract a downloadable image URL from a zca-js GroupMessage / UserMessage or raw TMessage.
 * Group photos: content is an object — prefer `href` / `oriUrl` / `normalUrl` (full size), then thumb*.
 * @param {{ data?: Record<string, unknown> } | Record<string, unknown>} msg
 * @returns {string | null}
 */
export function extractZaloImageUrl(msg) {
  const data = msg?.data ?? msg;
  if (!data || typeof data !== 'object') return null;
  if (!ZALO_PHOTO_MSG_TYPES.has(String(data.msgType || ''))) return null;

  let content = data.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!content || typeof content !== 'object') return null;

  const candidates = [
    content.href,
    content.oriUrl,
    content.normalUrl,
    content.hdUrl,
    content.rawUrl,
    content.thumbUrl,
    content.thumb,
  ];
  for (const u of candidates) {
    if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
  }
  return null;
}

/**
 * Stable id for dedup (msgId preferred, cliMsgId fallback).
 * @param {{ data?: Record<string, unknown> } | Record<string, unknown>} msg
 */
export function zaloMessageKey(msg) {
  const data = msg?.data ?? msg;
  if (!data || typeof data !== 'object') return '';
  return String(data.msgId || data.cliMsgId || '');
}

/**
 * Sender uid (kitchen account filter).
 * @param {{ data?: Record<string, unknown> } | Record<string, unknown>} msg
 */
export function zaloMessageSenderId(msg) {
  const data = msg?.data ?? msg;
  return String(data?.uidFrom || '');
}

/** @param {string | number | undefined} ts Zalo message timestamp (seconds or ms). */
export function zaloMessageTimeMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}
