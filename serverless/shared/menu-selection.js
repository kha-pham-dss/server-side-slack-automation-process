import { MAX_DISHES } from './meal-constants.js';
import { dishHistoryKey } from './dish-popularity.js';

/** Thứ tự ưu tiên khi chưa có lịch sử: mặn > xào > rau/canh > món phụ (lạc, dưa, tóp mỡ…). */
export const DISH_CATEGORIES = ['main', 'stir_fry', 'veg_soup', 'side'];

/** Chỗ giữ cho món chưa có lịch sử — không có thì món mới không bao giờ được đặt để có lịch sử. */
export const RESERVED_NEW_DISH_SLOTS = 3;

/** Mỗi suất có 1–2 rau: món mặn luôn xếp trên nên rau/canh cần chỗ riêng, nếu không menu toàn món mặn. */
export const VEG_SOUP_SLOTS = 3;

function categoryRank(category) {
  const rank = DISH_CATEGORIES.indexOf(category);
  return rank < 0 ? DISH_CATEGORIES.length : rank;
}

const byCategory = (a, b) => a.rank - b.rank || b.confidence - a.confidence;

function pickByPopularity(dishes, count, reservedNewSlots) {
  const known = dishes.filter((d) => d.score != null).sort((a, b) => b.score - a.score || byCategory(a, b));
  const fresh = dishes.filter((d) => d.score == null).sort(byCategory);
  const knownQuota = Math.max(0, count - Math.min(reservedNewSlots, fresh.length));
  const pickedKnown = known.slice(0, knownQuota);
  return [...pickedKnown, ...fresh.slice(0, count - pickedKnown.length)];
}

/**
 * Chọn tối đa `maxDishes` món từ danh sách AI đọc được.
 * Rau/canh có tối đa `vegSoupSlots` chỗ riêng; phần còn lại: món có lịch sử xếp theo số phần/lần xuất hiện,
 * món mới xếp theo nhóm rồi độ chắc chắn.
 * @param {Array<{ name: string; category?: string; confidence?: number }>} candidates
 * @param {Map<string, { orderCount: number; appearanceCount: number }>} [popularityByKey]
 * @param {{ maxDishes?: number; reservedNewSlots?: number; vegSoupSlots?: number }} [options]
 * @returns {{ selected: Array<{ name: string; category: string }>; dropped: string[] }}
 */
export function selectMenuDishes(
  candidates,
  popularityByKey = new Map(),
  { maxDishes = MAX_DISHES, reservedNewSlots = RESERVED_NEW_DISH_SLOTS, vegSoupSlots = VEG_SOUP_SLOTS } = {}
) {
  /** @type {Map<string, { name: string; category: string; confidence: number; rank: number; score: number | null }>} */
  const byKey = new Map();
  for (const c of candidates) {
    const key = dishHistoryKey(c?.name);
    if (!key) continue;
    const confidence = Number(c.confidence ?? 0);
    const prev = byKey.get(key);
    if (prev && prev.confidence >= confidence) continue;
    const history = popularityByKey.get(key);
    byKey.set(key, {
      name: String(c.name).trim(),
      category: c.category ?? '',
      confidence,
      rank: categoryRank(c.category),
      score: history?.appearanceCount > 0 ? history.orderCount / history.appearanceCount : null,
    });
  }

  const all = [...byKey.values()];
  const pickedVegSoup = pickByPopularity(
    all.filter((d) => d.category === 'veg_soup'),
    Math.min(vegSoupSlots, maxDishes),
    0
  );
  const rest = all.filter((d) => !pickedVegSoup.includes(d));
  const picked = new Set([...pickedVegSoup, ...pickByPopularity(rest, maxDishes - pickedVegSoup.length, reservedNewSlots)]);

  return {
    selected: [...picked].sort(byCategory).map(({ name, category }) => ({ name, category })),
    dropped: all.filter((d) => !picked.has(d)).map((d) => d.name),
  };
}
