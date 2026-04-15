# Serverless – Slack dishes ordering
Lambda functions for the Slack dishes flow:

- **post-menu** – Runs at 9:30 GMT+7 (Mon–Fri). Reads latest message from DM with menu source user (first line skipped, rest = dishes), updates the sheet with that list, posts menu to Slack channel, stores `message_ts` in DynamoDB.
- **collect-orders** – Runs at 10:20 GMT+7 (schedule) or when invoked by slack-events. Reads today’s menu from DynamoDB, calls Slack `reactions.get`, resolves user IDs to names, writes orders to the sheet. If a user reacted to 2+ dishes, pings them in the menu thread (only first dish is recorded). If run from schedule, replies under the menu with "Đã ghi nhận danh sách đặt món :bee-like:"; if run from a user reply (Slack Events), adds :white_check_mark: to that reply.
- **slack-events** – HTTP endpoint (Lambda Function URL) for Slack Events API. Verifies signing secret; if the event is a message that is a reply under today’s menu post, invokes collect-orders (which then writes the sheet and reacts to the reply).
- **zalo-sheet-summary** – Runs at **10:45 GMT+7** (Mon–Fri). Reads the sheet column range (default `M58:M72` on the same tab as dishes), builds one Zalo group message. Before send: reads today’s menu from **DynamoDB**, calls Slack **`reactions.get`**, and compares (1) total dish emoji reactions (no `:up:`, no bot) to the sheet line **“Tổng N suất”** when present; (2) total `:up:` reactions (no bot) to the sum of all **`N 40k`** tokens in the sheet text (any integer **N** with a space before `40k`, e.g. `10 40k`). On mismatch: **`console.warn`** and a **reply in the menu message thread** (leading `<@user>` ping; default user overridable with **`RECONCILE_NOTIFY_SLACK_USER_ID`**). Sheet, Zalo, and `bot-token`: SSM; Lambda **`TABLE_NAME`** is set by SAM. Local: `../scripts/zalo/send-sheet-summary-local.mjs` — merge SSM + `.env`; set **`TABLE_NAME=slack-dishes-menu-message`** (or your table name) if you want the Slack reconcile + thread reply when testing locally.

## Runtime

Node.js 20 (ES modules).

## Build

From this directory, install dependencies for each function (required for SAM deploy):

```bash
cd post-menu && npm install && cd ..
cd collect-orders && npm install && cd ..
cd slack-events && npm install && cd ..
cd zalo-sheet-summary && npm install && cd ..
```

Or from repo root:

```bash
npm install --prefix serverless/post-menu
npm install --prefix serverless/collect-orders
npm install --prefix serverless/slack-events
npm install --prefix serverless/zalo-sheet-summary
```

Deployment is done via the IaC folder (AWS SAM); see `../iac/README.md`.
