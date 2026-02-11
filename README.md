# server-side-slack-automation-process

Server-side setup for a Slack dishes ordering flow (post menu at 9:30, collect reactions at 10:20). Implemented per **IMPLEMENT_GUIDE.md** – **Option A** (scheduled Lambdas only; no public URL; 10:20 uses Slack `reactions.get`).

## Folders

- **`iac/`** – Infrastructure as Code (AWS SAM). DynamoDB, EventBridge schedules, Lambda definitions, IAM. Deploy with `sam build` and `sam deploy`.
- **`serverless/`** – Lambda source: **PostMenu** (9:30) and **CollectOrders** (10:20). Node.js 20.

See [IMPLEMENT_GUIDE.md](IMPLEMENT_GUIDE.md) for full design; Option B (Event Subscriptions + API Gateway) is documented there but not implemented in this repo.
