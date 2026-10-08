# Menu from vendor photos — design

**Date:** 2026-10-07
**Status:** Implemented (pending deploy)

## Problem

The new vendor publishes its daily menu as photos of the food counter, and its existing customers order by sending back cropped photos of the dishes they want. That does not fit Mr.Chef:

- photo-based ordering looks unhygienic in the channel,
- few members have time to crop photos,
- ordering must stay as simple as today (react with an emoji).

## Decision

The maintainer DMs the vendor photos to the bot. At 10:15 PostMenu sends them to Gemini, which returns a dish list. Code (not AI) picks at most 20 dishes, and the existing text-menu flow posts them. Members keep reacting as before. Photos never become part of the ordering interaction.

The vendor accepts text orders, so no per-dish cropping is needed.

## Flow

1. Before 10:15 the maintainer sends one or more photo messages to the bot DM. All consecutive photo messages from today (newest first, bot messages skipped) are one menu. Captions are ignored. If the latest DM is text, the old text flow runs unchanged. `Bỏ qua hôm nay` still skips the day.
2. PostMenu downloads the `thumb_1024` renditions (the benchmark resolution; originals can exceed Gemini's inline request limit).
3. `menu-vision` calls Gemini with all photos in one request plus the list of dish names already in history, so that names stay stable ("Vịt luộc", not "Gà luộc" one day and "Ngan luộc" the next). The response is JSON with `name`, `category` (`main` | `stir_fry` | `veg_soup` | `side`) and `confidence`.
4. `menu-selection` picks ≤ 20 dishes:
   - up to 3 `veg_soup` slots (each meal includes 1–2 vegetable dishes; without dedicated slots, main dishes fill the whole menu),
   - the remaining slots: dishes with history ranked by portions per appearance, while 3 slots stay reserved for dishes without history (otherwise a new dish can never earn history),
   - dishes without history are ranked by category (`main` > `stir_fry` > `veg_soup` > `side`), then by confidence.
5. The bot replies in the DM thread with the model used, the dish count, and the dishes left off the menu. The channel menu is text only: photos are never embedded, and PostMenu sets `images_sync_complete` right away so `menu-images-sync` never adds them later (its poll schedule is disabled).
6. At 11:00 ZaloSheetSummary records portions per dish into `slack-dishes-dish-popularity` (`dish_key` = lowercased, punctuation-stripped name with Vietnamese diacritics kept). A conditional write on `last_date` makes Lambda retries idempotent. Days with zero orders are not recorded.

## Resilience

| Failure | Behaviour |
| --- | --- |
| Primary model error, timeout (90 s), or empty or invalid JSON | Falls back to the next model in `menu-vision-models` |
| All models fail / image download fails | DM thread reply asking for a text menu, then PostMenu throws (EventBridge async retries twice). Text menu + manual PostMenu invoke is the recovery path. |
| Popularity table unreadable | Ranking runs without history; menu still posts |
| Popularity write fails | Logged only; sheet and Zalo are unaffected |

## Configuration

- SSM `/slack-dishes/gemini-api-key` (SecureString, required for photo menus).
- SSM `/slack-dishes/menu-vision-models` (optional, comma-separated, default `gemini-3.1-pro-preview,gemini-3.8-flash`). The primary model is a preview; changing models must not require a deploy.
- PostMenu timeout raised to 240 s (two 90 s model attempts + download + Slack).

## Model benchmark (2026-10-07)

Script: `scripts/menu-vision/benchmark.mjs`, ground truth: `scripts/menu-vision/ground-truth.json` (31 dishes from 7 photos, 1024 px). Recall is the share of ground-truth dishes matched by name or alias. Duplicates are extra entries for a dish that was already matched. 3 runs per model at temperature 0.

| Model | Recall per run | Duplicates | Latency | Notes |
| --- | --- | --- | --- | --- |
| `gemini-3.1-pro-preview` | 84% / 84% / 84% | 2 | ~36 s | Most accurate and fully deterministic. **Chosen as primary.** |
| `gemini-3.8-flash` | 77% / 81% / 77% | 4 | 34–49 s | Not a preview; varies between runs. **Fallback.** |
| `gemini-2.5-flash` | 71% / 71% / 71% | 2 | ~21 s | Baseline; ~$0.012 per day |
| `gemini-3.1-flash-lite` | 61% / 61% | 1 | ~5 s | Earlier round; misses many dishes |
| `gemini-3.5-flash-lite` | 45% / 55% | 1 | ~4 s | Earlier round; unstable |

Token usage is ~7.6k input and ~4.7k output per day for Pro. At usual Pro-tier pricing that is roughly 1–2 USD per month. Verify against current Google pricing.

Findings:

- Every model mistook duck for chicken or goose, and misnamed "cá cơm rim". Both were named correctly once the known-name list was added to the prompt (end-to-end run with the production module).
- Shared misses were mostly ground-truth entries marked `uncertain` (tóp mỡ, thịt xào ớt), so real accuracy is likely higher than the table shows.
- Near-duplicates ("Cá kho" / "Cá kho riềng") still occur. Exact duplicates are merged by `dish_key`.
- One day of photos is a small sample. Re-run the benchmark on a few more days before relying on it heavily.

## Vendor pricing (shipped with this change)

- Default meal 40k (3 main dishes + 1–2 vegetable dishes), up to 5 reactions per member.
- `:arrow_down:` replaces `:up:` and means a smaller meal at 35k, up to 4 reactions per member. The vendor balances the plate itself.
- Price labels in Zalo messages and over-limit pings are derived from the configured price instead of being hard-coded.
- The constant names `UPSIZE_MEAL_PRICE` / `UP_EMOJI` / `upPrice` are kept to avoid a large rename. Their meaning is documented in `meal-constants.js`. Renaming them is a follow-up.

## Runtime

AWS has blocked updates to `nodejs20.x` functions since 2026-07-01, so every function moves to `nodejs24.x` (template `Globals`).
