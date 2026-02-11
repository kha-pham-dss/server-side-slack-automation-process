# Serverless – Slack dishes ordering (Option A)

Lambda functions for the Slack dishes flow:

- **post-menu** – Runs at 9:30 UTC. Fetches dishes from your API, posts to Slack, stores `message_ts` in DynamoDB.
- **collect-orders** – Runs at 10:20 UTC. Reads today’s menu from DynamoDB, calls Slack `reactions.get`, aggregates by emoji, POSTs to your ordering API.

## Runtime

Node.js 20 (ES modules).

## API contracts

- **Dishes API (GET)**  
  `GET DISHES_API_URL` → `{ "dishes": [ { "id": "0", "name": "Dish A" }, ... ] }`

- **Ordering API (POST)**  
  `POST ORDER_API_URL` with body:
  `{ "message_ts": "...", "orders": [ { "dish_index": 0, "emoji": "number0", "user_ids": ["U123"] }, ... ] }`

## Build

From this directory, install dependencies for each function (required for SAM deploy):

```bash
cd post-menu && npm install && cd ..
cd collect-orders && npm install && cd ..
```

Or from repo root:

```bash
npm install --prefix serverless/post-menu
npm install --prefix serverless/collect-orders
```

Deployment is done via the IaC folder (AWS SAM); see `../iac/README.md`.
