# Parameter Store (SSM) – free tier

Config is stored in **SSM Parameter Store** under the prefix `/slack-dishes/`. Standard parameters are included in the free tier. Use **SecureString** for tokens.

**Tên parameter** phải khớp **chính xác** các cột trong bảng (dạng `sheet-id`, `sheet-credentials`, … — dấu gạch ngang). Tên kiểu `sheet_id` hoặc path khác prefix sẽ không map vào code.

Lambda đọc SSM bằng `GetParametersByPath` có **phân trang** (mỗi lần tối đa 10 key); code trong repo đã gom đủ các trang. Nếu bạn dùng bản code cũ chỉ một request, khi có **hơn 10** parameter dưới `/slack-dishes/` thì một số key (như `sheet-id`) có thể không bao giờ được load → lỗi `missing_sheet_config`.


| Parameter                              | Type                    | Description                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/slack-dishes/bot-token`              | SecureString            | Slack Bot User OAuth Token (xoxb-...). Scopes: `chat:write`, `reactions:read`, `reactions:write`, `users:read`, `im:write`, `im:history`, `files:read` (đọc ảnh DM thread + `chat.update` menu).                                                                                   |
| `/slack-dishes/signing-secret`         | SecureString            | Slack Signing Secret (from app Basic Information). Required for Slack Events API endpoint (SlackEvents Lambda) to verify requests. Slack app Event Subscriptions: **message.channels** (+ **message.groups** nếu kênh private). Control channel: tin `POST: …` → gửi vào `channel-id`. Menu thread: @Mr.Chef → CollectOrders. |
| `/slack-dishes/channel-id`             | String                  | Target Slack channel ID where the menu is posted; **control-channel-post** cũng gửi tin `POST:` vào đây                                                                                                                                                                                                                       |
| `/slack-dishes/control-channel-id`     | String (optional)       | Channel **private** gửi lệnh `POST: …`. slack-events nhận event → invoke control-channel-post. Bot phải được invite; quyền gửi lệnh qua membership channel. Subscribe **message.groups** nếu channel private.                                                                                                                 |
| `/slack-dishes/menu-dm-user-id`        | String (optional)       | Slack user ID: tin DM mới nhất = danh sách món; **reply ảnh trong thread** dưới tin đó để sync lên menu channel. Default: `U02SJRNAM2M`.                                                                                                                                                                                       |
| `/slack-dishes/webhook-url`            | SecureString (optional) | Incoming Webhook URL; if set, PostMenu posts via webhook instead of chat.postMessage                                                                                                                                                                                                                                          |
| `/slack-dishes/sheet-id`               | String                  | Google Spreadsheet ID (CollectOrders / Zalo ghi orders + ô S62; PostMenu không ghi sheet)                                                                                                                                                                                                                                     |
| `/slack-dishes/sheet-credentials`      | SecureString            | Full JSON content of Google Cloud service account key file. Share the spreadsheet with the service account email as Editor.                                                                                                                                                                                                   |
| `/slack-dishes/dishes-sheet-name`      | String (optional)       | Tab sheet cho **orders** (không còn ghi danh sách món). Mặc định: `Tháng {month} / {year}` (GMT+7).                                                                                                                                                                                                                           |
| `/slack-dishes/orders-user-range`      | String (optional)       | A1 range cột tên user (e.g. `A15:A100`). Default: `A15:A100`.                                                                                                                                                                                                                                                                 |
| `/slack-dishes/orders-slack-id-column` | String (optional)       | Cột **Slack user ID** (`U…`), mặc định `BZ`. Cùng hàng với `orders-user-range` (vd. `A15:A100` → `BZ15:BZ100`). **CollectOrders** đọc cột này để khớp order; **SyncSlackIds** Lambda (gọi tay) ghi ID từ tên sheet + Slack.                                                                                                   |
| `/slack-dishes/orders-slack-id-range`  | String (optional)       | **Legacy:** full A1 range (e.g. `AA15:AA100`). Nếu set thì dùng thay cho `orders-slack-id-column`.                                                                                                                                                                                                                            |
| `/slack-dishes/orders-date-row`        | String (optional)       | Row number for day header (merged 2 cells = one day). Default: `12`.                                                                                                                                                                                                                                                          |
| `/slack-dishes/orders-column-start`    | String (optional)       | First column for orders (each day = 2 cols: dish number, price). Default: `B`.                                                                                                                                                                                                                                                |
| `/slack-dishes/orders-default-price`   | String (optional)       | Giá mặc định mỗi suất (VND). Default: `30000`.                                                                                                                                                                                                                                                                                |
| `/slack-dishes/orders-upsize-price`    | String (optional)       | Giá khi user react :up: (VND). Default: `35000`.                                                                                                                                                                                                                                                                              |
| `/slack-dishes/orders-max-days`        | String (optional)       | Max day columns to scan (e.g. 31). Default: `31`.                                                                                                                                                                                                                                                                             |
| `/slack-dishes/zalo-group-id`          | String (optional)       | Zalo **group** id. Bắt buộc cho **ZaloSheetSummary** (11h). `node scripts/zalo/list-groups.mjs` |
| `/slack-dishes/zalo-cookies-json`      | SecureString (optional) | JSON cookie: Chrome export `{"url":"https://chat.zalo.me","cookies":[...]}` hoặc mảng `cookies`. Cập nhật khi session hết hạn.                                                                                                                                                                                                |
| `/slack-dishes/zalo-imei`              | SecureString (optional) | `localStorage.getItem('z_uuid')` trên chat.zalo.me (zca-js gọi là `imei`).                                                                                                                                                                                                                                                    |
| `/slack-dishes/zalo-user-agent`        | String (optional)       | User-Agent cùng profile trình duyệt đã export cookie.                                                                                                                                                                                                                                                                         |
| `/slack-dishes/zalo-language`          | String (optional)       | Mặc định `vi`.                                                                                                                                                                                                                                                                                                                |


**DynamoDB (SAM):** `slack-dishes-menu-message` (metadata menu Slack), `slack-dishes-dishes-menu` (danh sách món theo ngày GMT+7). Env `TABLE_NAME`, `DISHES_TABLE_NAME`.

**Ghi chú:** Cửa sổ poll ảnh menu = `POST_MENU` + 5 phút → trước `ZALO_SUMMARY` (`serverless/shared/time-constants.js`). Đổi giờ menu (vd. 9h): sửa `POST_MENU_HOUR_GMT7` + cron PostMenu trong `iac/template.yaml`; nếu menu &lt; 9h mở rộng giờ UTC trong cron `menu-images-sync-poll`.

Example (AWS CLI):

```bash
aws ssm put-parameter --name /slack-dishes/bot-token --value "xoxb-..." --type SecureString
aws ssm put-parameter --name /slack-dishes/channel-id --value "C08DWNHH753" --type String
# Control channel (private) — POST: @channel, nội dung... → bot gửi vào channel-id:
# aws ssm put-parameter --name /slack-dishes/control-channel-id --value "C0CONTROL123" --type String
# Optional:
aws ssm put-parameter --name /slack-dishes/webhook-url --value "https://hooks.slack.com/..." --type SecureString
# For Lambda + Google Sheets API (Option A):
aws ssm put-parameter --name /slack-dishes/sheet-id --value "YOUR_SPREADSHEET_ID" --type String
aws ssm put-parameter --name /slack-dishes/sheet-credentials --value "$(cat path/to/service-account.json)" --type SecureString
# Optional: menu source and sheet:
# aws ssm put-parameter --name /slack-dishes/menu-dm-user-id --value "U02SJRNAM2M" --type String
# aws ssm put-parameter --name /slack-dishes/dishes-sheet-name --value "Dishes" --type String
# aws ssm put-parameter --name /slack-dishes/orders-user-range --value "A15:A100" --type String
# aws ssm put-parameter --name /slack-dishes/orders-slack-id-column --value "BZ" --type String
# aws ssm put-parameter --name /slack-dishes/orders-date-row --value "12" --type String
# aws ssm put-parameter --name /slack-dishes/orders-column-start --value "B" --type String
# aws ssm put-parameter --name /slack-dishes/orders-default-price --value "30000" --type String
# aws ssm put-parameter --name /slack-dishes/orders-upsize-price --value "35000" --type String
# aws ssm put-parameter --name /slack-dishes/orders-max-days --value "31" --type String
# Optional Zalo — Lambda 11h GMT+7 (tóm tắt từ reactions + DynamoDB dishes menu):
# aws ssm put-parameter --name /slack-dishes/zalo-group-id --value "YOUR_GROUP_ID" --type String
# aws ssm put-parameter --name /slack-dishes/zalo-imei --value "YOUR_Z_UUID" --type SecureString
# aws ssm put-parameter --name /slack-dishes/zalo-user-agent --value "Mozilla/5.0 ..." --type String
# aws ssm put-parameter --name /slack-dishes/zalo-cookies-json --value "$(jq -c . < path/to/chrome-export.json)" --type SecureString
```

Do not commit tokens or credentials. Create parameters before first deploy or run.