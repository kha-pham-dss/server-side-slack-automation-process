/** Prefix lệnh gửi tin từ control channel: `POST: nội dung` (hỗ trợ dấu `:` ASCII / fullwidth). */
export const POST_COMMAND_RE = /^POST\s*[:：]\s*/i;

/** Bỏ BOM / zero-width ở đầu tin Slack (hay gặp khi copy-paste). */
export function normalizeSlackMessageText(text) {
  return (text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^[\u200B-\u200D\uFEFF]+/, '')
    .trim();
}

export function isPostCommand(text) {
  return POST_COMMAND_RE.test(normalizeSlackMessageText(text));
}

/** @returns {string | null} nội dung sau `POST:` hoặc null nếu không phải lệnh / rỗng */
export function parsePostCommandBody(text) {
  const normalized = normalizeSlackMessageText(text);
  if (!POST_COMMAND_RE.test(normalized)) return null;
  const body = normalized.replace(POST_COMMAND_RE, '').trim();
  return body || null;
}

/** text từ Slack message event (fallback blocks nếu text rỗng). */
export function slackEventMessageText(ev) {
  const direct = (ev?.text || '').trim();
  if (direct) return ev.text;
  const fromBlocks = (ev?.blocks || [])
    .map((b) => b?.text?.text || '')
    .filter(Boolean)
    .join('\n');
  return fromBlocks || '';
}
