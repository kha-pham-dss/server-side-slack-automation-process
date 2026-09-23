/**
 * Parse & format số lượng món (hệ số nhân) khi user @Mr.Chef trong thread menu.
 *
 * Nhận mọi cách gõ thông dụng: `2x gà rang`, `x2 gà rang`, `gà rang x2`,
 * `gà rang 2x`, `gà rang *2`, `2 suất gà rang`, `(x3)`, và mọi hệ số 2–20.
 * Nhiều món trong 1 tin: ngăn bằng `,` `;` `+` xuống dòng hoặc `và`.
 */

import { dishEmojiForIndex } from './meal-constants.js';
import { normalizeMenuDishName } from './text-transforms.js';

/** Hệ số nhân hợp lệ. */
export const MIN_QTY_OVERRIDE = 2;
export const MAX_QTY_OVERRIDE = 20;

/** Tách tin thành từng vế đặt món. */
const SEGMENT_SPLIT_RE = /\s*[,;+\n]\s*|\s+(?:và|va)\s+/giu;

/**
 * Hệ số đứng trước tên món: `2x …`, `x2 …`, `2 x …`, `x 2 …`, `2 suất …`.
 * Chốt biên sau hệ số để `2 xào ngọt` không bị đọc thành `2x` + `ào ngọt`.
 */
const QTY_PREFIX_RE =
  /^(?:x\s*(\d{1,2})|(\d{1,2})\s*x|(\d{1,2})\s*(?:suất|suat|xuất|xuat|phần|phan))(?![\p{L}\d])\s*/iu;

/** Hệ số đứng sau tên món: `… x2`, `… 2x`, `… *2`. */
const QTY_SUFFIX_RE = /(?:(?<![\p{L}\d])(?:x\s*(\d{1,2})|(\d{1,2})\s*x)|\*\s*(\d{1,2}))\s*$/iu;

/** Từ đệm bám đầu/cuối tên món trong tin user. */
const LEADING_FILLER_RE =
  /^(?:cho|em|anh|chị|chi|mình|minh|tôi|toi|lấy|lay|đặt|dat|order|thêm|them|suất|suat|xuất|xuat|phần|phan|món|mon|đĩa|dia|giúp|giup|với|voi|ơi|oi|ạ|nhé|nhe|nha)(?![\p{L}\d])\s*/iu;
const TRAILING_FILLER_RE =
  /\s*(?<![\p{L}\d])(?:nhé|nhe|nha|nhá|nhaa|ạ|ah|ak|với|voi|giúp|giup|em|anh|chị|chi|ạk|thôi|thoi)\s*$/iu;

/** Bỏ từ đệm quanh tên món để còn lại đúng tên. */
function trimDishFragment(fragment) {
  let out = String(fragment ?? '').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(LEADING_FILLER_RE, '').replace(TRAILING_FILLER_RE, '').trim();
  } while (out !== prev && out);
  return out;
}

export function normalizeDishMatchKey(name) {
  return normalizeMenuDishName(String(name ?? ''))
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} fragment
 * @param {Array<{ name?: string }>} dishes
 * @returns {number | null} dish index 0-based
 */
export function matchDishIndex(fragment, dishes) {
  const key = normalizeDishMatchKey(fragment);
  if (!key) return null;

  let exact = null;
  /** Partial: menu name contains query (vd. "gà rang" ⊂ "gà rang muối"). Không dùng key⊃name — sau bỏ dấu "rán"→"ran" ⊂ "rang". */
  let partial = null;
  for (let i = 0; i < dishes.length; i++) {
    const name = normalizeDishMatchKey(dishes[i]?.name);
    if (!name) continue;
    if (name === key) {
      exact = i;
      break;
    }
    if (name.includes(key)) {
      if (!partial || name.length < partial.nameLen) {
        partial = { index: i, nameLen: name.length };
      }
    }
  }
  return exact ?? partial?.index ?? null;
}

