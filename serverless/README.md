# Serverless – Slack dishes ordering
Lambda functions for the Slack dishes flow:

- **post-menu** – Runs at **9:30 GMT+7** (Mon–Fri). Reads latest DM with menu source user (mỗi dòng = một món), posts menu to Slack channel (bot token), stores `message_ts` + DM thread ref in DynamoDB. DM `Bỏ qua hôm nay` → skip. Ảnh trong thread DM lúc 9h30 được nhúng ngay; nếu chưa có ảnh, **menu-images-sync** poll sau.
- **menu-images-sync** – **Event-driven:** `slack-events` invoke khi `message.im` có ảnh trong thread menu DM. **Fallback:** poll thread mỗi 10 phút trong cửa sổ **POST_MENU → ZALO_SUMMARY**. Khi có ảnh → `chat.update` tin menu channel → `images_sync_complete` → dừng poll trong ngày.
- **collect-orders** – Chỉ invoke từ **slack-events** khi user reply trong thread menu hôm nay và @Mr.Chef. Parse `2x`–`5x` + tên món từ tin reply → lưu `slack-dishes-order-overrides` (theo ngày GMT+7) → đọc `reactions.get` + overrides → ghi sheet + S62. Suất 30k: tối đa 4 món; suất 35k (`:up:`): tối đa 5 món — vượt giới hạn (kể cả sau khi nhân `2x`–`5x`) thì ping ngắn trong thread (vd. `5 món / suất 30k`); không cắt đơn vì qty. Trước khi ghi sheet: **ensure** tab `Tháng {m} / {y}` (dup tháng gần nhất nếu thiếu). Trước 11h: reply "Đã ghi nhận…" + :white_check_mark: trên tin @Mr.Chef; sau 11h: ping reconcile kèm đơn user.
- **ensure-month-sheet** – **Schedule** cuối tháng **17:05 UTC** (= **00:05 GMT+7** ngày 1). Dup tab `Tháng N / YYYY` gần nhất → đổi tên tháng hiện tại → clear block đặt món + ô S62. CollectOrders / ZaloSheetSummary cũng gọi lazy cùng helper.
- **sync-slack-ids** – **Invoke thủ công** (không schedule). Đọc tên từ `orders-user-range`, khớp `users.list`, ghi Slack `U…` vào cột ID (mặc định `BZ15:BZ100`). Chạy sau khi thêm user mới hoặc trước khi bật khớp theo ID. Shared helpers: `serverless/shared` (`@slack-dishes/shared`).
- **slack-events** – HTTP endpoint (Lambda Function URL). **DM menu:** `message.im` + ảnh trong thread menu hôm nay → invoke menu-images-sync. **Control channel:** tin `POST: …` → gửi thẳng vào `channel-id`. Reply dưới menu channel + @Mr.Chef → collect-orders.
- **control-channel-post** – Invoke async từ slack-events. Format: `POST: <nội dung>` (vd. `POST: @channel, cho mình thu tiền cơm nhé`). Đích: SSM `channel-id`. Control channel private — quyền gửi lệnh qua membership channel.
- **zalo-sheet-summary** – Runs at **10:45 GMT+7** (Mon–Fri). Reads the sheet column range (default `M58:M72` on the same tab as dishes), builds one Zalo group message. Before send: reads today’s menu from **DynamoDB**, calls Slack **`reactions.get`**, and compares (1) total dish emoji reactions (no `:up:`, no bot) to the sheet line **“Tổng N suất”** when present; (2) total `:up:` reactions (no bot) to the sum of all **`N 40k`** tokens in the sheet text (any integer **N** with a space before `40k`, e.g. `10 40k`). On mismatch: **`console.warn`** and a **reply in the menu message thread** (leading `<@user>` ping; default user overridable with **`RECONCILE_NOTIFY_SLACK_USER_ID`**). Sheet, Zalo, and `bot-token`: SSM; Lambda **`TABLE_NAME`** is set by SAM. Local: `../scripts/zalo/send-sheet-summary-local.mjs` — merge SSM + `.env`; set **`TABLE_NAME=slack-dishes-menu-message`** (or your table name) if you want the Slack reconcile + thread reply when testing locally.

## Runtime

Node.js 20 (ES modules).

## Build

From this directory, install dependencies for each function (required for SAM deploy):

```bash
cd post-menu && npm install && cd ..
cd collect-orders && npm install && cd ..
cd slack-events && npm install && cd ..
cd control-channel-post && npm install && cd ..
cd zalo-sheet-summary && npm install && cd ..
cd ensure-month-sheet && npm install && cd ..
cd menu-images-sync && npm install && cd ..
cd sync-slack-ids && npm install && cd ..
```

Or from repo root:

```bash
npm install --prefix serverless/post-menu
npm install --prefix serverless/collect-orders
npm install --prefix serverless/slack-events
npm install --prefix serverless/control-channel-post
npm install --prefix serverless/zalo-sheet-summary
npm install --prefix serverless/menu-images-sync
npm install --prefix serverless/sync-slack-ids
node serverless/collect-orders/vendor-shared.mjs   # sau npm install local (SAM Makefile tự copy khi deploy)
node serverless/sync-slack-ids/vendor-shared.mjs
```

**Sync Slack IDs (sau deploy):** Lambda không cần input. Trên **AWS Console** → Lambda → `slack-dishes-sync-slack-ids` → **Test** → event `{}` (hoặc để trống) → **Invoke**; xem kết quả trong tab execution / CloudWatch Logs. (CLI: `aws lambda invoke --function-name slack-dishes-sync-slack-ids --payload '{}' out.json` — file chỉ để lưu response, không phải config.)

Deployment is done via the IaC folder (AWS SAM); see `../iac/README.md`.
