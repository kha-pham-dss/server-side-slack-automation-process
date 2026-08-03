# IaC – Slack dishes ordering (Option A)

AWS SAM template for **Option A**: scheduled Lambdas (PostMenu, **Zalo sheet summary**). CollectOrders chỉ qua Slack Events (@Mr.Chef trong thread menu). Zalo Lambda reads DynamoDB menu row and `reactions.get` before send.

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
   npm install --prefix serverless/menu-images-sync
   npm install --prefix serverless/sync-slack-ids
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
- **Lambdas:** `slack-dishes-post-menu`, `slack-dishes-menu-images-sync`, `slack-dishes-collect-orders`, `slack-dishes-sync-slack-ids` (manual: fill Slack user ID column on sheet), `slack-dishes-zalo-sheet-summary`, optional `slack-dishes-slack-events` (Function URL)
- **EventBridge:** `post-menu-daily`, `menu-images-sync-poll` (mỗi 10 phút UTC 2–3h; cửa sổ GMT+7 trong Lambda), `zalo-sheet-summary-daily`.

## Timezone

Cron expressions are in UTC. For 9:30 / 10:20 in your timezone, adjust in `template.yaml` (e.g. JST = UTC+9 → 9:30 JST = `cron(30 0 * * ? *)`).
