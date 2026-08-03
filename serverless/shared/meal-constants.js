/** Giá suất cơm (VND). */
export const DEFAULT_MEAL_PRICE = 30_000;
export const UPSIZE_MEAL_PRICE = 35_000;

export const MAX_DISHES = 20;
/** Suất 30k — tối đa món/user (không :up:). */
export const MAX_DISHES_PER_USER_DEFAULT = 4;
/** Suất 35k — tối đa món/user (có :up:). */
export const MAX_DISHES_PER_USER_UPSIZE = 5;
/** @deprecated Dùng {@link MAX_DISHES_PER_USER_UPSIZE} hoặc tier theo giá. */
export const MAX_DISHES_PER_USER = MAX_DISHES_PER_USER_UPSIZE;

export const UP_EMOJI = 'up';

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

export function formatPriceLabel(price, defaultPrice = DEFAULT_MEAL_PRICE, upPrice = UPSIZE_MEAL_PRICE) {
  if (price === upPrice) return '35k';
  if (price === defaultPrice) return '30k';
  return `${Math.round(price / 1000)}k`;
}
