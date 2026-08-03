# server-side-slack-automation-process

Server-side Slack dishes ordering (vendor mới): đăng thực đơn lúc **9:30 GMT+7**, user react chọn món (tối đa **5 món/người**), lúc **11:00 GMT+7** tổng hợp đơn từ Slack reactions → ghi Google Sheet + ô **S62** → gửi Zalo nhóm. Tùy chọn: Slack Events API để **reply dưới menu + @Mr.Chef** cập nhật lại đơn (sau 11h: cập nhật sheet, ping reconcile, không gửi lại Zalo). Tất cả ngày/giờ dùng **GMT+7**.

## Features

| Feature | Mô tả |
|---------|--------|
| **Post menu** | 9:30 GMT+7 (T2–T6): đọc list món từ DM, post Block Kit lên channel, lưu DynamoDB; DM `Bỏ qua hôm nay` → skip |
| **Menu images sync** | Ảnh reply trong thread DM → `chat.update` tin menu (event `message.im` + poll fallback) |
| **Đặt món bằng react** | `:one:`…`:twenty:` chọn món; `:up:` upsize 35k (mặc định 30k; ≤4 / ≤5 phần) |
| **Qty override `@Mr.Chef`** | Reply thread `2x`–`5x` + tên món → Dynamo overrides → sheet/Zalo; cảnh báo nếu vượt limit phần |
| **Collect orders** | Slack Events → ghi sheet + S62; trước 11h ✅; sau 11h ping reconcile |
| **Zalo sheet summary** | ~11:00 GMT+7: tổng hợp từ reactions + dishes Dynamo → gửi Zalo + ghi sheet |
| **Auto month sheet** | Ngày 1 ~00:05 GMT+7 (+ lazy khi Collect/Zalo): dup tab `Tháng N / YYYY` gần nhất, clear data đặt món trên tab mới |
| **Control channel `POST:`** | Channel private gửi `POST: …` → bot post vào channel đặt cơm |
| **Sync Slack IDs** | Invoke tay: map tên sheet → cột Slack user ID (mặc định `BZ`) |
| **Dish name normalize** | Strip number-list prefix; typo nhà bếp (`gián`→`rán`, …); match món ưu tiên exact (tránh `gà rang` → `Gà rán`) |

Design / plan gần đây: `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## Workflow

Timeline (T2–T6):

```
  9:30 GMT+7
  ─────────────
  EventBridge ──────► PostMenu Lambda
                            │
                            ├──► SSM (config)
                            ├──► Slack DM       (tin mới nhất từ menu-dm-user-id → parse món)
                            ├──► Slack channel  (post menu text; ảnh có thể thêm sau)
                            └──► DynamoDB
                                  • slack-dishes-menu-message (channel_id, message_ts,
                                    menu_dm_channel_id, menu_dm_parent_ts, images_sync_complete, …)
                                  • slack-dishes-dishes-menu   (danh sách món theo ngày)

  Sau POST_MENU → trước ZALO_SUMMARY
  ─────────────
  Ảnh reply thread DM menu ──► SlackEvents (message.im) ──► MenuImagesSync Lambda
  (fallback mỗi 10 phút) EventBridge ──► MenuImagesSync Lambda
                            │
                            ├──► Slack DM thread  (conversations.replies)
                            ├──► Slack channel    (chat.update tin menu khi có ảnh)
                            └──► DynamoDB         (images_sync_complete → dừng poll)

  ─ ─ ─ ─ ─ ─ ─ ─ ─
  User react :one: … :twenty: chọn món (tối đa 5 món/user).
  :up: = upsize lên 35k (mặc định 30k).
  ─ ─ ─ ─ ─ ─ ─ ─ ─

  11:00 GMT+7 (schedule)
  ─────────────
  EventBridge ──────► ZaloSheetSummary Lambda
                            │
                            ├──► DynamoDB dishes-menu (tên món) + Slack reactions.get
                            ├──► Build tin tổng hợp in-memory → gửi Zalo (không đọc sheet)
                            └──► Google Sheets (ghi giá/user + copy tin vào S62 — chỉ ghi)

  Bất kỳ lúc nào (Slack Events API)
  ─────────────
  Reply dưới menu hôm nay + @Mr.Chef ──► SlackEvents Lambda URL
                                                │
                                                └──► Invoke CollectOrders (slack_reply)
                                                     → ghi lại sheet + S62
                                                     → :white_check_mark: trên reply
                                                     → Trước 11h: reply "Đã ghi nhận danh sách đặt món :bee-like:"
                                                     → Sau 11h: ping @RECONCILE_NOTIFY_SLACK_USER_ID
                                                        kèm đơn user (vd. "suất 35k Phở+Bún+Cơm+Canh, cho E")
                                                        — không gửi lại Zalo
