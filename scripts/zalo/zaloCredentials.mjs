import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadZaloCredentials() {
  const credPath = join(repoRoot, 'config', 'zalo-credentials.local.json');
  if (existsSync(credPath)) {
    const j = JSON.parse(readFileSync(credPath, 'utf8'));
    return {
      imei: j.imei,
      userAgent: j.userAgent,
      cookie: j.cookies ?? j.cookie,
      language: j.language || 'vi',
    };
  }

  const cookiePath = join(repoRoot, 'config', 'zalo-cookies.local.json');
  if (!existsSync(cookiePath)) {
    throw new Error(
      'Missing config/zalo-credentials.local.json or config/zalo-cookies.local.json.\n' +
        'Set ZALO_IMEI and ZALO_USER_AGENT if using cookies file only.'
    );
  }
  const cookie = JSON.parse(readFileSync(cookiePath, 'utf8'));
  const imei = process.env.ZALO_IMEI?.trim();
  const userAgent = process.env.ZALO_USER_AGENT?.trim();
  if (!imei || !userAgent) {
    throw new Error('Set ZALO_IMEI and ZALO_USER_AGENT when using zalo-cookies.local.json only.');
  }
  return { imei, userAgent, cookie, language: process.env.ZALO_LANGUAGE || 'vi' };
}
