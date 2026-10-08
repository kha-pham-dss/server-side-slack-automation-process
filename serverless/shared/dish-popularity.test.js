import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  countPortionsByDishIndex,
  dishHistoryKey,
  loadDishPopularity,
  recordDishPopularityForDate,
} from './dish-popularity.js';

describe('dishHistoryKey', () => {
  it('keeps Vietnamese diacritics but ignores case, spacing and punctuation', () => {
    assert.equal(dishHistoryKey('  Cá   Kho. '), 'cá kho');
    assert.notEqual(dishHistoryKey('Gà rang'), dishHistoryKey('Ga rang'));
  });
});

describe('countPortionsByDishIndex', () => {
  it('counts reactions as 1, applies qty multipliers, and includes override-only dishes', () => {
    const counts = countPortionsByDishIndex(
      {
        U1: { dishIndices: [0, 1] },
        U2: { dishIndices: [1] },
      },
      {
        U1: { 1: 3, 4: 2 },
        U3: { 2: 2 },
      }
    );
    assert.deepEqual(counts, { 0: 1, 1: 4, 2: 2, 4: 2 });
  });
});

function fakeDynamo(handler) {
  const commands = [];
  return {
    commands,
    send: async (cmd) => {
      commands.push(cmd);
      return handler(cmd);
    },
  };
}

describe('recordDishPopularityForDate', () => {
  it('sums portions of same-key dishes and guards against double counting per day', async () => {
    const dynamo = fakeDynamo(() => ({}));
    const result = await recordDishPopularityForDate(
      dynamo,
      'table',
      [{ name: 'Cá kho' }, { name: 'cá kho' }, { name: 'Gà rang' }],
      { 0: 2, 1: 3 },
      '2026-10-07'
    );
    assert.deepEqual(result, { recorded: 2, skipped: 0 });
    const caKho = dynamo.commands.find((c) => c.input.Key.dish_key.S === 'cá kho').input;
    assert.equal(caKho.ExpressionAttributeValues[':portions'].N, '5');
    assert.match(caKho.ConditionExpression, /last_date <> :date/);
    const gaRang = dynamo.commands.find((c) => c.input.Key.dish_key.S === 'gà rang').input;
    assert.equal(gaRang.ExpressionAttributeValues[':portions'].N, '0');
  });

  it('counts already-recorded dishes as skipped (Lambda retry) and rethrows other errors', async () => {
    const alreadyRecorded = fakeDynamo(() => {
      throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    });
    assert.deepEqual(await recordDishPopularityForDate(alreadyRecorded, 't', [{ name: 'A' }], {}), {
      recorded: 0,
      skipped: 1,
    });

    const broken = fakeDynamo(() => {
      throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    });
    await assert.rejects(recordDishPopularityForDate(broken, 't', [{ name: 'A' }], {}), /throttled/);
  });
});

describe('loadDishPopularity', () => {
  it('follows Scan pagination', async () => {
    const pages = [
      { Items: [marshall({ dish_key: 'cá kho', name: 'Cá kho', order_count: 10, appearance_count: 2 })], LastEvaluatedKey: { k: 1 } },
      { Items: [marshall({ dish_key: 'gà rang', name: 'Gà rang', order_count: 3, appearance_count: 1 })] },
    ];
    const dynamo = fakeDynamo(() => pages.shift());
    const byKey = await loadDishPopularity(dynamo, 'table');
    assert.deepEqual(byKey.get('cá kho'), { name: 'Cá kho', orderCount: 10, appearanceCount: 2 });
    assert.equal(byKey.size, 2);
    assert.deepEqual(dynamo.commands[1].input.ExclusiveStartKey, { k: 1 });
  });
});
