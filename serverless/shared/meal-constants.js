/**
 * Giá suất cơm (VND). Tên `UPSIZE_*` / `UP_EMOJI` giữ từ vendor cũ (react để upsize);
 * vendor mới: react {@link UP_EMOJI} để GIẢM suất xuống {@link UPSIZE_MEAL_PRICE}.
 */
export const DEFAULT_MEAL_PRICE = 40_000;
export const UPSIZE_MEAL_PRICE = 35_000;

export const MAX_DISHES = 20;
/** Suất 40k (3 mặn + 1–2 rau) — tối đa món/user (không :arrow_down:). */
export const MAX_DISHES_PER_USER_DEFAULT = 5;
/** Suất 35k (ăn ít) — tối đa món/user (có :arrow_down:). */
export const MAX_DISHES_PER_USER_UPSIZE = 4;
/** @deprecated Dùng {@link MAX_DISHES_PER_USER_UPSIZE} hoặc tier theo giá. */
export const MAX_DISHES_PER_USER = MAX_DISHES_PER_USER_UPSIZE;

export const UP_EMOJI = 'arrow_down';

/** Ô sheet ghi tin nhắn Zalo tổng hợp (ghi đè env ZALO_SUMMARY_CELL). */
export const ZALO_SUMMARY_CELL_DEFAULT = 'S62';

/**
 * Slack reaction names theo index món (0-based).
 * 1–10: built-in Slack. 11–20: cần custom emoji trong workspace (eleven…twenty).
 */
export const DISH_EMOJI_NAMES = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'keycap_ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

export function dishEmojiForIndex(index) {
  return DISH_EMOJI_NAMES[index] ?? null;
}

export function dishIndexFromEmoji(name) {
  if (typeof name !== 'string') return -1;
  return DISH_EMOJI_NAMES.indexOf(name);
}

export function formatPriceLabel(price) {
  return `${Math.round(price / 1000)}k`;
}
