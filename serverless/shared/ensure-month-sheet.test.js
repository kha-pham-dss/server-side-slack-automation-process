import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMonthSheetTitle,
  findNearestPriorMonthSheetTitle,
  orderDataClearRangeA1,
  columnToLetter,
} from './ensure-month-sheet.js';

describe('parseMonthSheetTitle', () => {
  it('parses Tháng N / YYYY', () => {
    assert.deepEqual(parseMonthSheetTitle('Tháng 8 / 2026'), { month: 8, year: 2026, key: 2026 * 12 + 8 });
  });

  it('rejects non-matching titles', () => {
    assert.equal(parseMonthSheetTitle('Sheet1'), null);
    assert.equal(parseMonthSheetTitle('Tháng 8/2026'), null);
  });
});

describe('findNearestPriorMonthSheetTitle', () => {
  it('picks nearest prior month, skipping current and future', () => {
    const titles = ['Tháng 8 / 2026', 'Tháng 6 / 2026', 'Tháng 7 / 2026', 'Other', 'Tháng 12 / 2025'];
    assert.equal(findNearestPriorMonthSheetTitle(titles, 2026, 8), 'Tháng 7 / 2026');
  });

  it('walks across year boundary', () => {
    assert.equal(
      findNearestPriorMonthSheetTitle(['Tháng 11 / 2025', 'Tháng 12 / 2025'], 2026, 1),
      'Tháng 12 / 2025'
    );
  });

  it('returns null when nothing prior', () => {
    assert.equal(findNearestPriorMonthSheetTitle(['Tháng 8 / 2026'], 2026, 8), null);
    assert.equal(findNearestPriorMonthSheetTitle([], 2026, 8), null);
  });
});

describe('orderDataClearRangeA1', () => {
  it('defaults to B15:BK100 (31 days × 2 cols from B)', () => {
    assert.equal(orderDataClearRangeA1({}), 'B15:BK100');
    assert.equal(columnToLetter(2 + 31 * 2 - 1), 'BK');
  });

  it('respects config overrides', () => {
    assert.equal(
      orderDataClearRangeA1({
        'orders-column-start': 'C',
        'orders-max-days': '2',
        'orders-user-range': 'A20:A30',
      }),
      'C20:F30'
    );
  });
});
