# AtlasAI Backend

AtlasAI is one Node.js API process for Human Protein Atlas conversations,
research agents, batch work, and ASO workspaces. `server.js` is
the only composition and process entry point; there is no second `app.js`
bootstrap.

## Repository layout

```text
Backend/
├── server.js                    # process bootstrap and route composition
├── src/
│   ├── config/                  # strict runtime configuration validation
│   ├── database/
│   │   ├── client.js            # MySQL pool and transaction boundary
│   │   ├── schema.sql           # canonical atlasai schema and model catalog
│   │   └── repositories/        # persisted domain queries
│   ├── hpa/                     # HPA schema and search-option data
│   ├── http/
│   │   ├── middleware/          # CORS, auth, rate limiting
│   │   ├── requestContext/      # explicit request/Cloudflare extraction
│   │   └── routes/              # HTTP transport handlers
│   ├── inference/               # one gateway plus provider adapters
│   ├── security/                # sessions, opaque tokens, CSRF, cookies
│   ├── shared/                  # stable IDs and network canonicalization
│   └── system/
│       ├── agents/              # current HPA agent implementations
│       ├── aso/                 # ASO storage, analysis, and rendering
│       ├── deployment/          # authenticated release queue
│       └── orchestrator.js      # application tool dispatch
├── data/                        # local HPM source data
├── deploy/
│   ├── cloudflare/              # optional enriched-metadata Worker
│   ├── pm2/                     # removable single-process PM2 definition
│   └── production/              # exact-SHA canary and rollback script
├── runtime/                     # generated workspaces; ignored by Git
├── scripts/manual/              # explicit manual agent runners
└── tests/
    ├── fixtures/
    └── unit/
```

There are no parallel `modules`, root-level `agents`, root-level `aso`,
`legacy`, or migration directories.

## Configuration

Copy `.env.example` to the ignored `.env` file and fill every value. The file
contains values only. `src/config/runtime.js`, `src/security/config.js`, and
`src/database/client.js` validate the contract and fail startup on missing or
invalid configuration; they do not supply hidden defaults. Process or PM2
environment values take precedence over `.env`, which keeps local startup and
deployment configuration compatible.

```bash
npm install
npm test
npm start
```

The frontend has its own required `REACT_APP_HPA_API_BASE` build variable. A
backend configuration or deployment does not implicitly configure or deploy
the frontend.

## Database and inference

`src/database/schema.sql` is the only schema source. It targets `atlasai`
explicitly and never operates on the old HPA database. It contains no migration
ledger. Every stored point in time is Unix epoch milliseconds in a
`BIGINT UNSIGNED ..._unix_ms` column; there are no SQL temporal column types.

The catalog seeds seven providers and thirty selectable models. A row's
`reasoning_effort`, when set, is sent verbatim by the OpenAI-compatible adapter;
the GPT-5.6 rows carry `none` because Chat Completions accepts function tools
from those models only without reasoning. Exactly one model
may have `status = 'active'`, enforced by a unique generated singleton. Startup
requires exactly one enabled, credentialed, streaming/tool-capable selection.
Every inference call passes through `src/inference/gateway.js`; request code
cannot override the active database model. Query and batch requests resolve the
active row once at their boundary, then bind that exact model to the whole
request so model switching cannot mix providers or persistence metadata midway
through a run. Changing the active row takes effect on the next request without
a process restart, provided that provider credential is already in the process
environment.

OpenAI, Gemini, GLM, Alibaba Model Studio (Qwen, DeepSeek, and Kimi open-weight
models on the international endpoint), DeepSeek, and GroqCloud use the
OpenAI-compatible adapter. GroqCloud is seeded `disabled` because its free tier
cannot fit the research prompts. Anthropic uses its native Messages API adapter;
it never forwards sampling parameters, and it accepts a single fenced JSON block
in JSON-object mode because Claude models may wrap JSON in markdown fences. Both implement the same internal chat
completion contract used by the agents, including text streams, tool calls,
tool results, usage totals, and validated JSON-object responses.

Manual runners resolve and bind the active row once at the start of each run,
using the same gateway contract as HTTP requests. Automated tests and fixtures
remain under `tests/`; production never imports either `tests/` or
`scripts/manual/`.

