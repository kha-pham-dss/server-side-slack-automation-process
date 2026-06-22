# server-side-slack-automation-process

Server-side Slack dishes ordering (vendor mới): đăng thực đơn lúc **10:00 GMT+7**, user react chọn món (tối đa **5 món/người**), lúc **11:00 GMT+7** tổng hợp đơn từ Slack reactions → ghi Google Sheet + ô **S62** → gửi Zalo nhóm. Tùy chọn: Slack Events API để **reply dưới menu + @Mr.Chef** cập nhật lại đơn (sau 11h: cập nhật sheet, ping reconcile, không gửi lại Zalo). Tất cả ngày/giờ dùng **GMT+7**.

## Workflow

Timeline (T2–T6):

```
  10:00 GMT+7
  ─────────────
  EventBridge ──────► PostMenu Lambda
                            │
                            ├──► SSM (config)
                            ├──► Slack DM       (tin nhắn mới nhất từ menu-dm-user-id → parse món)
                            ├──► Slack channel  (post menu + add reaction :one:…:twenty:, :up:)
                            └──► DynamoDB
                                  • slack-dishes-menu-message (channel_id, message_ts)
                                  • slack-dishes-dishes-menu   (danh sách món theo ngày)

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
                                                        kèm đơn user (vd. "suất 35k 1+2+3+4, cho E")
                                                        — không gửi lại Zalo
```

**Tóm tắt:** 10h đăng menu → user react (≤5 món, :up: = 35k) → 11h Zalo lambda tổng hợp từ reactions, ghi sheet + S62, gửi Zalo (nếu bật). Reply @Mr.Chef dưới menu luôn chạy lại CollectOrders; sau 11h chỉ cập nhật sheet và ping reconcile thủ công.

## PostMenu — tin Slack

Cấu trúc message (Block Kit):

1. **Thực đơn hôm nay:**
2. Giá: `4 món + 1 rau => 30k`, `5 món + 1 rau => 35k`, ghi chú mặc định 30k / nhà bếp tự thêm món nếu react ít hơn 4
3. Danh sách món chia **2–3 cột** (~3–4 món/cột), mỗi dòng `:emoji: (Tên món)`
4. `:up: để upsize lên 35k`

Nguồn món: DM Slack của user trong SSM `menu-dm-user-id`. Sau khi post, danh sách món lưu vào DynamoDB **`slack-dishes-dishes-menu`** (partition key `date` GMT+7, attribute `dishes`). DM `Bỏ qua hôm nay` → không post Slack, không ghi DynamoDB.

## Đặt món & giá

| Hằng số | Giá trị | File |
|---------|---------|------|
| Giá mặc định | 30.000đ | `serverless/shared/meal-constants.js` |
| Giá upsize (`:up:`) | 35.000đ | cùng file |
| Tối đa món trên menu | 20 | cùng file |
| Tối đa món/user | 5 | cùng file |

Ghi đè giá qua SSM: `orders-default-price`, `orders-upsize-price`.

**Sheet mỗi user (như cũ):** cột ngày có cặp (món, giá). Cột món = chuỗi index `1+2+3`; cột giá = `30000` hoặc `35000`.

## Zalo summary — tin gửi đi

Lambda **build tin tổng hợp in-memory** từ Slack `reactions.get` + **tên món từ DynamoDB** (`slack-dishes-dishes-menu`), rồi:

1. **Gửi Zalo** — biến `zaloMessage` trên Lambda (không đọc sheet)
2. **Ghi sheet** — copy cùng nội dung vào S62 + giá từng user (chỉ ghi)

Sheet chỉ dùng để **khớp tên user** đặt món và ghi giá — không còn `dishes-range`.

```
suất 30k 1+2+3 (Phở+Bún+Cơm), cho A
suất 30k 2+3+4 (Bún+Cơm+Canh), cho B
suất 35k 1+2+3+4 (Phở+Bún+Cơm+Canh), cho E
Tổng 3 suất 30k, 1 suất 35k nhé ạ
```

Ô ghi tin: **`S62`** (mặc định). Ghi đè bằng env `ZALO_SUMMARY_CELL` hoặc SSM `zalo-summary-cell`.

