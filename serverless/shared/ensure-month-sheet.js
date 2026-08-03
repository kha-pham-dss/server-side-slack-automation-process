/**
 * Auto-create monthly dishes sheet tab: dup nearest prior `Tháng N / YYYY`, clear order cells.
 */

import {
  getDishesSheetNameForCurrentMonth,
  parseA1RowBounds,
  quoteSheetTabName,
} from './sheet-slack.js';
import { nowGmt7 } from './time-constants.js';
import { ZALO_SUMMARY_CELL_DEFAULT } from './meal-constants.js';

function resolveZaloCell(config = {}) {
  return (
    (process.env.ZALO_SUMMARY_CELL || config['zalo-summary-cell'] || ZALO_SUMMARY_CELL_DEFAULT).trim() ||
    ZALO_SUMMARY_CELL_DEFAULT
  );
}

/** @param {number} oneBased */
export function columnToLetter(oneBased) {
  if (oneBased <= 0) return '';
  let n = oneBased;
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/**
 * @param {string} title
 * @returns {{ month: number; year: number; key: number } | null}
 */
export function parseMonthSheetTitle(title) {
  const m = String(title ?? '')
    .trim()
    .match(/^Tháng (\d+) \/ (\d+)$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (!Number.isFinite(month) || !Number.isFinite(year) || month < 1 || month > 12) return null;
  return { month, year, key: year * 12 + month };
}

/**
 * @param {string[]} titles
 * @param {number} targetYear
 * @param {number} targetMonth
 * @returns {string | null}
 */
export function findNearestPriorMonthSheetTitle(titles, targetYear, targetMonth) {
  const targetKey = targetYear * 12 + targetMonth;
  /** @type {{ title: string; key: number } | null} */
  let best = null;
  for (const raw of titles ?? []) {
    const parsed = parseMonthSheetTitle(raw);
    if (!parsed || parsed.key >= targetKey) continue;
    const title = String(raw).trim();
    if (!best || parsed.key > best.key) best = { title, key: parsed.key };
  }
  return best?.title ?? null;
}

/** @param {string} colStr */
function columnStartToOneBased(colStr) {
  const col = String(colStr || 'B')
    .trim()
    .toUpperCase();
  if (col.length === 1) return col.charCodeAt(0) - 64;
  return (col.charCodeAt(0) - 64) * 26 + (col.charCodeAt(1) - 64);
}

/**
 * A1 range for daily dish+price cells (no sheet quote).
 * @param {Record<string, string>} [config]
 */
export function orderDataClearRangeA1(config = {}) {
  const startCol1Based = columnStartToOneBased(config['orders-column-start'] || 'B');
  const maxDays = parseInt(config['orders-max-days'] || '31', 10);
  const numCols = Math.max(1, maxDays) * 2;
  const endCol1Based = startCol1Based + numCols - 1;
  const userRange = config['orders-user-range']?.trim() || 'A15:A100';
  const { startRow, endRow } = parseA1RowBounds(userRange);
  return `${columnToLetter(startCol1Based)}${startRow}:${columnToLetter(endCol1Based)}${endRow}`;
}

/**
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @param {string} spreadsheetId
 */
async function listSheetTitles(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });
  return (meta.data.sheets || []).map((s) => ({
    sheetId: s.properties?.sheetId,
    title: s.properties?.title ?? '',
  }));
}

/**
 * @param {{
 *   sheets: import('googleapis').sheets_v4.Sheets;
 *   spreadsheetId: string;
 *   config?: Record<string, string>;
 * }} opts
 * @returns {Promise<{ created: boolean; sheetName: string; sourceSheetName?: string }>}
 */
export async function ensureCurrentMonthSheet({ sheets, spreadsheetId, config = {} }) {
  const override = (config['dishes-sheet-name'] || '').trim();
  const gmt7 = nowGmt7();
  const targetMonth = gmt7.getUTCMonth() + 1;
  const targetYear = gmt7.getUTCFullYear();
  const sheetName = override || getDishesSheetNameForCurrentMonth();

  let tabs = await listSheetTitles(sheets, spreadsheetId);
  if (tabs.some((t) => t.title === sheetName)) {
    return { created: false, sheetName };
  }

  const sourceTitle = findNearestPriorMonthSheetTitle(
    tabs.map((t) => t.title),
    targetYear,
    targetMonth
  );
  if (!sourceTitle) {
    throw new Error(
      `No prior month sheet to duplicate for "${sheetName}". Expected a tab like "Tháng N / YYYY".`
    );
  }

  const source = tabs.find((t) => t.title === sourceTitle);
  if (source?.sheetId == null) {
    throw new Error(`Source sheet "${sourceTitle}" missing sheetId`);
  }

  try {
    const copyRes = await sheets.spreadsheets.sheets.copyTo({
      spreadsheetId,
      sheetId: source.sheetId,
      requestBody: { destinationSpreadsheetId: spreadsheetId },
    });
    const newSheetId = copyRes.data.sheetId;
    if (newSheetId == null) throw new Error('copyTo did not return sheetId');

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: newSheetId, title: sheetName },
              fields: 'title',
            },
          },
        ],
      },
    });

    const quoted = quoteSheetTabName(sheetName);
    const orderRange = `${quoted}!${orderDataClearRangeA1(config)}`;
    const zaloCell = resolveZaloCell(config);
    const zaloRange = `${quoted}!${zaloCell}`;

    await sheets.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [orderRange, zaloRange] },
    });

    return { created: true, sheetName, sourceSheetName: sourceTitle };
  } catch (err) {
    tabs = await listSheetTitles(sheets, spreadsheetId);
    if (tabs.some((t) => t.title === sheetName)) {
      console.warn('ensureCurrentMonthSheet: target exists after race/error', err?.message || err);
      return { created: false, sheetName, sourceSheetName: sourceTitle };
    }
    throw err;
  }
}
