# Parameter Store (SSM) – free tier

Config is stored in **SSM Parameter Store** under the prefix `/slack-dishes/`. Standard parameters are included in the free tier. Use **SecureString** for tokens.

| Parameter | Type | Description |
|-----------|------|-------------|
| `/slack-dishes/bot-token` | SecureString | Slack Bot User OAuth Token (xoxb-...). Scopes: `chat:write`, `reactions:read`, `reactions:write`, `users:read`, `im:write`, `im:history` (DM to read menu from menu source user). |
| `/slack-dishes/signing-secret` | SecureString | Slack Signing Secret (from app Basic Information). Required for Slack Events API endpoint (SlackEvents Lambda) to verify requests. |
| `/slack-dishes/channel-id` | String | Target Slack channel ID where the menu is posted |
| `/slack-dishes/menu-dm-user-id` | String (optional) | Slack user ID whose **latest DM message** is used as menu source (first line = title, skip; rest = dish names). Default: `U02SJRNAM2M`. |
| `/slack-dishes/webhook-url` | SecureString (optional) | Incoming Webhook URL; if set, PostMenu posts via webhook instead of chat.postMessage |
| `/slack-dishes/sheet-id` | String | Google Spreadsheet ID (PostMenu writes dishes to sheet and posts to Slack; CollectOrders reads/writes orders) |
| `/slack-dishes/sheet-credentials` | SecureString | Full JSON content of Google Cloud service account key file. Share the spreadsheet with the service account email as Editor. |
| `/slack-dishes/dishes-sheet-name` | String (optional) | Tab/sheet name for dishes list and orders. If not set: `Tháng {month} / {year}` (e.g. `Tháng 2 / 2026`) from current UTC date. |
| `/slack-dishes/dishes-range` | String (optional) | A1 range where PostMenu **writes** the dish list from DM (e.g. `N4:N8`). Default: `N3:N8`. |
| `/slack-dishes/orders-user-range` | String (optional) | A1 range cột tên user (e.g. `A15:A100`). Default: `A15:A100`. |
| `/slack-dishes/orders-date-row` | String (optional) | Row number for day header (merged 2 cells = one day). Default: `12`. |
| `/slack-dishes/orders-column-start` | String (optional) | First column for orders (each day = 2 cols: dish number, price). Default: `B`. |
| `/slack-dishes/orders-default-price` | String (optional) | Giá mặc định mỗi suất (VND). Default: `35000`. |
| `/slack-dishes/orders-upsize-price` | String (optional) | Giá khi user react :up: (VND). Default: `40000`. |
| `/slack-dishes/orders-max-days` | String (optional) | Max day columns to scan (e.g. 31). Default: `31`. |

Example (AWS CLI):

```bash
aws ssm put-parameter --name /slack-dishes/bot-token --value "xoxb-..." --type SecureString
aws ssm put-parameter --name /slack-dishes/channel-id --value "C08DWNHH753" --type String
# Optional:
aws ssm put-parameter --name /slack-dishes/webhook-url --value "https://hooks.slack.com/..." --type SecureString
# For Lambda + Google Sheets API (Option A):
aws ssm put-parameter --name /slack-dishes/sheet-id --value "YOUR_SPREADSHEET_ID" --type String
aws ssm put-parameter --name /slack-dishes/sheet-credentials --value "$(cat path/to/service-account.json)" --type SecureString
# Optional: menu source and sheet:
# aws ssm put-parameter --name /slack-dishes/menu-dm-user-id --value "U02SJRNAM2M" --type String
# aws ssm put-parameter --name /slack-dishes/dishes-sheet-name --value "Dishes" --type String
# aws ssm put-parameter --name /slack-dishes/dishes-range --value "N3:N8" --type String
# aws ssm put-parameter --name /slack-dishes/orders-user-range --value "A15:A100" --type String
# aws ssm put-parameter --name /slack-dishes/orders-date-row --value "12" --type String
# aws ssm put-parameter --name /slack-dishes/orders-column-start --value "B" --type String
# aws ssm put-parameter --name /slack-dishes/orders-default-price --value "35000" --type String
# aws ssm put-parameter --name /slack-dishes/orders-max-days --value "31" --type String
```

Do not commit tokens or credentials. Create parameters before first deploy or run.
