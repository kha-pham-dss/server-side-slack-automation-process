#!/usr/bin/env node
/**
 * Benchmark Gemini vision models on extracting the dish list from vendor menu photos.
 *
 * Usage:
 *   node scripts/menu-vision/benchmark.mjs <image-dir-or-files...> [--models a,b] [--runs N]
 *   node scripts/menu-vision/benchmark.mjs --list
 *
 * Reads GEMINI_API_KEY from env or repo-root `.env`.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'];

/** USD per 1M tokens (input, output). Estimates — verify against current Google pricing. */
const PRICE_PER_MILLION_TOKENS = {
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};

const PROMPT = `Đây là các ảnh chụp quầy cơm bình dân hôm nay của một vendor ở Hà Nội.
Liệt kê TẤT CẢ các món khác nhau đang bày bán.

Quy tắc:
- Nhiều ảnh chụp cùng một khay từ các góc khác nhau: mỗi món chỉ liệt kê MỘT lần.
- Dùng tên món tiếng Việt ngắn gọn, phổ biến như trên menu cơm văn phòng (vd. "Chả lá lốt", "Đậu rán tẩm hành").
- Không ghi giá, không ghi số lượng.
- confidence từ 0 đến 1: mức chắc chắn về TÊN món.
- images: chỉ số ảnh (bắt đầu từ 1) có chứa món đó.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    dishes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          images: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['name', 'confidence'],
      },
    },
  },
  required: ['dishes'],
};

async function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const envText = await readFile(path.join(REPO_ROOT, '.env'), 'utf8').catch(() => '');
  const line = envText.split('\n').find((l) => l.startsWith('GEMINI_API_KEY='));
  const key = line?.slice('GEMINI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  if (!key) throw new Error('GEMINI_API_KEY missing (env or .env)');
  return key;
}

function parseArgs(argv) {
  const args = { inputs: [], models: DEFAULT_MODELS, runs: 1, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--models') args.models = argv[++i].split(',').map((m) => m.trim()).filter(Boolean);
    else if (arg === '--runs') args.runs = Math.max(1, Number(argv[++i]) || 1);
    else args.inputs.push(arg);
  }
  return args;
}

async function resolveImagePaths(inputs) {
  const paths = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      const names = (await readdir(input)).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).sort();
      paths.push(...names.map((n) => path.join(input, n)));
    } else {
      paths.push(input);
    }
  }
  return paths;
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function listModels(apiKey) {
  const res = await fetch(`${API_BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`listModels ${res.status}: ${await res.text()}`);
  const { models = [] } = await res.json();
  for (const m of models) {
    if (m.supportedGenerationMethods?.includes('generateContent')) console.log(m.name.replace(/^models\//, ''));
  }
}

async function extractDishes(apiKey, model, images) {
  const parts = [{ text: PROMPT }];
  images.forEach((img, i) => {
    parts.push({ text: `Ảnh ${i + 1}:` });
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  });
  const startedAt = performance.now();
  const res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const dishes = JSON.parse(text).dishes ?? [];
  const usage = body.usageMetadata ?? {};
  return {
    dishes,
    latencyMs,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
  };
}

export function normalizeDishName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact key > longest key contained in the prediction > prediction contained in a key.
 * Without this order, "Cá rán" would be claimed by "Cá rán rắc hành lá" instead of "Cá rán".
 */
function matchStrength(normalizedPrediction, key) {
  if (normalizedPrediction === key) return 10_000;
  if (normalizedPrediction.includes(key)) return 1_000 + key.length;
  if (key.includes(normalizedPrediction)) return 1_000 - key.length;
  return 0;
}

/**
 * One-to-one match: each prediction claims its strongest-matching ground-truth dish.
 * A second prediction claiming an already-matched dish counts as a duplicate.
 */
export function scoreAgainstGroundTruth(predictedDishes, groundTruthDishes) {
  const keyed = groundTruthDishes.map((gt) => ({
    name: gt.name,
    keys: [gt.name, ...(gt.aliases ?? [])].map(normalizeDishName),
  }));
  const matchedNames = new Set();
  const duplicates = [];
  const unmatched = [];
  for (const predicted of predictedDishes) {
    const normalized = normalizeDishName(predicted.name);
    let best = null;
    let bestStrength = 0;
    for (const gt of keyed) {
      for (const key of gt.keys) {
        const strength = matchStrength(normalized, key);
        if (strength > bestStrength) {
          best = gt;
          bestStrength = strength;
        }
      }
    }
    if (!best) unmatched.push(predicted.name);
    else if (matchedNames.has(best.name)) duplicates.push(`${predicted.name} → ${best.name}`);
    else matchedNames.add(best.name);
  }
  return {
    recall: matchedNames.size / groundTruthDishes.length,
    missed: groundTruthDishes.map((gt) => gt.name).filter((n) => !matchedNames.has(n)),
    duplicates,
    unmatched,
  };
}

function estimateCostUsd(model, inputTokens, outputTokens) {
  const price = PRICE_PER_MILLION_TOKENS[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = await loadApiKey();
  if (args.list) return listModels(apiKey);
  if (!args.inputs.length) throw new Error('Provide image directory or files');

  const imagePaths = await resolveImagePaths(args.inputs);
  const images = await Promise.all(
    imagePaths.map(async (p) => ({ mimeType: mimeTypeFor(p), base64: (await readFile(p)).toString('base64') }))
  );
  const groundTruth = JSON.parse(await readFile(path.join(SCRIPT_DIR, 'ground-truth.json'), 'utf8'));
  console.log(`${images.length} images, ${groundTruth.dishes.length} ground-truth dishes\n`);

  const summary = [];
  for (const model of args.models) {
    for (let run = 1; run <= args.runs; run++) {
      try {
        const result = await extractDishes(apiKey, model, images);
        const score = scoreAgainstGroundTruth(result.dishes, groundTruth.dishes);
        const costUsd = estimateCostUsd(model, result.inputTokens, result.outputTokens);
        console.log(`=== ${model} (run ${run}) ===`);
        console.log(result.dishes.map((d) => `  ${d.name}  [${d.confidence}]`).join('\n'));
        console.log(`  missed: ${score.missed.join(', ') || '-'}`);
        console.log(`  duplicates: ${score.duplicates.join('; ') || '-'}`);
        console.log(`  not in ground truth: ${score.unmatched.join(', ') || '-'}\n`);
        summary.push({
          model,
          run,
          dishes: result.dishes.length,
          recall: `${Math.round(score.recall * 100)}%`,
          duplicates: score.duplicates.length,
          extra: score.unmatched.length,
          latencyS: (result.latencyMs / 1000).toFixed(1),
          inTok: result.inputTokens,
          outTok: result.outputTokens,
          costPerDayUsd: costUsd == null ? 'n/a' : costUsd.toFixed(4),
        });
      } catch (err) {
        console.error(`=== ${model} (run ${run}) FAILED: ${err.message}\n`);
        summary.push({ model, run, error: err.message.slice(0, 80) });
      }
    }
  }
  console.table(summary);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
