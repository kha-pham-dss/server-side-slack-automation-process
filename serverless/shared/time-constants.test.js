import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinZaloMenuImagePollWindow } from './time-constants.js';

const atGmt7 = (hhmm) => new Date(`2026-10-08T${hhmm}:00+07:00`);

test('image poll window opens 5 min after the 10:15 menu post and closes at the 11:00 Zalo summary', () => {
  assert.equal(isWithinZaloMenuImagePollWindow(atGmt7('09:35')), false);
  assert.equal(isWithinZaloMenuImagePollWindow(atGmt7('10:15')), false);
  assert.equal(isWithinZaloMenuImagePollWindow(atGmt7('10:20')), true);
  assert.equal(isWithinZaloMenuImagePollWindow(atGmt7('10:55')), true);
  assert.equal(isWithinZaloMenuImagePollWindow(atGmt7('11:00')), false);
});
