import { DISH_CATEGORIES } from './menu-selection.js';
import { normalizeMenuDishName } from './text-transforms.js';

/** Chốt theo benchmark 2026-10-07 (docs/superpowers/specs/2026-10-07-menu-from-photos-design.md). */
export const DEFAULT_MENU_VISION_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.8-flash'];

/** Pro mất ~36s cho 7 ảnh; PostMenu Lambda timeout phải đủ cho cả model dự phòng. */
export const MENU_VISION_TIMEOUT_MS = 90_000;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dishes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          category: { type: 'STRING', enum: DISH_CATEGORIES },
          confidence: { type: 'NUMBER' },
        },
        required: ['name', 'category', 'confidence'],
      },
    },
  },
  required: ['dishes'],
};

/**
 * @param {string[]} knownDishNames tên món đã từng lên menu — để AI dùng lại đúng tên, lịch sử không bị tách.
 */
export function buildMenuVisionPrompt(knownDishNames = []) {
  const lines = [
    'Đây là các ảnh chụp quầy cơm bình dân hôm nay của một vendor ở Hà Nội.',
    'Liệt kê TẤT CẢ các món khác nhau đang bày bán.',
    '',
    'Quy tắc:',
    '- Nhiều ảnh chụp cùng một khay từ các góc khác nhau: mỗi món chỉ liệt kê MỘT lần.',
    '- Dùng tên món tiếng Việt ngắn gọn, phổ biến như trên menu cơm văn phòng (vd. "Chả lá lốt", "Đậu rán tẩm hành").',
    '- Không ghi giá, không ghi số lượng.',
    '- category: main = món mặn (thịt, cá, trứng, đậu, nộm có thịt như nộm tai heo…);',
    '  stir_fry = món xào có thịt / hải sản / lòng; veg_soup = rau củ luộc hoặc xào (kể cả giá xào), canh, nộm rau củ;',
    '  side = món phụ ăn kèm (lạc rang, dưa muối, tóp mỡ…).',
    '- confidence từ 0 đến 1: mức chắc chắn về TÊN món.',
  ];
  if (knownDishNames.length) {
    lines.push(
      '- Nếu món trùng với một tên trong danh sách dưới đây, dùng ĐÚNG tên đó:',
      ...knownDishNames.map((n) => `  • ${n}`)
    );
  }
  return lines.join('\n');
}

/**
 * @param {unknown} body Gemini generateContent response
 * @returns {Array<{ name: string; category: string; confidence: number }>}
 */
export function parseMenuVisionResponse(body) {
  const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const dishes = (JSON.parse(text).dishes ?? [])
    .map((d) => ({
      name: normalizeMenuDishName(d?.name),
      category: String(d?.category ?? ''),
      confidence: Number(d?.confidence ?? 0),
    }))
    .filter((d) => d.name);
  if (!dishes.length) throw new Error('Gemini returned no dishes');
  return dishes;
}

async function generateMenuDishes({ apiKey, model, images, prompt, fetchImpl }) {
  const parts = [{ text: prompt }];
  images.forEach((img, i) => {
    parts.push({ text: `Ảnh ${i + 1}:` });
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  });
  const res = await fetchImpl(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
    }),
    signal: AbortSignal.timeout(MENU_VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseMenuVisionResponse(await res.json());
}

/**
 * Thử lần lượt từng model (model preview có thể bị Google gỡ bất cứ lúc nào).
 * @param {{
 *   apiKey: string;
 *   images: Array<{ mimeType: string; base64: string }>;
 *   models?: string[];
 *   knownDishNames?: string[];
 *   fetchImpl?: typeof fetch;
 * }} params
 * @returns {Promise<{ model: string; dishes: Array<{ name: string; category: string; confidence: number }> }>}
 */
export async function extractMenuDishesFromImages({
  apiKey,
  images,
  models = DEFAULT_MENU_VISION_MODELS,
  knownDishNames = [],
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('Missing gemini-api-key');
  if (!images.length) throw new Error('No menu images');
  const prompt = buildMenuVisionPrompt(knownDishNames);
  const errors = [];
  for (const model of models) {
    try {
      return { model, dishes: await generateMenuDishes({ apiKey, model, images, prompt, fetchImpl }) };
    } catch (err) {
      console.warn('menu-vision: model failed', model, err?.message || err);
      errors.push(`${model}: ${err?.message || err}`);
    }
  }
  throw new Error(`All menu vision models failed — ${errors.join(' | ')}`);
}
