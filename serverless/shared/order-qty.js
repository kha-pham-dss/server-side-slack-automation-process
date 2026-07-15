/**
 * Parse & format số lượng món (2x–5x) khi user @Mr.Chef trong thread menu.
 */

import { normalizeMenuDishName } from './text-transforms.js';

const QTY_OVERRIDE_RE = /(?:^|[\s,;]+)([2-5])x\s+([^,;]+?)(?=(?:\s+và\s+[2-5]x|[\s,;]+[2-5]x)|$)/gi;

/** Bỏ hậu tố thừa sau tên món trong tin user. */
function trimDishFragment(fragment) {
  return String(fragment ?? '')
    .trim()
    .replace(/\s+(nhé|nha|ạ|giúp)(?:\s.*)?$/iu, '')
    .trim();
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

  let best = null;
  for (let i = 0; i < dishes.length; i++) {
    const name = normalizeDishMatchKey(dishes[i]?.name);
    if (!name) continue;
    if (name === key || name.includes(key) || key.includes(name)) {
      if (!best || name.length < best.nameLen) {
        best = { index: i, nameLen: name.length };
      }
    }
  }
  return best?.index ?? null;
}

/**
 * @param {string} text
 * @param {Array<{ name?: string }>} dishes
 * @returns {Record<number, number>} dish index → qty (2–5)
 */
export function parseQtyOverridesFromMessage(text, dishes) {
  const cleaned = String(text || '')
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .trim();
  /** @type {Record<number, number>} */
  const overrides = {};

  for (const m of cleaned.matchAll(QTY_OVERRIDE_RE)) {
    const qty = Number.parseInt(m[1], 10);
    const frag = trimDishFragment(m[2]);
    const idx = matchDishIndex(frag, dishes);
    if (idx != null && qty >= 2 && qty <= 5) {
      overrides[idx] = qty;
    }
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
