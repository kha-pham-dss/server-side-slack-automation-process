# IaC – Slack dishes ordering (Option A)

AWS SAM template for **Option A**: scheduled Lambdas (9:30 PostMenu, 10:20 CollectOrders, **10:45 Zalo sheet summary** VNT). Zalo Lambda reads the same DynamoDB menu row and calls `reactions.get` to reconcile counts vs the sheet snippet before sending Zalo; on mismatch it replies in the menu thread. Slack Events URL optional. CollectOrders uses Slack `reactions.get`.

## Prerequisites

- AWS CLI configured
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) installed
- SSM Parameter Store parameters under `/slack-dishes/` – see `config/parameter-store-keys.md`

## Deploy

1. Create SSM parameters (see `config/parameter-store-keys.md`).
2. Install Lambda dependencies (from repo root):
   ```bash
   npm install --prefix serverless/post-menu
   npm install --prefix serverless/collect-orders
   npm install --prefix serverless/slack-events
   npm install --prefix serverless/zalo-sheet-summary
   ```
3. Build and deploy:
   ```bash
   cd iac
   sam build
   sam deploy --guided
   ```
   Use `--guided` once to save settings; then use `sam deploy` for later updates.

## Resources

- **DynamoDB:** `slack-dishes-menu-message` (partition key: `date` = YYYY-MM-DD)
- **Lambdas:** `slack-dishes-post-menu`, `slack-dishes-collect-orders`, `slack-dishes-zalo-sheet-summary`, optional `slack-dishes-slack-events` (Function URL)
- **EventBridge:** `post-menu-daily`, `collect-orders-daily`, `zalo-sheet-summary-daily` (10:45 GMT+7; see `template.yaml` for UTC cron)

## Timezone

Cron expressions are in UTC. For 9:30 / 10:20 in your timezone, adjust in `template.yaml` (e.g. JST = UTC+9 → 9:30 JST = `cron(30 0 * * ? *)`).
