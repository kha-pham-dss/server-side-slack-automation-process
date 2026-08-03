# Auto Month Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-create `Tháng {m} / {y}` sheet tab (dup nearest prior + clear order/Zalo cells) on day-1 schedule and lazily from CollectOrders / ZaloSheetSummary.

**Architecture:** Pure helpers + `ensureCurrentMonthSheet` in `serverless/shared/ensure-month-sheet.js`; thin Lambda `ensure-month-sheet` on cron; call ensure before sheet I/O in CollectOrders and ZaloSheetSummary.

**Tech Stack:** Node.js 20 ESM, googleapis Sheets v4, SAM Makefile Lambdas, `node --test`.

## Global Constraints

- Target name: `getDishesSheetNameForCurrentMonth()` unless SSM `dishes-sheet-name` set.
- Source: nearest prior tab matching `^Tháng (\d+) \/ (\d+)$`.
- Clear only new tab: order block (`orders-column-start` × `orders-max-days*2` × user rows) + Zalo cell; keep names, Slack IDs, date header row.
- Idempotent; race → re-list, treat existing target as success.
- Schedule: last day of month 17:05 UTC (= 00:05 GMT+7 on the 1st). Cron: `cron(5 17 L * ? *)`.

---

### Task 1: Pure helpers + tests

**Files:**
- Create: `serverless/shared/ensure-month-sheet.js`
- Create: `serverless/shared/ensure-month-sheet.test.js`
- Modify: `serverless/shared/index.js`

- [ ] **Step 1:** Write tests for `parseMonthSheetTitle`, `findNearestPriorMonthSheetTitle`, `orderDataClearRangeA1`.
- [ ] **Step 2:** Implement helpers + `ensureCurrentMonthSheet`; re-export.
- [ ] **Step 3:** `node --test serverless/shared/ensure-month-sheet.test.js` — PASS.
- [ ] **Step 4:** Commit.

### Task 2: Wire CollectOrders + ZaloSheetSummary

**Files:**
- Modify: `serverless/collect-orders/index.js`
- Modify: `serverless/zalo-sheet-summary/job.js`

- [ ] **Step 1:** Call `ensureCurrentMonthSheet` after sheets client created, before sheet reads; use returned `sheetName`.
- [ ] **Step 2:** Commit.

### Task 3: Lambda + SAM

**Files:**
- Create: `serverless/ensure-month-sheet/` (`index.js`, `package.json`, `Makefile`)
- Modify: `iac/template.yaml`, `serverless/README.md`, `iac/config/parameter-store-keys.md` (brief note)

- [ ] **Step 1:** Lambda loads SSM, calls ensure, returns result.
- [ ] **Step 2:** SAM function + schedule `cron(5 17 L * ? *)`.
- [ ] **Step 3:** Docs + commit.

---

**Spec coverage:** schedule+lazy, clear ranges, nearest prior, idempotent race, no PostMenu change.
