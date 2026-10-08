import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearOrderOverridesForDate } from './dynamo-order-overrides.js';

describe('clearOrderOverridesForDate', () => {
  it('deletes every user row for the date and returns count', async () => {
    const deletedKeys = [];
    const dynamo = {
      send: async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'QueryCommand') {
          return {
            Items: [
              { date: { S: '2026-09-29' }, user_id: { S: 'U1' }, overrides: { M: { '0': { N: '2' } } } },
              { date: { S: '2026-09-29' }, user_id: { S: 'U2' }, overrides: { M: { '3': { N: '3' } } } },
            ],
          };
        }
        if (name === 'DeleteItemCommand') {
          deletedKeys.push(cmd.input.Key);
          return {};
        }
        throw new Error(`unexpected command ${name}`);
      },
    };

    const n = await clearOrderOverridesForDate(dynamo, 'slack-dishes-order-overrides', '2026-09-29');
    assert.equal(n, 2);
    assert.deepEqual(deletedKeys, [
      { date: { S: '2026-09-29' }, user_id: { S: 'U1' } },
      { date: { S: '2026-09-29' }, user_id: { S: 'U2' } },
    ]);
  });

  it('returns 0 when table name missing', async () => {
    assert.equal(await clearOrderOverridesForDate({}, '', '2026-09-29'), 0);
  });
});
