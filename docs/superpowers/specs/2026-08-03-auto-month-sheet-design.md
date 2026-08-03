# Auto-create monthly dishes sheet tab

**Date:** 2026-08-03  
**Status:** Approved for planning

## Problem

CollectOrders / ZaloSheetSummary expect a Google Sheets tab named `Tháng {month} / {year}` (GMT+7). At month rollover the tab is missing until someone duplicates the previous month by hand — orders fail (e.g. `Unable to parse range: 'Tháng 8 / 2026'!A15:A100`) and `@Mr.Chef` appears silent.

`dishes-sheet-name` is not set in Parameter Store; production always uses the default name from `getDishesSheetNameForCurrentMonth()`.

## Goals

- Automatically create the current month’s tab before anything reads/writes it.
- Template = nearest existing prior tab matching `Tháng N / YYYY`.
- New tab keeps roster (names, Slack IDs), day header row, merges/formatting; order cells and Zalo summary cell start empty.
- Idempotent (safe to run many times).

## Non-goals

- Clearing or deleting previous month tabs (archive stays).
- Changing day-column layout / merge rules (still manual if a day column is missing).
- Requiring SSM `dishes-sheet-name` (optional override remains in code if ever set; not part of this feature’s ops path).

## Decisions

| Topic | Choice |
| --- | --- |
| When to create | **Schedule** day 1 ~00:05 GMT+7 **and** **lazy** ensure on CollectOrders + ZaloSheetSummary |
| What to clear | Only on the **new** tab: daily dish+price blocks + Zalo cell (`S62` / `resolveZaloSummaryCell`) |
| Source tab | Walk backward by month/year for nearest tab matching `/^Tháng (\d+) \/ (\d+)$/` |
| Architecture | Shared helper + thin scheduled Lambda + call sites in existing Lambdas |

## Design

### Shared helper: `ensureCurrentMonthSheet`

Location: `serverless/shared/` (e.g. `ensure-month-sheet.js`), exported via shared index.

```
ensureCurrentMonthSheet({ sheets, spreadsheetId, config }) →
  { created: boolean, sheetName: string, sourceSheetName?: string }
```

1. `target = getDishesSheetNameForCurrentMonth()` (or `config['dishes-sheet-name']` if present — keep existing precedence).
2. List spreadsheet tabs. If `target` exists → return `{ created: false, sheetName: target }`.
3. Else find source: among titles matching `Tháng N / YYYY`, pick the chronologically nearest month **before** the target month. If none → throw with a clear message.
4. `spreadsheets.sheets.copyTo` (same spreadsheet) then update the copy’s title to `target`.
5. Clear on **new** tab only:
   - Order data block: from `orders-column-start` (default `B`), width `orders-max-days * 2` (default 62 cols), rows from `orders-user-range` bounds (default `A15:A100`).
   - Zalo summary cell via existing `resolveZaloSummaryCell(config)` (default `S62`).
6. Do **not** clear column A names, Slack ID column, or date header row (`orders-date-row`, default `12`).

### Schedule: `ensure-month-sheet` Lambda

- EventBridge: day 1 of month, ~00:05 GMT+7 (UTC cron aligned with existing `time-constants` / SAM style).
- Loads SSM sheet config, calls `ensureCurrentMonthSheet`, logs result.
- No Slack post required on success; failures surface in CloudWatch (optional later: ping control channel).

### Lazy call sites

- **CollectOrders** — call ensure before first sheet read/write for the month tab.
- **ZaloSheetSummary** — same, so 10:45 job does not fail if schedule was missed and nobody ordered yet.

PostMenu does not write the sheet today; no change required there.

### Idempotency & concurrency

- If tab already exists, ensure is a no-op.
- Rare race (two Lambdas create at once): one copy may fail on rename/duplicate title — catch, re-list, if target exists treat as success.

### Errors

- No matching source tab → hard fail with message listing expected pattern.
- Sheets API errors → propagate; CollectOrders keeps failing loudly (same as today) until fixed.

## Testing

- Unit: month name helpers; pick nearest prior tab from a title list; clear-range A1 computation from config defaults.
- Manual / staging: delete current-month tab (or use a throwaway spreadsheet), invoke ensure Lambda + CollectOrders; confirm tab created, orders/Zalo cells empty, names/IDs/date row intact.

## Rollout

1. Deploy shared + CollectOrders + ZaloSheetSummary + new Lambda/cron.
2. Optionally invoke ensure once for the current month if the tab already exists (no-op) or is missing (create).
