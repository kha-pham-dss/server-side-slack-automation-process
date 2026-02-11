Here’s a step-by-step guide you can put in your new repo (e.g. `IMPLEMENTATION_GUIDE.md` or `README.md`) and hand to another Cursor Agent to implement.

---

# Step-by-step guide: Slack dishes ordering (AWS serverless)

## Overview

- **9:30 AM:** A scheduled job calls your dishes API, posts the list to a Slack channel, and stores the message ID.
- **Reactions:** Users react with `:number0:`, `:number1:`, … to choose a dish.
- **10:20 AM:** A scheduled job reads reactions for that message (from Slack API or from stored events), aggregates by user/emoji, and POSTs the result to your ordering API.

Two implementation options:

- **Option A:** Only scheduled Lambdas (9:30 + 10:20). No public URL. 10:20 Lambda calls Slack `reactions.get`.
- **Option B:** 9:30 Lambda + Slack Event Subscriptions (reactions sent to your API) + 10:20 Lambda. Requires API Gateway + DynamoDB; 10:20 only reads your DB.

---

## Prerequisites

- AWS account (free tier).
- Slack workspace where you can create an app.
- Dishes API: GET endpoint that returns a list of dishes (format to be defined).
- Ordering API: POST endpoint that accepts the aggregated order payload (format to be defined).

---

## Part 1: Slack app setup

### 1.1 Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name it (e.g. “Dishes ordering”) and pick the workspace.

### 1.2 Bot scopes (required for posting and reading reactions)

1. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**:
   - `chat:write` – post message at 9:30.
   - `reactions:read` – read reactions at 10:20 (Option A).
   - `channels:history` or `groups:history` if the channel is private (to get message context if needed).
2. **Install to Workspace** and copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 1.3 Incoming Webhook (optional for 9:30)

1. **Incoming Webhooks** → **Activate Incoming Webhooks** → **Add New Webhook to Workspace** → choose the target channel.
2. Copy the **Webhook URL**.  
   If you use this, the 9:30 Lambda only needs to call your API and POST to this URL (no bot token for posting). You still need the bot for `reactions.get` in Option A.

### 1.4 Event Subscriptions (only for Option B)

1. **Event Subscriptions** → **Enable Events** → **Request URL**: will be your API Gateway URL (e.g. `https://xxxx.execute-api.region.amazonaws.com/slack/events`) after you deploy.
2. **Subscribe to bot events**: add `reaction_added` (and optionally `reaction_removed`).
3. After API Gateway + Lambda are deployed, set the Request URL and save. Slack will send a verification challenge; your Lambda must return the `challenge` value in the response.

### 1.5 Note channel ID

- In Slack, right‑click the channel → **View channel details** → copy **Channel ID** (or use ID from URL). You’ll use this in config.

---

## Part 2: AWS resources (high level)

Create (by hand or IaC):

- **Parameter Store (SSM):**
  - e.g. `/slack-dishes/bot-token` – Slack bot token (SecureString).
  - e.g. `/slack-dishes/channel-id` – target channel ID.
  - e.g. `/slack-dishes/webhook-url` – (optional) Incoming Webhook URL.
  - e.g. `/slack-dishes/dishes-api-url` – GET dishes API URL.
  - e.g. `/slack-dishes/order-api-url` – POST ordering API URL.
- **DynamoDB (Option A optional, Option B required):**
  - Table: e.g. `slack-dishes-menu-message` – one row per “day” or per menu post: `date` (PK), `channel_id`, `message_ts`, `dish_count` (or dish list).
  - Table (Option B only): e.g. `slack-dishes-reactions` – `message_ts` (PK), `user_id` (SK), `emoji`, `channel_id`, `timestamp`.
