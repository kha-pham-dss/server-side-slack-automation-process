# Serverless – Slack dishes ordering (Option A)

Lambda functions for the Slack dishes flow:

- **post-menu** – Runs at 9:30 UTC. Fetches dishes from Google Sheet (dish-range), posts to Slack, stores `message_ts` in DynamoDB.
- **collect-orders** – Runs at 10:20 UTC. Reads today’s menu from DynamoDB, calls Slack `reactions.get`, resolves user IDs to names via `users.list`, writes each user’s order into the Google Sheet (one row per user).

## Runtime

Node.js 20 (ES modules).

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
