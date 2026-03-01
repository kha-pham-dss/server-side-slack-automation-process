# server-side-slack-automation-process

Server-side Slack dishes ordering: post today’s menu at **9:30 GMT+7**, collect reactions at **10:20 GMT+7** (Mon–Fri). Optional: Slack Events API URL so that a **reply under the day’s menu** re-runs CollectOrders and gets a ✅ reaction. Dishes and orders use Google Sheets.

## Workflow

Timeline (Mon–Fri only):

```
  9:30 GMT+7
  ─────────────
  EventBridge ──────► PostMenu Lambda
                            │
                            ├──► SSM (config)
                            ├──► Slack DM       (latest message from menu user → parse dishes)
                            ├──► Google Sheets  (write dish list)
                            ├──► Slack channel  (post menu → get message_ts)
                            └──► DynamoDB       (store date, message_ts)

  ─ ─ ─ ─ ─ ─ ─ ─ ─
  Users react in Slack with :one:, :two:, :three:, … to choose a dish.
  ─ ─ ─ ─ ─ ─ ─ ─ ─

  10:20 GMT+7 (schedule)
  ─────────────
  EventBridge ──────► CollectOrders Lambda
                            │
                            ├──► DynamoDB, Slack (reactions.get, users.list), Google Sheets
                            ├──► If user reacted 2+ dishes: ping in thread "Bạn đang đặt 2 món, nhà bếp chỉ ghi nhận món N"
                            └──► Reply under menu: "Đã ghi nhận danh sách đặt món :bee-like:"

  Any time (Slack Events API)
  ─────────────
  User replies under today's menu ──► Slack ──► SlackEvents Lambda URL
                                                │
                                                └──► Invoke CollectOrders (triggeredBy: slack_reply)
                                                     → write sheet, react :white_check_mark: on that reply
```

**In short:** Menu at 9:30 → users react → at 10:20 orders are collected; users with 2+ reactions get one dish (first) and a ping; schedule run posts a confirmation reply. A reply under the menu can re-run CollectOrders and get a ✅ on the reply.

## Folders

- **`iac/`** – AWS SAM: DynamoDB, EventBridge schedules, Lambdas (post-menu, collect-orders, **slack-events**), Lambda Function URL for Slack Events. See `iac/README.md` and `iac/config/parameter-store-keys.md`.
- **`serverless/`** – Lambda source: **post-menu**, **collect-orders**, **slack-events** (Node.js 20).

## Deploy

From repo root: `make deploy` (or `cd iac && sam build && sam deploy --guided`). Create SSM parameters under `/slack-dishes/` before first run (see `iac/config/parameter-store-keys.md`). For Slack Events (reply-under-menu → re-run CollectOrders), add `/slack-dishes/signing-secret` and in the Slack app set **Event Subscriptions** Request URL to the deployed **SlackEventsFunctionUrl** (output after deploy), and subscribe to **message.channels** (and **message.groups** if you use private channels).

## AWS Free Tier

This setup is designed to stay within **AWS Free Tier** where possible:

| Resource | Free tier (12 months) | This app |
|----------|------------------------|----------|
| **Lambda** | 1M requests/month, 400,000 GB‑seconds | Schedule: ~2/day × 2; + slack-events on each reply under menu |
| **DynamoDB** | 25 GB storage, 1M read + 1M write (on‑demand) | Single table, few items per day |
| **EventBridge** | 14M events/month | 2 rules × ~22 weekdays ≈ 44 invocations/month |
| **SSM Parameter Store** | Standard parameters (10k), no charge | Config and secrets under `/slack-dishes/` |

One Lambda Function URL (slack-events) is public so Slack can POST; no always-on servers. After 12 months, same usage remains low cost (pay-per-request DynamoDB, Lambda per request).
