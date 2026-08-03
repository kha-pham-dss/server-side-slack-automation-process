/**
 * Menu images sync — poll Slack DM thread for menu photos, update channel menu, then stop.
 */

import { loadConfigFromParameterStore } from '@slack-dishes/shared/ssm-config.js';
import { CACHE_TTL_MS, isWithinZaloMenuImagePollWindow } from '@slack-dishes/shared/time-constants.js';
import { isTestMode, runFromConfig } from './job.js';

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
  const triggeredBy = event?.triggeredBy ?? event?.detail?.triggeredBy;
  console.log('MenuImagesSync invoked', JSON.stringify({ triggeredBy, source: event?.source }));

  const fromSchedule = event?.source === 'aws.events';
  if (fromSchedule && !isTestMode() && !isWithinZaloMenuImagePollWindow()) {
    console.log('MenuImagesSync: outside poll window (post menu → Zalo summary), skip');
    return { ok: true, skipped: true, reason: 'outside_poll_window' };
  }

  try {
    const config = await getConfig();
    const result = await runFromConfig(config);
    return { ok: true, ...result };
  } catch (err) {
    console.error('MenuImagesSync error:', err);
    throw err;
  }
}
