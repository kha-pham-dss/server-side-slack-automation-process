# Qty Over-Limit Warning (2x–5x) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ping over-limit when total portions (including 2x–5x overrides) exceed meal max, without trimming the order.

**Architecture:** Add `totalPortions` in `order-qty.js`. After loading overrides in `aggregateOrderSummaryFromReactions`, merge warn-only entries into `cappedUserIds`. Existing collect-orders ping loop and message format stay unchanged.

**Tech Stack:** Node.js 20 ESM, existing `@slack-dishes/shared` helpers. No test runner in repo — verify with a one-off node assert script.

## Global Constraints

- Warn-only for qty over-limit: do not slice dishIndices or mutate overrides.
- Keep existing unique-dish cap (`slice(0, maxDishes)`) when too many reaction types.
- Ping message format unchanged: `<@id> Bạn đang đặt N món / suất 30k|35k`.
- Max portions: 4 (30k) / 5 (35k `:up:`).

---

### Task 1: `totalPortions` helper

**Files:**
- Modify: `serverless/shared/order-qty.js`
- Modify: `serverless/shared/index.js` (re-export)

**Interfaces:**
- Produces: `totalPortions(dishIndices: number[], qtyOverrides?: Record<number, number>): number`

- [ ] **Step 1:** Implement `totalPortions` — sum `qtyOverrides[i] ?? 1` for each index in `dishIndices`, then add override-only indices not already counted.
- [ ] **Step 2:** Re-export from `serverless/shared/index.js`.
- [ ] **Step 3:** Smoke-check with `node --input-type=module` asserts (1+2+2=5; override-only; empty=0).

### Task 2: Merge qty over-limit into `cappedUserIds`

**Files:**
- Modify: `serverless/shared/orders.js` (`aggregateOrderSummaryFromReactions`)

**Interfaces:**
- Consumes: `totalPortions`, `MAX_DISHES_PER_USER_DEFAULT`, `MAX_DISHES_PER_USER_UPSIZE`
- Produces: `cappedUserIds` may include qty-only over-limit users with `dishCount = totalPortions`

- [ ] **Step 1:** After loading `overridesByUserId`, for each user in `ordersByUserId` (and override-only users if needed for `userHasOrderContent`), if total portions > max and userId not already in `cappedUserIds`, push warn entry.
- [ ] **Step 2:** Smoke-check merge logic with inline node script mocking ordersByUserId + overrides.
- [ ] **Step 3:** Update README one-liner that over-limit ping counts 2x–5x.

### Task 3: Commit

- [ ] Commit implementation (and plan if not yet committed).
