#!/usr/bin/env node
/**
 * Cùng logic Lambda zalo-sheet-summary.
 * Config sheet lấy từ SSM (/slack-dishes/...); .env chỉ cần Zalo (+ tùy chọn ghi đè).
 *
 *   node --env-file=.env scripts/zalo/send-sheet-summary-local.mjs
 *
 * Cần AWS credentials trên máy (aws configure / AWS_PROFILE) để đọc Parameter Store.
 * Tùy chọn: TABLE_NAME=slack-dishes-menu-message để đối chiếu Slack trước khi gửi (cùng bảng Dynamo như Lambda).
 */

import { readFileSync, existsSync } from 'node:fs';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { runFromConfig } from '../../serverless/zalo-sheet-summary/job.js';

function readMaybeFile(val) {
  const v = (val || '').trim();
  if (!v) return '';
  if (v.startsWith('{')) return v;
  if (existsSync(v)) return readFileSync(v, 'utf8');
  return v;
}

/** Chỉ các key được set trong .env (không rỗng); ghi đè lên config SSM. */
function buildEnvOverrides() {
  /** @type {Record<string, string>} */
  const out = {};

  const set = (key, val) => {
    const s = val?.trim();
    if (s) out[key] = s;
  };

  set('zalo-group-id', process.env.ZALO_GROUP_ID);
  set('zalo-imei', process.env.ZALO_IMEI);
  set('zalo-user-agent', process.env.ZALO_USER_AGENT);
  set('zalo-language', process.env.ZALO_LANGUAGE);

  const zaloCookies =
    readMaybeFile(process.env.ZALO_COOKIES_JSON) || readMaybeFile(process.env.ZALO_COOKIES_PATH);
  if (zaloCookies.trim()) out['zalo-cookies-json'] = zaloCookies.trim();

  // Optional overrides (thường để trống — dùng SSM)
  set('sheet-id', process.env.SHEET_ID);
  const sheetCreds =
    readMaybeFile(process.env.SHEET_CREDENTIALS_JSON) || readMaybeFile(process.env.SHEET_CREDENTIALS_PATH);
  if (sheetCreds.trim()) out['sheet-credentials'] = sheetCreds.trim();
  set('dishes-sheet-name', process.env.DISHES_SHEET_NAME);
  set('zalo-summary-range', process.env.ZALO_SUMMARY_RANGE);

  return out;
}

async function loadSsmConfig() {
  const raw = process.env.PARAMETER_PREFIX?.trim() || '/slack-dishes';
  const pathPrefix = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const namePrefix = `${pathPrefix}/`;
  const client = new SSMClient({});
  const map = {};
  let nextToken;
  do {
    const res = await client.send(
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

const envOverrides = buildEnvOverrides();
let ssmConfig = {};
try {
  ssmConfig = await loadSsmConfig();
} catch (err) {
  console.error('SSM load failed (cần AWS credentials và quyền ssm:GetParametersByPath):', err?.message || err);
  process.exit(1);
}

const config = { ...ssmConfig, ...envOverrides };
const result = await runFromConfig(config);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  const softSkip = result.reason === 'empty_range';
  process.exit(softSkip ? 0 : 1);
}
