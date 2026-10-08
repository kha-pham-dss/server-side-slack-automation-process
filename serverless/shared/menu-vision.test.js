import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuVisionPrompt, extractMenuDishesFromImages, parseMenuVisionResponse } from './menu-vision.js';

function geminiBody(dishes) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify({ dishes }) }] } }] };
}

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const IMAGES = [{ mimeType: 'image/jpeg', base64: 'AAAA' }];

describe('buildMenuVisionPrompt', () => {
  it('asks the model to reuse known dish names', () => {
    const prompt = buildMenuVisionPrompt(['Vịt luộc', 'Cá cơm rim']);
    assert.match(prompt, /ĐÚNG tên đó/);
    assert.match(prompt, /• Vịt luộc/);
    assert.doesNotMatch(buildMenuVisionPrompt([]), /ĐÚNG tên đó/);
  });
});

describe('parseMenuVisionResponse', () => {
  it('normalizes names and drops empty ones', () => {
    const dishes = parseMenuVisionResponse(
      geminiBody([
        { name: '1. Chả lá nốt', category: 'main', confidence: 0.9 },
        { name: '  ', category: 'side', confidence: 0.1 },
      ])
    );
    assert.deepEqual(dishes, [{ name: 'Chả lá lốt', category: 'main', confidence: 0.9 }]);
  });

  it('throws on empty or malformed output so the fallback model runs', () => {
    assert.throws(() => parseMenuVisionResponse(geminiBody([])), /no dishes/);
    assert.throws(() => parseMenuVisionResponse({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }));
  });
});

describe('extractMenuDishesFromImages', () => {
  it('falls back to the next model when the primary fails', async () => {
    const calledModels = [];
    const fetchImpl = async (url) => {
      const model = url.match(/models\/([^:]+):/)[1];
      calledModels.push(model);
      if (model === 'primary') return jsonResponse({ error: 'model not found' }, 404);
      return jsonResponse(geminiBody([{ name: 'Cá kho', category: 'main', confidence: 0.8 }]));
    };
    const result = await extractMenuDishesFromImages({
      apiKey: 'k',
      images: IMAGES,
      models: ['primary', 'fallback'],
      fetchImpl,
    });
    assert.deepEqual(calledModels, ['primary', 'fallback']);
    assert.equal(result.model, 'fallback');
    assert.equal(result.dishes[0].name, 'Cá kho');
  });

  it('throws with every model error when all models fail', async () => {
    const fetchImpl = async () => {
      throw new Error('timeout');
    };
    await assert.rejects(
      extractMenuDishesFromImages({ apiKey: 'k', images: IMAGES, models: ['a', 'b'], fetchImpl }),
      /a: timeout \| b: timeout/
    );
  });

  it('refuses to call Gemini without key or images', async () => {
    await assert.rejects(extractMenuDishesFromImages({ apiKey: '', images: IMAGES }), /gemini-api-key/);
    await assert.rejects(extractMenuDishesFromImages({ apiKey: 'k', images: [] }), /No menu images/);
  });
});
