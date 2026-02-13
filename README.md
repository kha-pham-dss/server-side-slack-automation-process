# server-side-slack-automation-process

Server-side Slack dishes ordering: post today’s menu at **9:30 GMT+7**, collect reactions at **10:20 GMT+7** (Mon–Fri). Scheduled Lambdas only; no public URL; CollectOrders uses Slack `reactions.get`. Dishes and orders use Google Sheets.

## Workflow

Timeline (Mon–Fri only):

```
  9:30 GMT+7
  ─────────────
  EventBridge ──────► PostMenu Lambda
                            │
                            ├──► SSM (config)
                            ├──► Google Sheets  (GET dishes)
                            ├──► Slack          (post menu → get message_ts)
                            └──► DynamoDB       (store date, message_ts)

  ─ ─ ─ ─ ─ ─ ─ ─ ─
  Users react in Slack with :one:, :two:, :three:, … to choose a dish.
  ─ ─ ─ ─ ─ ─ ─ ─ ─

  10:20 GMT+7
  ─────────────
  EventBridge ──────► CollectOrders Lambda
                            │
                            ├──► DynamoDB       (get today's message_ts)
                            ├──► Slack          (reactions.get, users.list)
                            └──► Google Sheets  (write orders by user row)
```

**In short:** Menu is posted at 9:30 → users react → at 10:20 reactions are read, names resolved, and orders written to the sheet.

## Folders

- **`iac/`** – AWS SAM: DynamoDB, EventBridge schedules (9:30 & 10:20 GMT+7, Mon–Fri), Lambdas, IAM. See `iac/README.md` and `iac/config/parameter-store-keys.md`.
- **`serverless/`** – Lambda source: **post-menu**, **collect-orders** (Node.js 20).

## Deploy

From repo root: `make deploy` (or `cd iac && sam build && sam deploy --guided`). Create SSM parameters under `/slack-dishes/` before first run (see `iac/config/parameter-store-keys.md`).

## AWS Free Tier

This setup is designed to stay within **AWS Free Tier** where possible:

| Resource | Free tier (12 months) | This app |
|----------|------------------------|----------|
| **Lambda** | 1M requests/month, 400,000 GB‑seconds | 2 invocations/day × 2 functions ≈ 1.2k/month |
| **DynamoDB** | 25 GB storage, 1M read + 1M write (on‑demand) | Single table, few items per day |
| **EventBridge** | 14M events/month | 2 rules × ~22 weekdays ≈ 44 invocations/month |
| **SSM Parameter Store** | Standard parameters (10k), no charge | Config and secrets under `/slack-dishes/` |

No API Gateway or always-on services; Lambdas run only on schedule. After 12 months, same usage remains low cost (pay-per-request DynamoDB, Lambda per request).
