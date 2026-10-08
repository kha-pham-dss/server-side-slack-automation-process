import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectLatestMenuImageFiles } from './menu-dm.js';

const TODAY = '2026-10-07';
/** 2026-10-07 09:00 GMT+7 */
const TODAY_TS = String(Date.UTC(2026, 9, 7, 2, 0) / 1000);
/** 2026-10-06 09:00 GMT+7 */
const YESTERDAY_TS = String(Date.UTC(2026, 9, 6, 2, 0) / 1000);

function imageFile(id) {
  return { id, mimetype: 'image/jpeg', thumb_1024: `https://files/${id}/1024`, url_private: `https://files/${id}` };
}

describe('collectLatestMenuImageFiles', () => {
  it('returns null when the latest message is a text menu', () => {
    const messages = [{ ts: TODAY_TS, text: 'Cá kho\nGà rang' }, { ts: TODAY_TS, files: [imageFile('F0')] }];
    assert.equal(collectLatestMenuImageFiles(messages, TODAY), null);
  });

  it('merges consecutive image messages from today, oldest first, preferring 1024px thumbs', () => {
    const messages = [
      { ts: `${TODAY_TS}.3`, files: [imageFile('F3')], text: 'menu nay' },
      { ts: `${TODAY_TS}.2`, bot_id: 'B1', text: 'bot notice' },
      { ts: `${TODAY_TS}.1`, files: [imageFile('F1'), imageFile('F2')] },
      { ts: TODAY_TS, text: 'Bỏ qua hôm nay' },
      { ts: TODAY_TS, files: [imageFile('OLD')] },
    ];
    const result = collectLatestMenuImageFiles(messages, TODAY);
    assert.equal(result.parentTs, `${TODAY_TS}.3`);
    assert.deepEqual(
      result.files.map((f) => f.id),
      ['F1', 'F2', 'F3']
    );
    assert.equal(result.files[0].url, 'https://files/F1/1024');
  });

  it("ignores yesterday's photos", () => {
    assert.equal(collectLatestMenuImageFiles([{ ts: YESTERDAY_TS, files: [imageFile('F1')] }], TODAY), null);
  });
});