- **Lambda:**
  - **PostMenu (9:30):** runs on schedule; reads config from Parameter Store; calls dishes API; posts to Slack (webhook or `chat.postMessage`); writes `channel_id`, `message_ts`, dish count (and optionally list) to Parameter Store or DynamoDB.
  - **CollectOrders (10:20):** runs on schedule; reads last menu message from Parameter Store or DynamoDB; gets reactions (Slack API in Option A, or DynamoDB in Option B); aggregates; POSTs to ordering API.
  - **SlackEvents (Option B only):** triggered by API Gateway; handles URL verification (`challenge`); on `reaction_added`/`reaction_removed`, if message is today’s menu message and emoji is `number0`–`numberN`, writes/updates/deletes in `slack-dishes-reactions`.
- **EventBridge:**
  - Rule 1: schedule `cron(30 9 * * ? *)` (9:30 UTC; adjust for your timezone) → invoke PostMenu Lambda.
  - Rule 2: schedule `cron(20 10 * * ? *)` (10:20 UTC) → invoke CollectOrders Lambda.
- **API Gateway (Option B only):**
  - HTTP API or REST API with route `POST /slack/events` (or `/events`) that integrates with SlackEvents Lambda. Use this URL as Event Subscriptions Request URL.

---

## Part 3: Implementation steps (for the agent)

### Step 1: Repo and runtime

- Create repo (e.g. `slack-dishes-aws`).
- Choose runtime (e.g. Node.js 20 or Python 3.12).
- Add a README that points to this guide.

### Step 2: Config and secrets

- Document required Parameter Store keys (list above).
- In code, read from Parameter Store (and optionally cache in Lambda).
- Do not commit tokens; use SSM or Secrets Manager.

### Step 3: Dishes API contract

- Define: GET `DISHES_API_URL` → response shape (e.g. `{ "dishes": [ { "id": "0", "name": "Dish A" }, ... ] }`).
- PostMenu Lambda: call this API, map each dish to `:number0:`, `:number1:`, … and build Slack message (Block Kit).

### Step 4: PostMenu Lambda (9:30)

- Input: EventBridge scheduled event (no body needed).
- Logic:
  1. Get config from Parameter Store (channel ID, webhook URL or bot token, dishes API URL).
  2. GET dishes from dishes API.
  3. Build Slack message: title “Today’s menu”, list dishes with “React with :number0: for …”, etc.
  4. Post to Slack:
     - **If using webhook:** POST to webhook URL with `{ "blocks": [ ... ] }`.
     - **If using bot:** `chat.postMessage` with `channel`, `blocks`, and `text` fallback.
  5. From response get `message_ts` (and `channel`). Store in DynamoDB with partition key = today’s date (e.g. `YYYY-MM-DD`) or in Parameter Store (e.g. last message key). Store `dish_count` (or dish list) for 10:20.
- Output: success/failure (log and optionally CloudWatch metric).

### Step 5: CollectOrders Lambda (10:20) – Option A

- Input: EventBridge scheduled event.
- Logic:
  1. Get from Parameter Store or DynamoDB: `channel_id`, `message_ts` for “today’s” menu message (e.g. today’s date key).
  2. Call Slack API `reactions.get` with `channel`, `timestamp` (= `message_ts`). Parse response: for each reaction name `number0`, `number1`, … collect user IDs.
  3. Build payload expected by ordering API, e.g. `{ "message_ts": "...", "orders": [ { "emoji": "number0", "user_ids": ["U123", "U456"] }, ... ] }` or your schema.
  4. POST to ordering API URL (from Parameter Store).
  5. Handle errors and log.

### Step 5 (Option B): SlackEvents Lambda

- Input: API Gateway request body (Slack event envelope).
- Logic:
  1. If `type === "url_verification"`, return `{ "challenge": event.challenge }` with 200.
  2. If `type === "event_callback"`: event type `reaction_added` or `reaction_removed`. Get `message_ts`, `user`, `reaction` (e.g. `number0`). Check that this message is the current menu message (read from DynamoDB by date → get `message_ts` and `channel_id`; compare with event item).
  3. If it’s the menu message and emoji is in `number0`..`numberN`: for `reaction_added` put item in `slack-dishes-reactions` (e.g. PK=`message_ts`, SK=`user_id`, emoji, channel_id). For `reaction_removed` delete item.
  4. Return 200 quickly (Slack expects &lt; 3 s).

