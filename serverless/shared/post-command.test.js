import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpretAckReactionClaim } from './post-command.js';

describe('interpretAckReactionClaim', () => {
  it('treats ok as claimed (this delivery may post)', () => {
    assert.equal(interpretAckReactionClaim({ ok: true }), 'claimed');
  });

  it('treats already_reacted as already_claimed (skip post)', () => {
    assert.equal(interpretAckReactionClaim({ ok: false, error: 'already_reacted' }), 'already_claimed');
  });

  it('treats other errors as unavailable (fail-open, still post)', () => {
    assert.equal(interpretAckReactionClaim({ ok: false, error: 'invalid_auth' }), 'unavailable');
    assert.equal(interpretAckReactionClaim(null), 'unavailable');
  });
});
