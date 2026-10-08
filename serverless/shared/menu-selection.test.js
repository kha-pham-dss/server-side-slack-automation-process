import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectMenuDishes } from './menu-selection.js';
import { dishHistoryKey } from './dish-popularity.js';

function dish(name, category = 'main', confidence = 0.9) {
  return { name, category, confidence };
}

function history(entries) {
  return new Map(
    entries.map(([name, orderCount, appearanceCount]) => [dishHistoryKey(name), { name, orderCount, appearanceCount }])
  );
}

describe('selectMenuDishes', () => {
  it('cold start: fills by category priority main > stir_fry > veg_soup > side', () => {
    const { selected, dropped } = selectMenuDishes(
      [dish('Lạc rang', 'side'), dish('Rau muống luộc', 'veg_soup'), dish('Bắp cải xào', 'stir_fry'), dish('Cá kho')],
      new Map(),
      { maxDishes: 3 }
    );
    assert.deepEqual(
      selected.map((d) => d.name),
      ['Cá kho', 'Bắp cải xào', 'Rau muống luộc']
    );
    assert.deepEqual(dropped, ['Lạc rang']);
  });

  it('with history: popular dishes win, but reserved slots keep new dishes on the menu', () => {
    const candidates = [
      dish('Gà rang'),
      dish('Cá kho'),
      dish('Thịt quay'),
      dish('Giò thủ'),
      dish('Món mới A', 'side', 0.5),
      dish('Món mới B', 'side', 0.6),
    ];
    const popularity = history([
      ['Gà rang', 30, 3],
      ['Cá kho', 2, 4],
      ['Thịt quay', 20, 2],
      ['Giò thủ', 9, 3],
    ]);
    const { selected, dropped } = selectMenuDishes(candidates, popularity, { maxDishes: 4, reservedNewSlots: 2 });
    assert.deepEqual(new Set(selected.map((d) => d.name)), new Set(['Gà rang', 'Thịt quay', 'Món mới A', 'Món mới B']));
    assert.deepEqual(new Set(dropped), new Set(['Cá kho', 'Giò thủ']));
  });

  it('gives unused reserved slots back to known dishes', () => {
    const popularity = history([
      ['Gà rang', 30, 3],
      ['Cá kho', 2, 4],
      ['Thịt quay', 20, 2],
    ]);
    const { selected } = selectMenuDishes(
      [dish('Gà rang'), dish('Cá kho'), dish('Thịt quay'), dish('Món mới')],
      popularity,
      { maxDishes: 3, reservedNewSlots: 3 }
    );
    assert.deepEqual(new Set(selected.map((d) => d.name)), new Set(['Gà rang', 'Thịt quay', 'Món mới']));
  });

  it('keeps veg/soup slots even when main dishes alone would fill the menu', () => {
    const mains = Array.from({ length: 25 }, (_, i) => dish(`Món mặn ${i}`, 'main', 0.95));
    const vegSoup = ['Rau muống luộc', 'Giá xào', 'Canh cua', 'Bắp cải luộc'].map((n) => dish(n, 'veg_soup', 0.8));
    const { selected } = selectMenuDishes([...mains, ...vegSoup], new Map(), { maxDishes: 20, vegSoupSlots: 3 });
    assert.equal(selected.length, 20);
    assert.equal(selected.filter((d) => d.category === 'veg_soup').length, 3);
  });

  it('gives unused veg/soup slots to other dishes', () => {
    const { selected } = selectMenuDishes(
      [dish('Cá kho'), dish('Gà rang'), dish('Rau muống luộc', 'veg_soup')],
      new Map(),
      { maxDishes: 3, vegSoupSlots: 2 }
    );
    assert.equal(selected.length, 3);
  });

  it('dedupes same dish (case / punctuation), keeping the most confident entry', () => {
    const { selected } = selectMenuDishes([dish('Cá kho', 'main', 0.6), dish('cá  kho.', 'main', 0.9)], new Map());
    assert.deepEqual(selected, [{ name: 'cá  kho.', category: 'main' }]);
  });

  it('never exceeds maxDishes and returns everything when under the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => dish(`Món ${i}`));
    assert.equal(selectMenuDishes(many, new Map(), { maxDishes: 20 }).selected.length, 20);
    assert.equal(selectMenuDishes(many.slice(0, 5), new Map(), { maxDishes: 20 }).selected.length, 5);
  });
});
