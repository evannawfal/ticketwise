# Ticketwise

An AI support assistant that answers questions from your help docs and past tickets, links every claim to its source, drafts replies for agents, and works in Slack. It runs on AWS Lambda with Postgres + pgvector.

**[Live demo](https://evannawfal.github.io/ticketwise/)** · [How it works](#how-it-works) · [Design choices](#design-choices) · [Costs](#what-it-costs-to-run) · [Deploy](#deploy-to-aws)

![Demo: asking a question, drafting a reply, managing the knowledge base](docs/demo.gif)

The demo runs in your browser against a sample help center for a made-up company called Northpine (7 help articles and 18 exported tickets). It uses the real chunking, vector search, re-ranking and citation code. To keep it free and keyless, the LLM step is swapped for an offline extractive generator, so demo answers are stitched from source sentences rather than written by a model. The deployed version uses Claude on Bedrock or OpenAI.

## What it does

- **Ask** a question in plain English. The answer only uses your docs and resolved tickets, and every sentence cites its source with a `[n]` marker that links back to the article.
- **Draft a reply** from a pasted customer message. The agent edits it, checks the sources, and copies it without the markers.
- **Use it from Slack** with `/ask how do I reset 2FA?`, `/ask draft <customer message>`, or by @mentioning the bot in a thread.
- **Manage the knowledge base** from a small admin page: upload Markdown docs, import a ticket CSV export (Zendesk/Freshdesk style), delete stale content, and see usage.
- **Say "I don't know."** If nothing in the knowledge base is relevant, it says so and doesn't call the model at all.

## How it works

```mermaid
flowchart LR
    subgraph Clients
      A[Admin page<br/>Next.js on S3 + CloudFront]
      S[Slack<br/>/ask and @mentions]
    end
    A -->|REST + admin token| G[API Gateway<br/>HTTP API]
    S -->|signed request| G
    G --> L1[API Lambda]
    G --> L2[Slack Lambda<br/>verify + ack under 3s]
    L2 --> Q[(SQS)]
    Q --> L3[Worker Lambda]
    L3 -->|chat.postMessage / response_url| S
    L1 & L3 --> R{{Retrieval}}
    R -->|embed query| B1[Bedrock Titan<br/>embeddings]
    R -->|cosine search, HNSW| P[(Postgres + pgvector)]
    R -->|numbered sources| B2[Bedrock Claude<br/>Converse API]
    L1 & L2 & L3 -.-> SM[Secrets Manager]
```

1. **Ingest.** Docs are split by Markdown heading so a chunk never mixes two topics, then packed to about 1,200 characters with a small overlap. Each chunk is embedded together with its title and heading path ("Billing > Failed payments"), which helps short chunks match. Ticket exports keep only solved tickets, stored as "Customer: … / Resolution: …".
2. **Retrieve.** The question is embedded and the top 24 chunks come back from pgvector. They are then re-ranked with a keyword-overlap score where each word counts by how rare it is among the candidates, so matching "invoice" matters and matching "support" barely does. Chunks that don't cover enough of the question need a much stronger vector match to survive. At most 2 chunks per document are kept, so one long article can't crowd out everything else.
3. **Generate.** The top 6 chunks go to the model as numbered sources. The prompt tells it to answer only from those sources, cite each claim, prefer docs over old tickets, and say plainly when the answer isn't there.
4. **Cite.** The `[n]` markers in the output are mapped back to documents, URLs and snippets. If the model cites nothing, the top 3 sources are shown so an agent can still check.

## Design choices

**Lambda outside a VPC, Postgres over TLS.** Putting Lambda in a VPC to reach RDS also means a NAT Gateway to call Bedrock and Slack, which costs about $32/month before any traffic. Instead, the functions connect over TLS to any Postgres that supports pgvector: Neon or Supabase (free tiers work) or RDS. For a support tool with modest traffic, that's the difference between about $1/month and about $35/month.

**Postgres + pgvector instead of a vector database.** Docs, chunks, tickets and question logs live in one database you can back up, query with SQL and delete from with a cascade. An HNSW index keeps search fast well past 100k chunks, which is more than most help centers will ever have.

**SQS between Slack and the model.** Slack retries any request that doesn't get a response within 3 seconds, and retrieval plus generation can take longer. The Slack Lambda verifies the signature, acknowledges right away, and queues the job. The worker answers and posts back. Retries are ignored by header, failed jobs are retried 3 times, then land in a dead-letter queue.

**Hybrid retrieval and a relevance floor.** Pure vector search always returns *something*, and a model handed loosely related text will often produce a confident wrong answer. The keyword check plus a minimum score means off-topic questions ("what's the capital of France?") get "not in the knowledge base", with zero model tokens spent.

**Providers are swappable.** Embeddings and generation sit behind two small interfaces: Bedrock (Titan + Claude), OpenAI, or `local`. Local needs no keys: hashed keyword embeddings and an extractive answer builder. That keeps tests and local dev free and deterministic, and it powers the browser demo.

**Secrets stay out of the repo and CloudFormation.** One Secrets Manager secret holds the database URL, admin token and Slack/OpenAI keys. It's created from your shell with `scripts/create-secret.sh` and read once per Lambda container.

**Boring, testable core.** All the logic (chunking, CSV import, retrieval, prompts, citation mapping, Slack formatting) is in `packages/core` with no framework. The Lambdas and the local dev server are thin adapters around it.

## What it costs to run

Rough monthly estimate for a team asking about **1,000 questions a month** with a few hundred help articles. Check current AWS pricing before relying on these.

| Piece | Cost |
| --- | --- |
| Lambda, API Gateway, SQS | ~$0 (inside free tier at this volume; ~$1 per million API requests after) |
| S3 + CloudFront for the admin page | ~$0 |
| Secrets Manager (1 secret) | $0.40 |
| Postgres + pgvector | $0 on Neon/Supabase free tier, or ~$12 for RDS `db.t4g.micro` |
| Bedrock Claude Haiku 4.5 (~3k input + 300 output tokens per answer) | ~$4.50 |
| Bedrock Titan embeddings (questions + re-indexing docs) | < $0.10 |
| **Total** | **about $5–17/month** |

The biggest lever is the model. Haiku is plenty for grounded answers; pointing `BEDROCK_MODEL_ID` at a larger model raises quality and cost together. Questions with no relevant sources cost nothing.

## Run it locally (no AWS or API keys needed)

Requires Node 20+ and Docker.

```bash
git clone https://github.com/evannawfal/ticketwise && cd ticketwise
npm install
docker compose up -d                 # Postgres 16 + pgvector on :5432
cp .env.example .env && set -a && source .env && set +a
npm run db:reset                     # create tables + load the Northpine sample data
npm run dev:api                      # API on http://localhost:8787
npm run dev:admin                    # admin on http://localhost:3000
```

Open the admin page, go to **Settings**, and enter `http://localhost:8787` and the `ADMIN_TOKEN` from your `.env`.

To use real models locally, set `LLM_PROVIDER=bedrock EMBEDDING_PROVIDER=bedrock` (uses your AWS credentials) or `openai` with `OPENAI_API_KEY`. Re-run `npm run db:reset` after changing the embedding provider, since vectors from different models can't be compared.

## Deploy to AWS

You need an AWS account with the CLI configured, and access to these Bedrock models in your region (enable them under **Bedrock > Model access**): **Titan Text Embeddings V2** and **Claude Haiku 4.5**.

1. **Create a Postgres database with pgvector.** The easiest option is a free [Neon](https://neon.tech) project. Copy its connection string.
2. **Store your secrets:**
   ```bash
   export DATABASE_URL='postgres://user:pass@host/db?sslmode=require'
   ./scripts/create-secret.sh          # prints your admin token; keep it
   ```
3. **Deploy:**
   ```bash
   npx cdk bootstrap                   # first time per account/region
   npm run deploy
   ```
   The deploy bundles the Lambdas, creates the API, queue, admin site and tables, and prints `AdminUrl`, `ApiUrl` and `SlackRequestUrl`.
4. **Load content.** Open `AdminUrl`, paste the admin token in Settings, and upload your docs and ticket CSV. To load the sample data instead, run `DATABASE_URL=… ADMIN_TOKEN=… LLM_PROVIDER=bedrock EMBEDDING_PROVIDER=bedrock npm run db:reset`.

The default model ID is the US cross-region inference profile for Claude Haiku 4.5. Outside the US, pass your region's ID: `npm run deploy -- -c bedrockModelId=<model or inference profile ID>`.

To use OpenAI instead of Bedrock: `npm run deploy -- -c llmProvider=openai -c embeddingProvider=openai`, with `OPENAI_API_KEY` exported before `create-secret.sh`. To remove everything: `npm run destroy -w @ticketwise/infra`.

### Connect Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From a manifest**, and paste `slack-app-manifest.yml` with `YOUR_API_URL` replaced by your `ApiUrl` (without `https://`).
2. Install the app to your workspace.
3. Add the **Signing Secret** (Basic Information) and **Bot User OAuth Token** (OAuth & Permissions) to the secret, then redeploy so the Lambdas pick up the new values:
   ```bash
   export SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… ADMIN_TOKEN=<your existing token>
   ./scripts/create-secret.sh && npm run deploy
   ```
4. Try `/ask how do refunds work?` or `@Ticketwise draft <paste a customer email>` in a channel the bot is in.

## API

All routes except `/health` need `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/ask` | `{ "question": "..." }` | `{ text, citations[], lowConfidence, model, latencyMs }` |
| `POST` | `/draft` | `{ "ticket": "..." }` | same shape, `text` is the draft |
| `GET` | `/documents` | | `{ documents[] }` |
| `POST` | `/documents` | `{ title, content, url?, sourceType? }` | `{ document }` |
| `POST` | `/documents/tickets` | `{ "csv": "..." }` | `{ imported, skipped }` |
| `DELETE` | `/documents/:id` | | `{ deleted: true }` |
| `GET` | `/stats` | | `{ documents, tickets, chunks, questionsLast7Days }` |
| `POST` | `/slack/events` | Slack slash command or Events API payload | Slack ack |

```bash
curl -s $API/ask -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"Can we pay by invoice?"}'
```

## Tests

```bash
npm test                                         # unit + API tests (in-memory store)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ticketwise npm test   # adds real pgvector tests
npm run typecheck && npm run synth               # types + CDK synth (bundles all Lambdas)
```

The suite covers chunking edge cases, CSV parsing, retrieval quality on the sample help center (the right article must come back for each test question), citation mapping, the "no relevant sources → no model call" path, admin auth and validation, Slack signature checks (tampered and replayed requests are rejected), Slack message posting, and the pgvector store against a real database. CI runs all of it on every push.

## Project layout

```
packages/core     Retrieval, chunking, prompts, providers (Bedrock/OpenAI/local), pgvector + in-memory stores
services/api      Lambda handlers (api, slack, worker, migrate), framework-free router, local dev server
apps/admin        Next.js admin page (static export); demo mode runs core in the browser
infra             AWS CDK stack: HTTP API, Lambdas, SQS + DLQ, Secrets Manager, S3 + CloudFront
sample-data       Northpine help center (Markdown) and ticket export (CSV), all fictional
```

## Limits and next steps

- The admin page is protected by a single shared token. A real multi-team rollout would put it behind SSO (Cognito or the company's IdP).
- Docs are text and Markdown. PDF and HTML import, plus syncing from Zendesk or Notion on a schedule, would be the next additions.
- There is no automated answer-quality eval yet beyond the retrieval tests. A small labeled question set scored on each prompt change would be the next step.

MIT License.
