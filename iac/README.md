# IaC – Slack dishes ordering (Option A)

AWS SAM template for **Option A**: scheduled Lambdas only (9:30 PostMenu, 10:20 CollectOrders). No API Gateway; 10:20 Lambda uses Slack `reactions.get`.

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
- **Lambdas:** `slack-dishes-post-menu`, `slack-dishes-collect-orders`
- **EventBridge:** `post-menu-daily` (9:30 UTC), `collect-orders-daily` (10:20 UTC)

## Timezone

Cron expressions are in UTC. For 9:30 / 10:20 in your timezone, adjust in `template.yaml` (e.g. JST = UTC+9 → 9:30 JST = `cron(30 0 * * ? *)`).
