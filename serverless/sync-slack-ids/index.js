/**
 * SyncSlackIds Lambda (invoke thủ công).
 * Đọc tên user từ orders-user-range, khớp Slack users.list, ghi Slack user ID vào cột
 * orders-slack-id-column (mặc định BZ), cùng hàng với cột tên.
 */

import {
  findSlackUserIdForSheetName,
  getDishesSheetNameForCurrentMonth,
  getOrdersSlackIdColumn,
  getSheetsClient,
  loadConfigFromParameterStore,
  quoteSheetTabName,
  parseA1RowBounds,
  resolveOrdersSlackIdRange,
  resolveSlackUserProfiles,
} from '@slack-dishes/shared';

/**
 * @param {import('googleapis').sheets_v4.Sheets} sheets
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {string} ordersUserRange
 * @param {string} ordersSlackIdRange
 * @param {Record<string, Set<string>>} userIdToNameKeys
 * @param {Record<string, string>} userIdToName
 */
async function syncSlackIdsToSheet(
  sheets,
  spreadsheetId,
  sheetName,
  ordersUserRange,
  ordersSlackIdRange,
  userIdToNameKeys,
  userIdToName
) {
  const quoted = quoteSheetTabName(sheetName);
  const userRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoted}!${ordersUserRange}`,
  });
  const userRows = userRes.data.values || [];
  if (userRows.length === 0) {
    return { written: 0, matched: 0, unmatched: [], slack_id_range: ordersSlackIdRange };
  }

  const { startRow } = parseA1RowBounds(ordersUserRange);
  const values = [];
  const matched = [];
  const unmatched = [];
  for (let i = 0; i < userRows.length; i++) {
    const sheetNameCell = userRows[i]?.[0] != null ? String(userRows[i][0]).trim() : '';
    if (!sheetNameCell) {
      values.push(['']);
      continue;
    }
    const uid = findSlackUserIdForSheetName(sheetNameCell, userIdToNameKeys);
    if (uid) {
      values.push([uid]);
      matched.push({
        row: startRow + i,
        sheet_name: sheetNameCell,
        slack_user_id: uid,
        slack_name: userIdToName[uid] ?? uid,
      });
    } else {
      values.push(['']);
      unmatched.push({ row: startRow + i, sheet_name: sheetNameCell });
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoted}!${ordersSlackIdRange}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  return {
    written: matched.length,
    matched: matched.length,
    matched_details: matched,
    unmatched,
    slack_id_range: ordersSlackIdRange,
  };
}

export async function handler(event) {
  console.log('SyncSlackIds invoked', JSON.stringify(event ?? {}));

  const config = await loadConfigFromParameterStore();
  const botToken = config['bot-token'];
  const sheetId = config['sheet-id'];
  const credentials = config['sheet-credentials'];
  if (!botToken) throw new Error('Missing bot-token in Parameter Store');
  if (!sheetId || !credentials) throw new Error('Missing sheet-id or sheet-credentials in Parameter Store');

  const sheetName = config['dishes-sheet-name'] || getDishesSheetNameForCurrentMonth();
  const ordersUserRange = config['orders-user-range']?.trim() || 'A15:A100';
  const ordersSlackIdRange = resolveOrdersSlackIdRange(config);
  const slackIdColumn = getOrdersSlackIdColumn(config);

  const { userIdToName, userIdToNameKeys } = await resolveSlackUserProfiles(botToken);
  console.log('Slack members loaded:', Object.keys(userIdToName).length);

  const sheets = getSheetsClient(credentials);
  const result = await syncSlackIdsToSheet(
    sheets,
    sheetId,
    sheetName,
    ordersUserRange,
    ordersSlackIdRange,
    userIdToNameKeys,
    userIdToName
  );

  console.log('SyncSlackIds result:', JSON.stringify(result, null, 2));
  if (result.unmatched.length > 0) {
    console.warn(
      'Sheet names with no Slack match — update name on sheet or add user to workspace:',
      result.unmatched
    );
  }

  return {
    ok: true,
    sheet_name: sheetName,
    orders_user_range: ordersUserRange,
    orders_slack_id_column: slackIdColumn,
    ...result,
  };
}
