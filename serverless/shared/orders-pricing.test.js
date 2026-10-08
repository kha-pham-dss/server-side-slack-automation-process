import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrdersByUserId, buildZaloSummaryText, parseReactionsFromSlackMessage } from './orders.js';
import { formatPriceLabel } from './meal-constants.js';

describe('vendor pricing: default 40k, :arrow_down: = 35k', () => {
  it('treats :arrow_down: reactors as the 35k tier and ignores the old :up:', () => {
    const { upUserIds } = parseReactionsFromSlackMessage([
      { name: 'arrow_down', users: ['U2'] },
      { name: 'up', users: ['U3'] },
    ]);
    assert.deepEqual([...upUserIds], ['U2']);
  });

  it('prices and caps each tier: 40k up to 5 dishes, 35k up to 4', () => {
    const orders = [0, 1, 2, 3, 4, 5].map((i) => ({ emoji: '', dish_index: i, user_ids: ['U1', 'U2'] }));
    const { ordersByUserId, cappedUserIds } = buildOrdersByUserId(orders, new Set(['U2']));
    assert.deepEqual(ordersByUserId.U1, { dishIndices: [0, 1, 2, 3, 4], price: 40_000 });
    assert.deepEqual(ordersByUserId.U2, { dishIndices: [0, 1, 2, 3], price: 35_000 });
    assert.deepEqual(
      cappedUserIds.map((c) => [c.userId, c.maxDishes]),
      [
        ['U1', 5],
        ['U2', 4],
      ]
    );
  });

  it('labels Zalo totals from the actual prices', () => {
    const text = buildZaloSummaryText(
      { U1: { dishIndices: [0], price: 40_000 }, U2: { dishIndices: [0], price: 35_000 } },
      { U1: 'An', U2: 'Bình' },
      [{ name: 'Cá kho' }],
      ['U1', 'U2']
    );
    assert.match(text, /suất 40k Cá kho, cho An/);
    assert.match(text, /suất 35k Cá kho, cho Bình/);
    assert.match(text, /Tổng 1 suất 40k, 1 suất 35k nhé ạ/);
  });

  it('formats any price as thousands', () => {
    assert.equal(formatPriceLabel(45_000), '45k');
  });
});