## Conversations, runs, and inference calls

`messages` holds human-visible text only: the user's message and the assistant's
answer, which links to the user message it answers (`parent_message_id`) and to
the inference call that produced it (`inference_call_id`). Tool executions are
`runs`: one row per tool call with the model's own arguments, the sentence the
assistant streamed before running the tool, the compact result document the
model received back, and promoted scalars the UI links to (`search_url`,
`rows_found`, `validation_passed`, `attempts`, `workspace_id`). Their progress
is `run_events`, ordered by `sequence_no`; ASO's structured step payloads land
in `detail_json` next to the text.

`inference_calls` is written by the gateway itself, so every model request is
recorded whoever made it: purpose (`router`, `preface`, `synthesis`, `answer`,
`agent`, `batch`, `manual`), the run, conversation, request event, batch query,
or workspace it served, provider request id, finish reason, token counts, time
to first token (streamed calls only), total latency, and a stored
`output_tokens_per_second` (output tokens over the time after the first token,
or over the full latency for whole-response calls). Prompts
and responses are hashed, not copied. Callers describe the request with
`inference.withContext({ purpose, conversationId, runId, ... }, fn)`; nested
contexts inherit the outer ids, and `context.callIds` returns the recorded ids.

`request_events` rows are inserted when a request arrives and completed when the
response finishes, so `req.requestEventId` is available to everything that runs
while serving the request. `GET /conversations/messages` returns the ordered
timeline the frontend renders (`type: 'message' | 'run'`), built by
`src/http/timeline.js` from those tables.

## Authentication and request controls

- Access, refresh, and CSRF values are independent random 256-bit tokens; only
  SHA-256 digests are stored.
- Access and refresh cookies are `HttpOnly`; unsafe cookie-authenticated
  methods require the matching CSRF header.
- Refresh tokens rotate once. Reuse revokes the entire session family.
- Conversation, batch, and workspace reads are scoped to the authenticated
  visitor in the database query.
- CORS accepts only configured exact origins, and a global rate limiter applies
  before application routes.
- Workspace downloads reject symlinks and paths outside the owned workspace.

## Cloudflare metadata

`request_events` stores request and Cloudflare fields in explicit typed
columns. There is no catch-all metadata JSON column. Standard Cloudflare and
Managed Transform headers are accepted only when the immediate peer is the
local tunnel and the request has a valid Cloudflare Ray plus connecting IP.

For the larger `request.cf` surface, deploy
`deploy/cloudflare/metadata-worker.mjs` in front of a dedicated HTTPS origin,
set the Worker secrets `ATLAS_ORIGIN_URL` and `ATLAS_METADATA_SECRET`, then set
the backend to `ATLAS_CLOUDFLARE_ENRICHED_HEADERS=true` with the same metadata
secret. The Worker removes client-supplied Atlas metadata headers before adding
authenticated replacements. When enriched mode is disabled, Worker-only
headers are ignored.

## Local and PM2 operation

`npm start` remains the direct local path. The optional PM2 definition at
`deploy/pm2/ecosystem.config.cjs` runs one forked process and does not create a
Redis or cluster dependency. Starting, reloading, or deploying it is a separate
operator action.

## Backend auto-deployment

The existing API origin owns `POST /deploy/github` and
`GET /deploy/github/:sha`; no second hostname or backend process is required.
Both endpoints require `x-deploy-secret`. The backend reads that 256-bit value
from `ATLAS_DEPLOY_WEBHOOK_SECRET_FILE`, while GitHub Actions stores the same
value as `ATLAS_DEPLOY_WEBHOOK_SECRET`. The secret is never stored in Git or
sent to the frontend.

`.github/workflows/backend-deploy.yml` tests backend-only pushes to `main`, then
calls the deployment endpoint when the repository variable
`ATLAS_BACKEND_AUTO_DEPLOY` is exactly `true`. Each deployment fetches the exact
requested commit into a retained detached worktree, installs locked
dependencies, runs tests and syntax checks, and boots a private canary on port
19012. Only then does PM2 replace `atlas-api`. A failed production health check
restores the previously running release. The development checkout is never
reset, cleaned, or used as the deployed release.
