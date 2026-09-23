import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchDishIndex,
  parseQtyOverridesFromMessage,
  parseQtyRequestsFromMessage,
  findQtyWithoutReaction,
  buildQtyDoubleCheckMessage,
  totalPortions,
} from './order-qty.js';

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

describe('parseQtyOverridesFromMessage — mọi cách gõ hệ số', () => {
  const cases = [
    ['2x gà rang', { 12: 2 }],
    ['x2 gà rang', { 12: 2 }],
    ['x3 gà rang', { 12: 3 }],
    ['x4 gà rang', { 12: 4 }],
    ['X5 gà rang', { 12: 5 }],
    ['2 x gà rang', { 12: 2 }],
    ['x 3 gà rang', { 12: 3 }],
    ['gà rang x3', { 12: 3 }],
    ['gà rang 3x', { 12: 3 }],
    ['gà rang *4', { 12: 4 }],
    ['gà rang (x2)', { 12: 2 }],
    ['3 suất gà rang', { 12: 3 }],
    ['cho em x2 nem rán ạ', { 19: 2 }],
    ['anh ơi x3 tôm rang với', { 5: 3 }],
    ['gà rang x2 nhé', { 12: 2 }],
    ['<@U0123ABCD> x4 thịt xiên giúp em', { 0: 4 }],
    ['x10 xúc xích', { 16: 10 }],
  ];

  for (const [text, expected] of cases) {
    it(`parses ${JSON.stringify(text)}`, () => {
      assert.deepEqual(parseQtyOverridesFromMessage(text, TODAY_DISHES), expected);
    });
  }

  it('nhiều món trong 1 tin (và / phẩy / chấm phẩy / xuống dòng)', () => {
    assert.deepEqual(parseQtyOverridesFromMessage('x2 gà rang và x3 tôm rang', TODAY_DISHES), {
      12: 2,
      5: 3,
    });
    assert.deepEqual(parseQtyOverridesFromMessage('2x gà rang, 3x tôm rang', TODAY_DISHES), {
      12: 2,
      5: 3,
    });
    assert.deepEqual(parseQtyOverridesFromMessage('2x gà rang; nem rán x4', TODAY_DISHES), {
      12: 2,
      19: 4,
    });
    assert.deepEqual(parseQtyOverridesFromMessage('3x gà rang\nx2 tôm rang', TODAY_DISHES), {
      12: 3,
      5: 2,
    });
  });

  it('bỏ qua hệ số ngoài khoảng và chữ bắt đầu bằng x', () => {
    assert.deepEqual(parseQtyOverridesFromMessage('x1 gà rang', TODAY_DISHES), {});
    assert.deepEqual(parseQtyOverridesFromMessage('x25 gà rang', TODAY_DISHES), {});
    assert.deepEqual(parseQtyOverridesFromMessage('2 xào ngọt su su', TODAY_DISHES), {});
    assert.deepEqual(parseQtyOverridesFromMessage('ok anh', TODAY_DISHES), {});
  });

  it('x3/x4 cộng dồn đúng vào tổng phần', () => {
    const overrides = parseQtyOverridesFromMessage('x3 gà rang và tôm rang x4', TODAY_DISHES);
    assert.deepEqual(overrides, { 12: 3, 5: 4 });
    assert.equal(totalPortions([5, 12], overrides), 7);
  });
});

describe('double check món', () => {
  it('giữ lại tên món không có trong menu hôm nay', () => {
    const requests = parseQtyRequestsFromMessage('x2 chả cá', TODAY_DISHES);
    assert.deepEqual(requests, [{ qty: 2, fragment: 'chả cá', dishIndex: null }]);
  });

  it('báo món có hệ số nhưng user chưa thả reaction', () => {
    assert.deepEqual(findQtyWithoutReaction([5, 18], { 12: 2, 5: 3 }), [{ dishIndex: 12, qty: 2 }]);
  });

  it('không báo khi user đã react đúng món', () => {
    assert.deepEqual(findQtyWithoutReaction([5, 12], { 12: 2 }), []);
  });

  it('không tạo tin nhắn khi đơn khớp', () => {
    assert.equal(buildQtyDoubleCheckMessage('U1', [], [], TODAY_DISHES), null);
  });

  it('tin nhắn gồm cả món chưa react lẫn tên món lạ', () => {
    const text = buildQtyDoubleCheckMessage(
      'U1',
      [{ dishIndex: 12, qty: 2 }],
      ['chả cá'],
      TODAY_DISHES
    );
    assert.match(text, /<@U1>/);
    assert.match(text, /2x Gà rang/);
    assert.match(text, /:thirteen:/);
    assert.match(text, /chả cá/);
  });
});
