# Ticketwise

A support assistant that answers questions from your help docs and past tickets. It streams the answer, quotes the exact passage behind every sentence, returns approved answers word for word, and stays up when many people ask at once. A 30-question benchmark runs on every pull request and blocks the merge if answers get less grounded. It runs on AWS Lambda with Postgres + pgvector, and works in Slack.

**[Live demo](https://evannawfal.github.io/ticketwise/)** · [How it works](#how-it-works) · [Exact quotes](#exact-quotes-and-grounding-checks) · [Approved answers](#approved-answers) · [Many users at once](#many-users-at-once) · [Evals](#evals-every-change-is-measured) · [Deploy](#deploy-to-aws)

![Demo: a streamed answer with quoted sources, then an approved answer returned word for word](docs/demo.gif)

The demo runs in your browser against a sample help center for a made-up company called Northpine (7 help articles, 18 exported tickets, 4 approved answers). It uses the real chunking, vector search, re-ranking, quoting, grounding checks, approved-answer matching and request queue. To keep it free and keyless, the LLM step is swapped for an offline extractive generator, so demo answers are stitched from source sentences rather than written by a model. The deployed version uses Claude on Bedrock or OpenAI.

## What it does

- **Ask** a question in plain English. The answer streams in as it's written. It only uses your docs and resolved tickets, every sentence cites its source with a `[n]` marker, and each source shows the passage quoted word for word.
- **Check the answer.** Every sentence is matched against the passage it cites. If one has no citation, or its citation doesn't say what the sentence says, the agent sees it listed under the answer.
- **Approved answers.** A support lead can save an answer for a question. When someone asks that question (in their own words), the stored text comes back exactly as saved, with no model call. In "approved only" mode, anything without an approved answer goes to a human.
- **Draft a reply** from a pasted customer message. The agent edits it, checks the quotes, and copies it without the markers.
- **Many users at once.** Model calls wait in a queue that respects the provider's request and token limits, and rate-limited calls are retried with backoff, so a burst of questions gets answered instead of erroring.
- **Use it from Slack** with `/ask how do I reset 2FA?`, `/ask draft <customer message>`, or by @mentioning the bot in a thread.
- **Say "I don't know."** If nothing in the knowledge base is relevant, it says so and doesn't call the model at all.

## How it works

```mermaid
flowchart LR
    subgraph Clients
      A[Admin page<br/>Next.js on S3 + CloudFront]
      S[Slack<br/>/ask and @mentions]
    end
    A -->|REST + admin token| G[API Gateway<br/>HTTP API]
    A -->|streamed answers, SSE| U[Lambda function URL<br/>response streaming]
    S -->|signed request| G
    G --> L1[API Lambda]
    G --> L2[Slack Lambda<br/>verify + ack under 3s]
    L2 --> Q[(SQS)]
    Q --> L3[Worker Lambda]
    L3 -->|chat.postMessage / response_url| S
    L1 & L3 & U --> AP{{Approved answer?}}
    AP -->|match: stored text, no model call| A
    AP -->|no match| R{{Retrieval}}
    R -->|embed query| B1[Bedrock Titan<br/>embeddings]
    R -->|cosine search, HNSW| P[(Postgres + pgvector<br/>docs, approved answers,<br/>shared rate budget)]
    R -->|numbered sources| RQ[Request queue<br/>tokens/min, retries]
    RQ --> B2[Bedrock Claude<br/>ConverseStream]
    B2 -->|tokens| QT[Quote + check<br/>each sentence]
```

1. **Approved answers first.** The question is embedded once. If it matches an approved answer closely enough, that text is returned as is and nothing else runs.
2. **Ingest.** Docs are split by Markdown heading so a chunk never mixes two topics, then packed to about 1,200 characters with a small overlap. Each chunk is embedded together with its title and heading path ("Billing > Failed payments"), which helps short chunks match. Ticket exports keep only solved tickets, stored as "Customer: … / Resolution: …".
3. **Retrieve.** The top 24 chunks come back from pgvector, then are re-ranked with a keyword-overlap score where each word counts by how rare it is among the candidates, so matching "invoice" matters and matching "support" barely does. Chunks that don't cover enough of the question need a much stronger vector match to survive. At most 2 chunks per document are kept.
4. **Queue.** The model call waits for a slot and for room in the requests-per-minute and tokens-per-minute budget. Rate limits and server errors are retried with backoff.
5. **Generate, streamed.** The top 6 chunks go to the model as numbered sources. The prompt requires a citation on every sentence, the source's own wording, and a fixed sentence when the sources don't answer the question. Tokens are sent to the browser as they arrive.
6. **Quote and check.** Each sentence is matched to the passage in its cited source that backs it. The quote is cut from the source by character offsets, so it is always the source's own words.

## Exact quotes and grounding checks

A citation that points at a whole article doesn't help an agent much. Ticketwise shows, for each sentence, the passage it came from.

After the model finishes, the answer is split into sentences. For each one, Ticketwise looks through the source it cites, sentence by sentence (and pairs of adjacent sentences), and picks the passage that covers the most of the sentence's words. The quote is `source.slice(start, end)`: it can't be paraphrased, because it's never written, only cut out. Labels like "Resolution:" and list markers are skipped over, and from past tickets only the agent's resolution is quotable, never the customer's message.

The same match scores each sentence. A sentence is **grounded** when its best quote covers at least 60% of the words it adds (words that only repeat the question, like "the maximum attachment size is…", don't count). Sentences with no citation, or whose citation doesn't contain what they say, are listed under the answer so the agent checks them first.

The check is word overlap. It's deterministic and free, which is what a merge gate needs. It misses reasoning ("…because refunds over $500 need a lead") and catches padding ("…to work properly"), so it's strict rather than generous.

## Approved answers

![An approved answer returned word for word, with its match score and sources](docs/approved-answer.png)

Some answers have to be exact: refund terms, security steps, anything legal reviewed. A support lead saves the question and the answer, from scratch or from a generated answer they've edited. From then on:

- **Approved first** (default): a matching question gets the stored text byte for byte, with no model call. Everything else is generated as usual.
- **Approved only**: a matching question gets the stored text; anything else gets "There's no approved answer for this question yet" and goes to a human.
- **Always generate**: approved answers are ignored. Drafted replies always generate, since they have to fit the customer's message.

The text is never trimmed, reformatted or sent through a model. Tests check this with odd spacing, curly quotes and trailing newlines.

**Matching.** Embeddings alone rate "Can I get a refund on a monthly plan?" as nearly the same question as "…on an annual plan?", and returning the annual answer would be wrong. So a match needs both: half the score is embedding similarity, half is how much of the approved question's wording the user's question covers, with a light penalty for extra words. That lets "Can we pay by invoice instead of card?" match "Can we pay by invoice?" while the monthly/annual pair stays apart.

The threshold comes from the benchmark. `npm run calibrate -w @ticketwise/evals` scores every benchmark question against the approved answers and prints the range that separates must-match from must-not-match questions:

| Embeddings | Lowest must-match | Highest must-not-match | Threshold |
| --- | ---: | ---: | ---: |
| Local (hashed keywords) | 0.753 | 0.725 | 0.74 |
| OpenAI text-embedding-3-small | 0.872 | 0.788 | 0.83 |

The first version used plain word overlap (Jaccard) and the calibration showed no threshold could separate the two groups. That's what led to the coverage-based score.

## Many users at once

Every provider caps requests and tokens per minute. Ten agents asking at once is enough to hit those caps, and naive retries make it worse: everyone retries at the same moment.

- **A queue in front of the model.** Calls run in arrival order, a few at a time, and each one reserves its estimated tokens (prompt plus maximum output) from a tokens-per-minute budget before it starts. When the provider reports real usage, the unused part goes back. A full queue answers `429` with `Retry-After`; a wait past the timeout answers `503`. Nobody gets a `500`.
- **Retries with backoff.** `429`, `5xx` and network errors are retried with exponential backoff and full jitter, at least as long as the provider's `Retry-After` asks. A `429` pauses the whole queue, so the requests behind it wait too.
- **Streams retry only before the first token.** After text has reached the user, a retry would repeat or contradict it, so the error is shown instead.
- **One budget across Lambdas.** Each Lambda container runs one request at a time, so an in-memory queue alone can't limit the fleet. The budget lives in Postgres: each take locks the bucket rows in one transaction, refills them by elapsed time on the database clock, and takes from all of them or none.

`npm run loadtest -w @ticketwise/api` opens 50 streamed answers at the same moment, over HTTP, against a fake OpenAI-compatible provider that allows 3 calls at a time and returns `429` past that:

| Setup | Answered | Provider 429s | Retries | First token p50 | First token p95 | Full answer p95 |
|---|---|---|---|---|---|---|
| No queue, no retries | 3/50 | 47 | 0 | 298 ms | 309 ms | 661 ms |
| Retries only | 15/50 | 205 | 30 | 958 ms | 3374 ms | 3737 ms |
| Queue (3 at once) + retries | **50/50** | **0** | 0 | 3013 ms | 5359 ms | 5689 ms |

Retries alone cause a stampede: 205 rejected calls to answer 15 people. With the queue, everyone waits their turn and the provider never says no. The test suite runs the same scenario with 40 users.

## Evals: every change is measured

[`evals/benchmark.json`](evals/benchmark.json) holds 30 questions about the sample help center:

- **18 answerable** questions, each with the sources that may be cited and the facts the answer must contain ("5 to 10 business days").
- **5 the docs don't cover** (holiday hours, HIPAA, a trivia question, a prompt injection). The right answer is "I couldn't find this".
- **4 approved-answer questions**, reworded. The stored text must come back unchanged.
- **3 near-misses** that look like an approved question but ask something else. They must not get the approved answer.

The grader ([`evals/src/grade.ts`](evals/src/grade.ts)) doesn't trust what the assistant says about itself. It re-checks every quote word for word against the original documents, re-splits the answer into sentences, and scores each case on retrieval, facts, grounded sentences and citation targets. The score is the mean over the 30 questions, out of 100.

**The merge gate.** On every pull request, [GitHub Actions](.github/workflows/eval.yml) runs the benchmark with the offline models (deterministic, so a change in score comes from a change in code) and compares it with the latest run on main. The check fails, and branch protection blocks the merge, if:

- the score drops more than 0.5 points,
- retrieval, facts, grounded sentences, citation precision, abstaining or approved-answer routing drops more than 5 points, or
- any quote isn't word for word.

The result is posted on the pull request, with the questions that broke. Every push to main adds its run to `history.json` on the [`eval-history`](https://github.com/evannawfal/ticketwise/tree/eval-history) branch and redraws this chart (also on the demo's Evals page, with every metric per run):

![Grounding benchmark score by commit on main](https://raw.githubusercontent.com/evannawfal/ticketwise/eval-history/score.svg)

How the score moved while this was built (each point is a real run of the benchmark on that commit):

| Commit | Change | Score |
| --- | --- | ---: |
| `7435fd7` | Benchmark added, run on the original pipeline | 77.7 |
| `0f5d2fb` | Streaming, exact quotes, citation on every sentence | 81.6 |
| `7531124` | Approved answers | 94.9 |
| `129f467` | Stemmer fix | 96.1 |

The stemmer fix shows why the gate exists. `stem()` never matched "expire" with "expires", so an invite question picked the wrong sentence. The first fix also folded short plurals ("days" to "day"), and the benchmark dropped to 89.4: "Is support open on Christmas day?" suddenly matched half the help center and got answered, and "How do I delete a workspace?" started returning the approved answer about restoring one. Keeping only the part that helped, and moving the approved threshold to where the calibration put it, gave 96.1.

**With a real model.** `npm run eval -- --provider openai` runs the same benchmark against gpt-4.1-mini and OpenAI embeddings. CI runs it on main when an `OPENAI_API_KEY` secret is set; it reports but doesn't gate, since live models vary between runs. Latest run:

| Metric | Offline (CI gate) | gpt-4.1-mini |
| --- | ---: | ---: |
| Score | 96.1 | 94.8 |
| Retrieval recall | 100 | 100 |
| Fact recall | 85.7 | 100 |
| Grounded sentences | 100 | 73.3 |
| Citation precision | 87.9 | 100 |
| Quote exactness | 100 | 100 |
| Abstain accuracy | 100 | 100 |
| Approved accuracy | 100 | 100 |

The model gets every fact and cites the right source every time. Its misses on grounding are sentences it left without a citation, or padded with words no source says, despite the prompt. Those are exactly the sentences the UI flags for the agent. An earlier run, before the prompt asked for a citation on every sentence, was at 65.7%.

## Design choices

**Lambda outside a VPC, Postgres over TLS.** Putting Lambda in a VPC to reach RDS also means a NAT Gateway to call Bedrock and Slack, which costs about $32/month before any traffic. Instead, the functions connect over TLS to any Postgres that supports pgvector: Neon or Supabase (free tiers work) or RDS.

**Streaming from a function URL.** API Gateway HTTP APIs buffer the whole response, so streamed answers come from a Lambda function URL in `RESPONSE_STREAM` mode, behind the same admin token. Everything else stays on API Gateway.

**Postgres + pgvector instead of a vector database.** Docs, chunks, tickets, approved answers, question logs and the rate-limit budget live in one database you can back up, query with SQL and delete from with a cascade.

**SQS between Slack and the model.** Slack retries any request that doesn't get a response within 3 seconds. The Slack Lambda verifies the signature, acknowledges right away, and queues the job. The worker answers and posts back. Failed jobs are retried 3 times, then land in a dead-letter queue.

**Hybrid retrieval and a relevance floor.** Pure vector search always returns *something*, and a model handed loosely related text will often produce a confident wrong answer. The keyword check plus a minimum score means off-topic questions get "not in the knowledge base", with zero model tokens spent.

**A deterministic gate, a live report.** The merge gate runs the offline models so the score only moves when the code does. The live-model run is there to see how a real model behaves, not to block merges on noise.

**Providers are swappable.** Embeddings and generation sit behind two small interfaces: Bedrock (Titan + Claude), OpenAI, or `local`. Local needs no keys: hashed keyword embeddings and an extractive answer builder. That keeps tests, CI and local dev free and deterministic, and it powers the browser demo.

**Boring, testable core.** All the logic (chunking, retrieval, quoting, grounding, approved answers, the queue, prompts, Slack formatting) is in `packages/core` with no framework. The Lambdas and the local dev server are thin adapters around it.

## What it costs to run

Rough monthly estimate for a team asking about **1,000 questions a month** with a few hundred help articles. Check current AWS pricing before relying on these.

| Piece | Cost |
| --- | --- |
| Lambda, API Gateway, SQS, function URL | ~$0 (inside free tier at this volume) |
| S3 + CloudFront for the admin page | ~$0 |
| Secrets Manager (1 secret) | $0.40 |
| Postgres + pgvector | $0 on Neon/Supabase free tier, or ~$12 for RDS `db.t4g.micro` |
| Bedrock Claude Haiku 4.5 (~3k input + 300 output tokens per answer) | ~$4.50 |
| Bedrock Titan embeddings (questions + re-indexing docs) | < $0.10 |
| **Total** | **about $5–17/month** |

Approved answers and questions with no relevant sources cost nothing, since neither calls the model.

## Run it locally (no AWS or API keys needed)

Requires Node 20+ and Docker.

```bash
git clone https://github.com/evannawfal/ticketwise && cd ticketwise
npm install
docker compose up -d                 # Postgres 16 + pgvector on :5432
cp .env.example .env && set -a && source .env && set +a
npm run db:reset                     # tables + Northpine docs, tickets and approved answers
npm run dev:api                      # API on http://localhost:8787
npm run dev:admin                    # admin on http://localhost:3000
```

Open the admin page, go to **Settings**, and enter `http://localhost:8787` and the `ADMIN_TOKEN` from your `.env`.

To use real models locally, set `LLM_PROVIDER=bedrock EMBEDDING_PROVIDER=bedrock` (uses your AWS credentials) or `openai` with `OPENAI_API_KEY`. Re-run `npm run db:reset` after changing the embedding provider, since vectors from different models can't be compared.

The queue limits default to 4 calls at once, 50 requests and 100,000 tokens a minute. Set `LLM_MAX_CONCURRENT`, `LLM_REQUESTS_PER_MINUTE` and `LLM_TOKENS_PER_MINUTE` to your provider's limits; `.env.example` lists the rest.

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
   The deploy bundles the Lambdas, creates the API, the streaming function URL, queue, admin site and tables, and prints `AdminUrl`, `ApiUrl`, `StreamUrl` and `SlackRequestUrl`. The admin site picks up both URLs on its own.
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
4. Try `/ask how do refunds work?` or `@Ticketwise draft <paste a customer email>` in a channel the bot is in. Approved answers apply in Slack too.

## API

All routes except `/health` need `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/ask/stream` | `{ "question": "...", "mode"?: "prefer" \| "only" \| "off" }` | Server-Sent Events: `sources`, `status`, `delta`…, `done` (or `error`) |
| `POST` | `/draft/stream` | `{ "ticket": "..." }` | same events |
| `POST` | `/ask` | `{ "question": "...", "mode"?: ... }` | `{ text, mode, citations[{…, quotes[]}], grounding, approved?, usage, queuedMs, retries, … }` |
| `POST` | `/draft` | `{ "ticket": "..." }` | same shape, `text` is the draft |
| `GET` | `/approved` | | `{ approved[] }` |
| `POST` | `/approved` | `{ question, answer, sources?[{ title, url? }] }` | `{ approved }` |
| `PUT` | `/approved/:id` | same | `{ approved }` |
| `DELETE` | `/approved/:id` | | `{ deleted: true }` |
| `GET` | `/documents` | | `{ documents[] }` |
| `POST` | `/documents` | `{ title, content, url?, sourceType? }` | `{ document }` |
| `POST` | `/documents/tickets` | `{ "csv": "..." }` | `{ imported, skipped }` |
| `DELETE` | `/documents/:id` | | `{ deleted: true }` |
| `GET` | `/stats` | | `{ documents, tickets, chunks, approvedAnswers, questionsLast7Days }` |
| `POST` | `/slack/events` | Slack slash command or Events API payload | Slack ack |

On AWS, the two `/stream` routes are served from `StreamUrl`; locally, from the API itself.

```bash
curl -sN $API/ask/stream -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"What happens if our card payment fails?"}'
```

## Tests

```bash
npm test                                         # unit, API and eval tests (in-memory store)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ticketwise npm test   # adds real Postgres tests
npm run eval                                     # the 30-question benchmark, offline
npm run loadtest -w @ticketwise/api              # 50 users at once against a rate-limited fake provider
npm run typecheck && npm run synth               # types + CDK synth (bundles all Lambdas)
```

102 tests cover chunking, CSV import, retrieval on the sample help center, quotes being exact slices of their source, ungrounded sentences being flagged, streaming (deltas add up to the final text; errors after the stream opens arrive as events), OpenAI and SSE parsing, the queue (order, concurrency cap, token budget refill and refunds, timeouts, aborts, Retry-After pauses), retries (only before the first token), 40 users against a provider that rejects a 4th concurrent call, approved answers (byte-for-byte, near-misses, modes, edits), the shared budget across two clients on a real Postgres, the grader and the merge gate, admin auth and validation, and Slack signatures. CI runs all of it on every push.

## Project layout

```
packages/core     Retrieval, quoting and grounding, approved answers, request queue and retries,
                  prompts, providers (Bedrock/OpenAI/local), pgvector + in-memory stores
services/api      Lambda handlers (api, stream, slack, worker, migrate), router, local dev server, load test
apps/admin        Next.js admin page (static export); demo mode runs core in the browser
evals             Benchmark, grader, calibration, merge gate and score history
infra             AWS CDK stack: HTTP API, function URL, Lambdas, SQS + DLQ, Secrets Manager, S3 + CloudFront
sample-data       Northpine help center (Markdown), ticket export (CSV) and approved answers, all fictional
```

## Limits and next steps

- The grounding check is word overlap. It's strict and deterministic, which suits a merge gate, but it can't follow reasoning. A model-graded check on the live run would add a second opinion.
- 30 questions on one fictional help center is enough to catch regressions like the stemmer one, not to claim a general accuracy number. A real deployment would add questions from its own tickets.
- Approved answers match on one wording of the question. Storing a few wordings per answer would help paraphrases that the local embeddings miss.
- The admin page is protected by a single shared token. A real multi-team rollout would put it behind SSO (Cognito or the company's IdP).
- Docs are text and Markdown. PDF and HTML import, plus syncing from Zendesk or Notion on a schedule, would be the next additions.

MIT License.
