---
title: Integrations
url: https://help.northpine.example/integrations
---
# Integrations

Integrations are available on Team and Business plans. Only Owners and Admins can connect or remove workspace integrations.

## Slack

Connect Slack under Settings > Integrations > Slack. You can send board updates to a channel and create tasks from a Slack message with the "Create Northpine task" message action.

If notifications stop arriving in a channel, check that the Northpine app is still a member of the channel (type `/invite @Northpine` in the channel). Archived channels stop receiving updates and must be reconnected.

## Google Calendar and Outlook

Two-way calendar sync shows tasks with due dates on your calendar and updates the task when you move the event. Each member connects their own calendar under Profile > Connected calendars.

Sync runs every 5 minutes. Recurring events are not synced back to tasks.

## Zapier and webhooks

Use Zapier to connect Northpine to 5,000+ apps. For custom integrations, create webhooks under Settings > Integrations > Webhooks. Webhooks send a POST request with a JSON body and an `X-Northpine-Signature` header you should verify. Failed webhook deliveries are retried 5 times with exponential backoff over about 1 hour.

## API

The REST API is available on all paid plans. Create a personal API token under Profile > API tokens. Rate limit: 120 requests per minute per token. Requests over the limit return HTTP 429 with a `Retry-After` header.