**Gửi Zalo:** trong `serverless/zalo-sheet-summary/job.js`, `ZALO_SEND_DISABLED = true` → chỉ log + ghi sheet (ngày đầu gửi tay). Đổi `false` và deploy khi muốn auto gửi.

## Slack emoji món

Reaction theo index món (0-based trong code, hiển thị 1-based cho user):

- Món 1–10: `:one:` … `:nine:`, `:keycap_ten:`
- Món 11–20: `:eleven:` … `:twenty:` — cần **custom emoji** trong workspace nếu Slack không có sẵn

## Lịch & múi giờ

| Sự kiện | GMT+7 | Cron UTC (EventBridge) |
|---------|-------|-------------------------|
| PostMenu | 10:00 T2–T6 | `cron(0 3 ? * MON-FRI *)` |
| ZaloSheetSummary | 11:00 T2–T6 | `cron(0 4 ? * MON-FRI *)` |
| CollectOrders | Không schedule | Chỉ invoke từ Slack Events |

Hằng số trong `serverless/shared/time-constants.js`. Khóa ngày DynamoDB = **YYYY-MM-DD theo GMT+7**.

## Folders

- **`iac/`** – AWS SAM: DynamoDB, EventBridge, Lambdas, Function URL. Xem `iac/README.md`, `iac/config/parameter-store-keys.md`.
- **`serverless/`** – Lambda source: **post-menu**, **collect-orders**, **zalo-sheet-summary**, **slack-events**, **sync-slack-ids**.
- **`serverless/shared/`** – logic dùng chung (`@slack-dishes/shared`):
  - `time-constants.js` — lịch, GMT+7, cutoff 11h
  - `meal-constants.js` — giá, max món, emoji, S62 default
  - `dynamo-dishes.js` — đọc/ghi bảng dishes menu
  - `orders.js` — parse reactions, format Zalo, ghi sheet + S62

## Deploy

```bash
make deploy
# hoặc: cd iac && sam build && sam deploy --guided
```

Trước lần chạy đầu: tạo SSM parameters dưới `/slack-dishes/` (xem `iac/config/parameter-store-keys.md`).

**Slack Events** (reply dưới menu → CollectOrders):

1. Thêm `/slack-dishes/signing-secret`
2. Slack app → Event Subscriptions → Request URL = **SlackEventsFunctionUrl** (output sau deploy)
3. Subscribe **message.channels** (+ **message.groups** nếu kênh private)

**Env Lambda (SAM `template.yaml`):**

| Biến | Mặc định | Mô tả |
|------|----------|--------|
| `TABLE_NAME` | `slack-dishes-menu-message` | Metadata tin menu Slack (channel, ts) |
| `DISHES_TABLE_NAME` | `slack-dishes-dishes-menu` | Danh sách món theo ngày |
| `ZALO_SUMMARY_CELL` | `S62` | Ô sheet ghi tin Zalo tổng hợp |
| `RECONCILE_NOTIFY_SLACK_USER_ID` | `U02SJRNAM2M` | User được ping sau 11h khi có cập nhật đơn |
| `MR_CHEF_SLACK_USER_ID` | (SSM) | User phải được @ trong reply để trigger CollectOrders |

**Zalo:** SSM `zalo-group-id`, `zalo-cookies-json`, `zalo-imei`, `zalo-user-agent` + sheet keys (orders). Cần `bot-token`, `TABLE_NAME`, `DISHES_TABLE_NAME`.

**Test local Zalo/summary:** `node --env-file=.env scripts/zalo/send-sheet-summary-local.mjs` (cần `TABLE_NAME`, `DISHES_TABLE_NAME`, tùy chọn `ZALO_SUMMARY_CELL`).

## AWS Free Tier

| Resource | Free tier (12 tháng) | App này |
|----------|----------------------|---------|
| **Lambda** | 1M requests/tháng | ~2 schedule/ngày × ~22 ngày + slack-events khi reply |
| **DynamoDB** | 25 GB storage (always free); on-demand requests ~$0 ở quy mô này | Hai bảng, vài item/ngày |
| **EventBridge** | 14M events/tháng | 2 rules × ~22 ngày ≈ 44 lần/tháng |
| **SSM** | Standard parameters | Config `/slack-dishes/` |

Một Lambda Function URL (slack-events) public để Slack POST. Không server luôn bật.
