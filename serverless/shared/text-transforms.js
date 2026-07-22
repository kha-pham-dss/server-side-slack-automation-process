/**
 * Chuẩn hóa text menu / tên user trước khi hiển thị hoặc khớp sheet.
 */

/** Slack display name → tên dùng trong tin Zalo / sheet. */
const SLACK_DISPLAY_NAME_ALIASES = {
  チャン: 'Trang Do',
};

/**
 * Nhà bếp hay gõ nhầm: "gián" → "rán", "quận" → "cuộn", "trả" → "chả", "nốt" → "lốt".
 * Cũng bỏ prefix number list (vd. `1. Cật xào giá` → `Cật xào giá`).
 * @param {string} name
 */
export function normalizeMenuDishName(name) {
  return String(name ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/trả/giu, 'chả')
    .replace(/nốt/giu, 'lốt')
    .replace(/gián/giu, 'rán')
    .replace(/quận/giu, 'cuộn');
}

/**
 * @param {string} name
 */
export function normalizeSlackDisplayName(name) {
  const trimmed = String(name ?? '').trim();
  return SLACK_DISPLAY_NAME_ALIASES[trimmed] ?? trimmed;
}

/**
 * Thêm key khớp sheet cho tên đã transform (vd. チャン → trang do).
 * @param {Set<string>} keys
 * @param {string} rawName
 */
export function addSlackNameMatchKeys(keys, rawName) {
  const trimmed = String(rawName ?? '').trim();
  if (!trimmed) return;
  keys.add(trimmed.toLowerCase());
  const canonical = normalizeSlackDisplayName(trimmed);
  if (canonical !== trimmed) {
    keys.add(canonical.toLowerCase());
  }
}
