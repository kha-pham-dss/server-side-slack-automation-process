# Design: Cảnh báo vượt số lượng tính cả hệ số 2x–5x

**Date:** 2026-07-20  
**Status:** Approved (approach A)  
**Scope:** Ping thread khi tổng phần món (sau qty override) vượt giới hạn suất; không cắt/sửa đơn.

## Problem

Hiện `buildOrdersByUserId` chỉ đếm **số loại món** (reaction). Hệ số `2x`–`5x` (Dynamo `order-overrides`) dùng để format Zalo/sheet nhưng **không** tham gia kiểm tra vượt limit.

Ví dụ cần cảnh báo (suất 30k, max 4 phần):

`suất 30k Nem rán+2x Gà rang+2x Thịt chiên xù, cho Chau Nguyen`

→ 1 + 2 + 2 = **5 phần** > 4, nhưng hôm nay chỉ thấy 3 loại món → không ping.

## Goals

- Tổng phần = ∑ (qty của mỗi món), qty mặc định 1, override 2–5 nếu có.
- Vượt max (4 / suất 30k, 5 / suất 35k `:up:`) → ping cùng message/format hiện tại.
- **Chỉ cảnh báo** — không cắt `dishIndices`, không sửa/xóa overrides. User tự sửa rồi @Mr.Chef lại.

## Non-goals

- Đổi logic cắt khi chọn quá nhiều **loại** món (`slice(0, maxDishes)` giữ nguyên).
- Đổi text ping, format Zalo, hoặc parse `2x`.

## Approach (A)

1. Helper `totalPortions(dishIndices, qtyOverrides)` trong `order-qty.js`.
2. Sau khi load `overridesByUserId` trong `aggregateOrderSummaryFromReactions`, bổ sung user vượt tổng phần vào `cappedUserIds` nếu chưa có (tránh ping trùng khi đã vượt vì quá nhiều loại món).
3. `collect-orders` giữ vòng ping hiện tại — không đổi format.

## Counting rules

| Input | Tổng phần |
|-------|-----------|
| Reactions món A, B, C; overrides `{ B: 2, C: 2 }` | 1+2+2 = 5 |
| Chỉ override `{ A: 2 }` không reaction A | 2 (món chỉ có trong overrides vẫn tính) |
| Reactions A–E, không override, suất 30k | 5 loại → đã capped + ping như cũ; không cần thêm entry qty |

Max: `MAX_DISHES_PER_USER_DEFAULT` (4) hoặc `MAX_DISHES_PER_USER_UPSIZE` (5) theo `:up:`.

## Message (không đổi)

```
<@USER_ID> Bạn đang đặt N món / suất 30k
```

`N` = tổng phần (hoặc số loại món khi vượt vì quá nhiều reaction — hành vi cũ). `30k` / `35k` qua `formatPriceLabel`.

## Data flow

```
reactions → buildOrdersByUserId (cắt loại món + cappedUserIds)
         → load overridesByUserId
         → merge qty over-limit vào cappedUserIds (warn-only)
         → collect-orders ping từng entry
```

Sheet / Zalo / overrides: không đổi vì vượt qty.

## Files

| File | Change |
|------|--------|
| `serverless/shared/order-qty.js` | Thêm `totalPortions` |
| `serverless/shared/orders.js` | Merge warn-only sau load overrides; export helper nếu cần |
| `serverless/shared/index.js` | Re-export `totalPortions` nếu export public |
| `serverless/README.md` | Một dòng: cảnh báo tính cả `2x`–`5x` |

## Testing (manual / unit nếu có harness)

- 30k + 3 món với 2×2 = 5 phần → ping `5 món / suất 30k`, đơn Zalo vẫn đủ `2x`.
- 30k + 5 loại món (không `2x`) → ping như cũ, vẫn cắt còn 4.
- 35k + tổng phần ≤ 5 → không ping thêm vì qty.
- User đã trong `cappedUserIds` vì quá loại món → không duplicate ping.
