/**
 * GetDishes API (GET /dishes).
 * Reads dish list from Google Sheet and returns { dishes: [ { id, name }, ... ] }.
 * Used by PostMenu Lambda when dishes-api-url points to this API.
 */

import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { google } from 'googleapis';

const ssm = new SSMClient();
const PARAMETER_PREFIX = process.env.PARAMETER_PREFIX || '/slack-dishes';

/** @type {Record<string, string>} */
let configCache = {};
let configCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function getConfig() {
  if (Date.now() - configCacheTime < CACHE_TTL_MS && Object.keys(configCache).length > 0) {
    return configCache;
  }
  const cmd = new GetParametersByPathCommand({
    Path: PARAMETER_PREFIX,
    Recursive: true,
    WithDecryption: true,
  });
  const res = await ssm.send(cmd);
  const map = {};
  for (const p of res.Parameters || []) {
    const name = p.Name?.replace(PARAMETER_PREFIX + '/', '') || '';
    if (name && p.Value) map[name] = p.Value;
  }
  configCache = map;
  configCacheTime = Date.now();
  return map;
}

function getSheetsClient(credentialsJson) {
  const cred = JSON.parse(credentialsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: cred,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Read "Dishes" sheet. Expected: column A = id, column B = name (optional header row).
 * Returns [ { id: "0", name: "Dish A" }, ... ].
 */
async function fetchDishesFromSheet(sheets, spreadsheetId) {
  const range = 'Dishes!A:B';
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const rows = res.data.values || [];
  const dishes = [];
  let startRow = 0;
  if (rows.length > 0 && rows[0][0]?.toString().toLowerCase() === 'id') {
    startRow = 1; // skip header
  }
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const id = row?.[0] != null ? String(row[0]).trim() : '';
    const name = row?.[1] != null ? String(row[1]).trim() : '';
    if (!name) continue; // skip empty names
    dishes.push({ id: id || String(dishes.length), name });
  }
  return dishes;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  console.log('GetDishes invoked', event?.requestContext?.http?.method);

  try {
    const config = await getConfig();
    const sheetId = config['sheet-id'];
    const credentials = config['sheets-credentials'];
    if (!sheetId || !credentials) {
      return jsonResponse(500, {
        error: 'Missing sheet-id or sheets-credentials in Parameter Store',
      });
    }

    const sheets = getSheetsClient(credentials);
    const dishes = await fetchDishesFromSheet(sheets, sheetId);
    return jsonResponse(200, { dishes });
  } catch (err) {
    console.error('GetDishes error:', err);
    return jsonResponse(500, {
      error: err.message || 'Failed to fetch dishes',
    });
  }
}