/** Lấy hệ số + tên món còn lại từ 1 vế. */
function extractQtyFromSegment(segment) {
  /** Bỏ từ đệm ở hai đầu trước khi dò hệ số: "cho em x2 nem rán ạ" → "x2 nem rán". */
  const text = trimDishFragment(
    String(segment ?? '')
      .replace(/[()[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
  );
  if (!text) return null;

  const prefix = text.match(QTY_PREFIX_RE);
  if (prefix) {
    const qty = Number.parseInt(prefix[1] ?? prefix[2] ?? prefix[3], 10);
    return { qty, fragment: text.slice(prefix[0].length) };
  }

  const suffix = text.match(QTY_SUFFIX_RE);
  if (suffix) {
    const qty = Number.parseInt(suffix[1] ?? suffix[2] ?? suffix[3], 10);
    return { qty, fragment: text.slice(0, text.length - suffix[0].length) };
  }

  return null;
}

/**
 * Mọi yêu cầu hệ số trong tin, kể cả vế không khớp món nào (dishIndex = null).
 * @param {string} text
 * @param {Array<{ name?: string }>} dishes
 * @returns {Array<{ qty: number; fragment: string; dishIndex: number | null }>}
 */
export function parseQtyRequestsFromMessage(text, dishes = []) {
  const cleaned = String(text || '')
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .trim();

  /** @type {Array<{ qty: number; fragment: string; dishIndex: number | null }>} */
  const requests = [];

  for (const segment of cleaned.split(SEGMENT_SPLIT_RE)) {
    const hit = extractQtyFromSegment(segment);
    if (!hit) continue;
    if (!Number.isFinite(hit.qty) || hit.qty < MIN_QTY_OVERRIDE || hit.qty > MAX_QTY_OVERRIDE) {
      continue;
    }
    const fragment = trimDishFragment(hit.fragment);
    if (!fragment) continue;
    requests.push({ qty: hit.qty, fragment, dishIndex: matchDishIndex(fragment, dishes) });
  }

  return requests;
}

/**
 * @param {string} text
 * @param {Array<{ name?: string }>} dishes
 * @returns {Record<number, number>} dish index → qty
 */
export function parseQtyOverridesFromMessage(text, dishes) {
  /** @type {Record<number, number>} */
  const overrides = {};
  for (const req of parseQtyRequestsFromMessage(text, dishes)) {
    if (req.dishIndex != null) overrides[req.dishIndex] = req.qty;
  }
  return overrides;
}

/**
 * @param {number[]} dishIndices
 * @param {Array<{ name?: string }>} dishes
 * @param {Record<number, number>} [qtyOverrides]
 */
export function formatDishNamesWithQtyOverrides(dishIndices, dishes, qtyOverrides = {}) {
  const parts = [];
  const seen = new Set();

  const pushDish = (i, qty) => {
    const name = dishes[i]?.name != null ? String(dishes[i].name).trim() : String(i + 1);
    const label = name || String(i + 1);
    parts.push(qty >= 2 ? `${qty}x ${label}` : label);
  };

  for (const i of [...dishIndices].sort((a, b) => a - b)) {
    seen.add(i);
    pushDish(i, qtyOverrides[i] ?? 1);
  }

  for (const [idxStr, qty] of Object.entries(qtyOverrides)) {
    const i = Number(idxStr);
    if (!Number.isFinite(i) || seen.has(i) || qty < 2) continue;
    pushDish(i, qty);
  }

  return parts.join('+');
}

export function userHasOrderContent(dishIndices, qtyOverrides = {}) {
  if (dishIndices?.length) return true;
  return Object.keys(qtyOverrides).length > 0;
}

/**
 * Tổng số phần món (reaction + hệ số nhân). Món chỉ có trong overrides vẫn tính.
 * @param {number[]} dishIndices
 * @param {Record<number, number>} [qtyOverrides]
 */
export function totalPortions(dishIndices = [], qtyOverrides = {}) {
  const seen = new Set();
  let total = 0;

  for (const i of dishIndices) {
    seen.add(i);
    const qty = Number(qtyOverrides[i] ?? 1);
    total += Number.isFinite(qty) && qty >= 1 ? qty : 1;
  }

  for (const [idxStr, qtyRaw] of Object.entries(qtyOverrides)) {
    const i = Number(idxStr);
    if (!Number.isFinite(i) || seen.has(i)) continue;
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty < MIN_QTY_OVERRIDE) continue;
    total += qty;
  }

  return total;
}

/**
 * Món được nhân hệ số nhưng user chưa thả reaction → cần hỏi lại.
 * @param {number[]} dishIndices món user đã thả reaction (chưa cắt theo giới hạn)
 * @param {Record<number, number>} [qtyOverrides]
 * @returns {Array<{ dishIndex: number; qty: number }>}
 */
export function findQtyWithoutReaction(dishIndices = [], qtyOverrides = {}) {
  const reacted = new Set((dishIndices || []).map(Number));
  /** @type {Array<{ dishIndex: number; qty: number }>} */
  const out = [];

  for (const [idxStr, qtyRaw] of Object.entries(qtyOverrides)) {
    const dishIndex = Number(idxStr);
    const qty = Number(qtyRaw);
    if (!Number.isFinite(dishIndex) || reacted.has(dishIndex)) continue;
    if (!Number.isFinite(qty) || qty < MIN_QTY_OVERRIDE) continue;
    out.push({ dishIndex, qty });
  }

  return out.sort((a, b) => a.dishIndex - b.dishIndex);
}

/**
 * Tin nhắn nhờ user kiểm tra lại đơn: món nhân hệ số mà chưa react, hoặc tên món không có trong menu.
 * @param {string} userId
 * @param {Array<{ dishIndex: number; qty: number }>} missingReactions
 * @param {string[]} unknownFragments tên món không khớp menu hôm nay
 * @param {Array<{ name?: string }>} dishes
 * @returns {string | null}
 */
export function buildQtyDoubleCheckMessage(userId, missingReactions = [], unknownFragments = [], dishes = []) {
  const lines = [];

  for (const { dishIndex, qty } of missingReactions) {
    const name = dishes[dishIndex]?.name != null ? String(dishes[dishIndex].name).trim() : '';
    const label = name || `món ${dishIndex + 1}`;
    const emoji = dishEmojiForIndex(dishIndex);
    const hint = emoji ? ` (thả :${emoji}: nếu đúng)` : '';
    lines.push(`• Bạn để *${qty}x ${label}* nhưng chưa thả reaction cho món này${hint}.`);
  }

  for (const fragment of unknownFragments) {
    lines.push(`• Không tìm thấy món "${fragment}" trong menu hôm nay.`);
  }

  if (!lines.length) return null;

  const mention = userId ? `<@${userId}> ` : '';
  return [
    `${mention}Kiểm tra lại danh sách món giúp mình nhé:`,
    ...lines,
    '_Thả reaction cho đúng món rồi @Mr.Chef lại, hoặc bỏ qua nếu bạn gõ nhầm._',
  ].join('\n');
}