### Step 5 (Option B): CollectOrders Lambda (10:20)

- Same as Option A step 5, but instead of calling `reactions.get`, query DynamoDB table `slack-dishes-reactions` for the current menu `message_ts` (from DynamoDB menu table by date). Aggregate by emoji → user list, then POST same payload to ordering API.

### Step 6: Ordering API contract

- Define: POST `ORDER_API_URL` with body (e.g. `{ "message_ts": "...", "orders": [ { "dish_index": 0, "emoji": "number0", "user_ids": ["U123"] }, ... ] }`). Agent should match your backend’s expected schema.

### Step 7: EventBridge rules

- Create two rules:
  - `post-menu-daily`: schedule `cron(30 9 * * ? *)` (9:30 UTC), target = PostMenu Lambda.
  - `collect-orders-daily`: schedule `cron(20 10 * * ? *)` (10:20 UTC), target = CollectOrders Lambda.
- Adjust cron for your timezone (e.g. JST = UTC+9 → use `cron(30 0 * * ? *)` for 9:30 JST).

### Step 8: API Gateway (Option B only)

- Create HTTP API (or REST), add route `POST /slack/events` (or `/events`) → SlackEvents Lambda.
- Deploy and copy invoke URL. In Slack App → Event Subscriptions, set Request URL to `https://<api-id>.execute-api.<region>.amazonaws.com/slack/events`.

### Step 9: IAM

- PostMenu Lambda: allow SSM GetParameter (and optionally DynamoDB PutItem/GetItem for menu message table).
- CollectOrders Lambda: allow SSM GetParameter, DynamoDB GetItem/Query (if Option B), and Slack API calls are outbound (no special AWS permission); allow access to ordering API (e.g. VPC if API is private, or none if public HTTPS).
- SlackEvents Lambda (Option B): allow DynamoDB PutItem/DeleteItem/GetItem/Query, and SSM GetParameter if you read config.
- All Lambdas: ensure they have network access (default for public APIs; if in VPC, NAT and security groups for Slack and your APIs).

### Step 10: Deployment

- Prefer IaC (e.g. AWS SAM, CDK, or Terraform) so the next agent can deploy with one command. Include:
  - Parameter Store placeholders or reference to “set these manually”.
  - DynamoDB table(s).
  - Lambdas (PostMenu, CollectOrders, and SlackEvents for Option B).
  - EventBridge rules.
  - API Gateway (Option B).
  - IAM roles above.

### Step 11: Testing

- Trigger PostMenu Lambda once (EventBridge test event or AWS console “Test”) and confirm message in Slack and stored `message_ts`.
- Add reactions, then run CollectOrders once; confirm ordering API receives correct payload.
- Option B: send mock `reaction_added` and `url_verification` payloads to API Gateway and confirm DynamoDB and challenge response.

---

## Part 4: Timezone and edge cases

- EventBridge uses UTC. Convert 9:30 / 10:20 local time to UTC and set cron accordingly.
- “Today’s menu”: use a consistent date key (e.g. workspace timezone `YYYY-MM-DD`) when storing/reading the menu message so 10:20 clearly refers to the same post.
- If 9:30 fails: 10:20 should handle “no menu message for today” (e.g. skip or POST empty orders) and log.

---

## Part 5: What to put in the new repo

- This guide (e.g. `IMPLEMENTATION_GUIDE.md` or in `README.md`).
- Lambda source (one folder per function or monorepo with shared types).
- IaC (SAM/CDK/Terraform) in a dedicated directory.
- Env/config template (e.g. list of Parameter Store keys and example values without secrets).
- Short README: “Slack dishes ordering – implement according to IMPLEMENTATION_GUIDE.md; Option A = scheduled only, Option B = scheduled + Event Subscriptions.”