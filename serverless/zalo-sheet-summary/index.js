/**
 * Lambda: 11:00 GMT+7 Mon–Fri — đọc ô sheet (mặc định M58:M72), bỏ dòng trống, gửi một tin Zalo nhóm.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { runFromConfig } from './job.js';

const ssm = new SSMClient();
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;
const CACHE_TTL_MS = 60_000;

/** SSM GetParametersByPath returns at most 10 parameters per call — must follow NextToken. */
async function loadAllParametersByPath() {
  const pathPrefix = PARAMETER_PREFIX.endsWith('/') ? PARAMETER_PREFIX.slice(0, -1) : PARAMETER_PREFIX;
  const namePrefix = `${pathPrefix}/`;
  const map = {};
  let nextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: pathPrefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
        MaxResults: 10,
      })
    );
    for (const p of res.Parameters || []) {
      const name = p.Name?.replace(namePrefix, '') || '';
      if (name && p.Value != null && p.Value !== '') map[name] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return map;
}

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  configCache = await loadAllParametersByPath();
  configCacheTime = Date.now();
  return configCache;
}

export async function handler(event) {
  console.log('ZaloSheetSummary invoked', JSON.stringify(event?.detail ?? event));
  try {
    const config = await getConfig();
    const result = await runFromConfig(config);
    return { ok: true, ...result };
  } catch (err) {
    console.error('ZaloSheetSummary error:', err);
    throw err;
  }
}
