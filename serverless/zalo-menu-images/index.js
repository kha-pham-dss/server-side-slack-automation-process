/**
 * Zalo menu images Lambda — poll Zalo group, sync ảnh nhà bếp lên tin menu Slack.
 */

import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import { CACHE_TTL_MS, isWithinZaloMenuImagePollWindow } from '@slack-dishes/shared/time-constants.js';
import { runFromConfig } from './job.js';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  configCache = await loadConfigFromParameterStore();
  configCacheTime = Date.now();
  return configCache;
}

export async function handler(event) {
  console.log('ZaloMenuImages invoked', JSON.stringify(event?.detail ?? event));

  const fromSchedule = event?.source === 'aws.events';
  if (fromSchedule && !isWithinZaloMenuImagePollWindow()) {
    console.log('ZaloMenuImages: outside poll window (post menu → Zalo summary), skip');
    return { ok: true, skipped: true, reason: 'outside_poll_window' };
  }

  try {
    const config = await getConfig();
    const result = await runFromConfig(config);
    return { ok: true, ...result };
  } catch (err) {
    console.error('ZaloMenuImages error:', err);
    throw err;
  }
}