```

**Tóm tắt:** 9h30 đăng menu → user react (30k ≤4 món, `:up:` = 35k ≤5 món) → 11h Zalo lambda tổng hợp từ reactions, ghi sheet + S62, gửi Zalo (nếu bật). **CollectOrders** chỉ chạy khi reply @Mr.Chef trong thread menu; sau 11h cập nhật sheet + ping reconcile.

## PostMenu — tin Slack

Cấu trúc message (Block Kit):

1. **Thực đơn hôm nay:**
2. Giá: `4 món + 1 rau => 30k`, `5 món + 1 rau => 35k`, ghi chú mặc định 30k / nhà bếp tự thêm món nếu react ít hơn 4
3. Danh sách món chia **các cột** (tối đa 5 món/cột: 1–5 | 6–10 | 11–15 | …), mỗi dòng `:emoji: (Tên món)`
4. `:up: để upsize lên 35k`
5. (Tùy chọn) ảnh món — block `image` với `slack_file` khi đã sync

### Nguồn menu & ảnh (Slack DM)

1. **Trước 9h30** — forward text menu từ Zalo → **Slack DM** với bot (`menu-dm-user-id`). Mỗi dòng không rỗng = một món.
2. **9h30** — PostMenu đọc tin DM mới nhất, post menu **text** lên channel (bot token bắt buộc). Lưu `menu_dm_channel_id` + `menu_dm_parent_ts` vào DynamoDB.
3. **Sau 9h30** — gửi ảnh **reply trong thread** dưới tin menu DM đó (không phải tin DM mới).
4. **MenuImagesSync** chạy **ngay** khi Slack gửi event `message.im` (ảnh mới trong thread) → `chat.update` tin menu channel → `images_sync_complete=true`. **Fallback:** EventBridge poll mỗi **10 phút** trong cửa sổ `POST_MENU+5p` → trước `ZALO_SUMMARY` nếu event bị miss.

DM `Bỏ qua hôm nay` → không post Slack, không ghi DynamoDB (Zalo 11h / CollectOrders cũng skip).

Nếu ảnh đã có trong thread DM lúc 9h30 → PostMenu nhúng luôn và đánh dấu `images_sync_complete` (không cần poll).

Sau khi post, danh sách món lưu vào DynamoDB **`slack-dishes-dishes-menu`** (partition key `date` GMT+7).

## Đặt món & giá

| Hằng số | Giá trị | File |
|---------|---------|------|
| Giá mặc định | 30.000đ | `serverless/shared/meal-constants.js` |
| Giá upsize (`:up:`) | 35.000đ | cùng file |
| Tối đa món trên menu | 20 | cùng file |
| Tối đa món/user (30k) | 4 | `serverless/shared/meal-constants.js` |
| Tối đa món/user (35k, `:up:`) | 5 | cùng file |

Ghi đè giá qua SSM: `orders-default-price`, `orders-upsize-price`.

**Đặt món tùy số lượng:** react emoji trước, rồi reply thread `@Mr.Chef` kèm `2x`–`5x` + tên món. Một món: `@Mr.Chef 2x chả cá`. Nhiều món: `2x chả cá và 2x thịt kho` hoặc `2x chả cá, 3x thịt kho`. Bot lưu override theo ngày (DynamoDB `slack-dishes-order-overrides`) → tin Zalo/sheet hiển thị `Chả cá+Chả cá+Thịt kho+Thịt kho`.

**Sheet mỗi user (như cũ):** cột ngày có cặp (món, giá). Cột món = tên món `Phở+Bún+Cơm`; cột giá = `30000` hoặc `35000`.

## Zalo summary — tin gửi đi

Lambda **build tin tổng hợp in-memory** từ Slack `reactions.get` + **tên món từ DynamoDB** (`slack-dishes-dishes-menu`), rồi:

1. **Gửi Zalo** — biến `zaloMessage` trên Lambda (không đọc sheet)
2. **Ghi sheet** — copy cùng nội dung vào S62 + giá từng user (chỉ ghi)

Sheet chỉ dùng để **khớp tên user** đặt món và ghi giá — không còn `dishes-range`.

```
suất 30k Phở+Bún+Cơm, cho A
suất 30k Bún+Cơm+Canh, cho B
suất 35k Phở+Bún+Cơm+Canh, cho E
Tổng 3 suất 30k, 1 suất 35k nhé ạ
```

Ô ghi tin: **`S62`** (mặc định). Ghi đè bằng env `ZALO_SUMMARY_CELL` hoặc SSM `zalo-summary-cell`.

**Gửi Zalo:** trong `serverless/zalo-sheet-summary/job.js`, `ZALO_SEND_DISABLED = true` → chỉ log + ghi sheet (ngày đầu gửi tay). Đổi `false` và deploy khi muốn auto gửi.

Zalo summary cần SSM `zalo-group-id`, `zalo-cookies-json`, `zalo-imei` (và tùy chọn `zalo-user-agent`). Không liên quan sync ảnh menu.

## Slack emoji món

Reaction theo index món (0-based trong code, hiển thị 1-based cho user):

- Món 1–10: `:one:` … `:nine:`, `:keycap_ten:`
- Món 11–20: `:eleven:` … `:twenty:` — cần **custom emoji** trong workspace nếu Slack không có sẵn

## Lịch & múi giờ

| Sự kiện | GMT+7 | Cron UTC (EventBridge) |
|---------|-------|-------------------------|
| PostMenu | 9:30 T2–T6 | `cron(30 2 ? * MON-FRI *)` |
| MenuImagesSync | Event `message.im` + fallback mỗi 10p (POST_MENU+5p → ZALO_SUMMARY) | `cron(5/10 2-3 ? * MON-FRI *)` + gate trong Lambda |
| ZaloSheetSummary | 11:00 T2–T6 | `cron(0 4 ? * MON-FRI *)` |
| EnsureMonthSheet | ~00:05 GMT+7 ngày 1 | `cron(5 17 L * ? *)` (cuối tháng 17:05 UTC) |
| CollectOrders | Không schedule | Chỉ invoke từ Slack Events |

Hằng số trong `serverless/shared/time-constants.js`. Khóa ngày DynamoDB = **YYYY-MM-DD theo GMT+7**.

Menu 9h30 → poll ảnh ~9:35–10:55. Đổi giờ menu: sửa `POST_MENU_HOUR_GMT7` / `POST_MENU_MINUTE_GMT7` + cron PostMenu trong `iac/template.yaml`.

## Folders

- **`iac/`** – AWS SAM: DynamoDB, EventBridge, Lambdas, Function URL. Xem `iac/README.md`, `iac/config/parameter-store-keys.md`.
- **`serverless/`** – Lambda source: **post-menu**, **menu-images-sync**, **collect-orders**, **ensure-month-sheet**, **zalo-sheet-summary**, **slack-events**, **sync-slack-ids**, **control-channel-post**. Chi tiết: `serverless/README.md`.
- **`serverless/shared/`** – logic dùng chung (`@slack-dishes/shared`):
  - `time-constants.js` — lịch, GMT+7, cửa sổ poll ảnh menu
  - `meal-constants.js` — giá, max món, emoji, S62 default
  - `dynamo-dishes.js` — đọc/ghi bảng dishes menu
  - `dynamo-menu.js` — metadata tin menu Slack + sync ảnh DM thread
  - `menu-dm.js` — đọc DM menu, thread ảnh
  - `menu-slack.js` — Block Kit menu, `chat.update`
  - `orders.js` — parse reactions, format Zalo, ghi sheet + S62
  - `ensure-month-sheet.js` — auto tạo tab `Tháng N / YYYY`
  - `order-qty.js` — parse `2x`–`5x`, match tên món

## Deploy

```bash
make deploy
# hoặc: cd iac && sam build && sam deploy --guided
```

Trước lần chạy đầu:

```bash
npm install --prefix serverless/post-menu
npm install --prefix serverless/menu-images-sync
npm install --prefix serverless/collect-orders
npm install --prefix serverless/slack-events
npm install --prefix serverless/zalo-sheet-summary
npm install --prefix serverless/ensure-month-sheet
npm install --prefix serverless/sync-slack-ids
```

Tạo SSM parameters dưới `/slack-dishes/` (xem `iac/config/parameter-store-keys.md`). Bot token cần scope: `chat:write`, `im:history`, `im:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`.

**Slack Events** (reply dưới menu → CollectOrders):

1. Thêm `/slack-dishes/signing-secret`
2. Slack app → Event Subscriptions → Request URL = **SlackEventsFunctionUrl** (output sau deploy)
3. Subscribe **message.im** (ảnh thread DM menu), **message.channels** (+ **message.groups** nếu kênh private)

**Env Lambda (SAM `template.yaml`):**

| Biến | Mặc định | Mô tả |
|------|----------|--------|
| `TABLE_NAME` | `slack-dishes-menu-message` | Metadata tin menu Slack (channel, ts, DM thread ref, `images_sync_complete`) |
| `DISHES_TABLE_NAME` | `slack-dishes-dishes-menu` | Danh sách món theo ngày |
| `ZALO_SUMMARY_CELL` | `S62` | Ô sheet ghi tin Zalo tổng hợp |
| `RECONCILE_NOTIFY_SLACK_USER_ID` | `U02SJRNAM2M` | User được ping sau 11h khi có cập nhật đơn |
| `MR_CHEF_SLACK_USER_ID` | (SSM) | User phải được @ trong reply để trigger CollectOrders |

**Menu images sync (test):** trong `serverless/menu-images-sync/job.js` đặt `TEST_MODE = true`, invoke tay Lambda → response có `image_file_ids` (không `chat.update`). Đổi `false` trước prod.

## AWS Free Tier

| Resource | Free tier (12 tháng) | App này |
|----------|----------------------|---------|
| **Lambda** | 1M requests/tháng | ~2 schedule/ngày + ~12 tick poll ảnh DM/ngày (skip sau khi sync) + slack-events |
| **DynamoDB** | 25 GB storage (always free); on-demand requests ~$0 ở quy mô này | Hai bảng, vài item/ngày |
| **EventBridge** | 14M events/tháng | ~3 rules × ~22 ngày (post, menu-images-sync, zalo summary) |
| **SSM** | Standard parameters | Config `/slack-dishes/` |

Một Lambda Function URL (slack-events) public để Slack POST. Không server luôn bật.
