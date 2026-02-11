# Parameter Store (SSM) – free tier

Config is stored in **SSM Parameter Store** under the prefix `/slack-dishes/`. Standard parameters are included in the free tier. Use **SecureString** for tokens.

| Parameter | Type | Description |
|-----------|------|-------------|
| `/slack-dishes/bot-token` | SecureString | Slack Bot User OAuth Token (xoxb-...) |
| `/slack-dishes/channel-id` | String | Target Slack channel ID |
| `/slack-dishes/webhook-url` | SecureString (optional) | Incoming Webhook URL; if set, PostMenu posts via webhook instead of chat.postMessage |
| `/slack-dishes/dishes-api-url` | String | GET endpoint URL for dishes API |
| `/slack-dishes/order-api-url` | String | POST endpoint URL for ordering API |
| `/slack-dishes/sheet-id` | String | Google Spreadsheet ID (from the sheet URL; used when backend is Lambda + Google Sheets API) |
| `/slack-dishes/sheets-credentials` | SecureString | Full JSON content of Google Cloud service account key file (for Lambda + Sheets API). Share the spreadsheet with the service account email as Editor. |

Example (AWS CLI):

```bash
aws ssm put-parameter --name /slack-dishes/bot-token --value "xoxb-..." --type SecureString
aws ssm put-parameter --name /slack-dishes/channel-id --value "C08DWNHH753" --type String
aws ssm put-parameter --name /slack-dishes/dishes-api-url --value "https://api.example.com/dishes" --type String
aws ssm put-parameter --name /slack-dishes/order-api-url --value "https://api.example.com/orders" --type String
# Optional:
aws ssm put-parameter --name /slack-dishes/webhook-url --value "https://hooks.slack.com/..." --type SecureString
# For Lambda + Google Sheets API (Option A):
aws ssm put-parameter --name /slack-dishes/sheet-id --value "YOUR_SPREADSHEET_ID" --type String
aws ssm put-parameter --name /slack-dishes/sheets-credentials --value "$(cat path/to/service-account.json)" --type SecureString
```

Do not commit tokens or credentials. Create parameters before first deploy or run.
