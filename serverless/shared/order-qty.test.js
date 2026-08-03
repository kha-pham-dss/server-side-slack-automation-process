import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchDishIndex, parseQtyOverridesFromMessage, totalPortions } from './order-qty.js';

const TODAY_DISHES = [
  { name: 'Thịt xiên' },
  { name: 'Thịt tẩm bột' },
  { name: 'Bò xào ngọt su su' },
  { name: 'Tiết bò xào giá' },
  { name: 'Giò nộm chua ngọt' },
  { name: 'Tôm rang' },
  { name: 'Cá chua ngọt' },
  { name: 'Đậu nhồi' },
  { name: 'Trứng cuộn' },
  { name: 'Trứng kho' },
  { name: 'Trứng cút sốt cà chua' },
  { name: 'Gà rán' },
  { name: 'Gà rang' },
  { name: 'Cá trê kho' },
  { name: 'Thịt  kho' },
  { name: 'Băm xào ngô' },
  { name: 'Xúc xích' },
  { name: 'Mướp đắng nhồi thịt' },
  { name: 'măng nhồi thịt' },
  { name: 'Nem rán' },
];

describe('matchDishIndex', () => {
  it('matches "gà rang" to Gà rang, not Gà rán (diacritic strip false positive)', () => {
    assert.equal(matchDishIndex('gà rang', TODAY_DISHES), 12);
  });

  it('still matches "gà rán" to Gà rán', () => {
    assert.equal(matchDishIndex('gà rán', TODAY_DISHES), 11);
  });

  it('prefers exact "gà rang" over "gà rang muối"', () => {
    const dishes = [{ name: 'Gà rang muối' }, { name: 'Gà rang' }];
    assert.equal(matchDishIndex('gà rang', dishes), 1);
  });
});

describe('parseQtyOverridesFromMessage + totalPortions', () => {
  it('2x gà rang on reacted Gà rang counts as 4 portions with 2 other reacts', () => {
    const overrides = parseQtyOverridesFromMessage('2x gà rang', TODAY_DISHES);
    assert.deepEqual(overrides, { 12: 2 });
    // reacts: Cá chua ngọt, Gà rang, măng nhồi thịt
    assert.equal(totalPortions([6, 12, 18], overrides), 4);
  });
});
