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
│       ├── aso/                 # study workspaces, artifacts, operations, provenance, chart rendering
│       ├── deployment/          # authenticated release queue
│       └── orchestrator.js      # application tool dispatch
├── deploy/
│   ├── cloudflare/              # optional enriched-metadata Worker
│   ├── pm2/                     # removable single-process PM2 definition
│   └── production/              # exact-SHA canary and rollback script
├── runtime/                     # generated workspaces; ignored by Git
├── scripts/
│   ├── sync-hpa-data.js         # downloads the active HPA release
│   ├── build-hpa-duckdb.js      # loads the release into one DuckDB file beside the TSVs
│   ├── sql/                     # operator SQL
│   └── manual/                  # explicit manual agent runners
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

The frontend has its own required `VITE_HPA_API_BASE` build variable. A
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

## Platform policy, prices, model selection, and visitor keys

`platform_config` is the operator's control panel: exactly one row is active (`status = 'active'`).
It holds spending budgets (platform and per visitor, per day/week/month, USD), volume limits
(requests per minute/hour/day, tokens, runs, ASO runs, concurrent runs, batch queries, global
caps), what happens over budget (`block` or `fallback_model` with `fallback_inference_model_id`),
whether visitors may pick a model or bring their own provider keys, request shaping
(`query_max_characters`, `model_history_messages`, batch size and concurrency), agent defaults
(study parallelism; the older step and top-x columns are no longer read) and the active HPA data release. A limit
set to `NULL` is not enforced. `budget_window_mode` chooses rolling windows (last 24 h / 7 d /
30 d) or UTC calendar periods. Edits are picked up within five seconds; no restart.

Prices live on `inference_models`: input, cached-input and output price in micro-USD per million
tokens, plus `price_source_url` and `price_verified_unix_ms`. Every completed call in
`inference_calls` gets `cost_microusd` from the bound model (uncached prompt tokens at the input
price, cached tokens at the cached price when published, output tokens at the output price), and
carries `visitor_id`, `credential_source` (`platform` or `visitor`) and `model_selection`
(`auto`, `visitor`, `fallback`).

Admission runs in `src/policy/` before `POST /query/stream` and `POST /batch`. The middleware
resolves the model (`model` in the body names a `visitor_selectable` config key, otherwise the
active model). An explicit model choice requires the visitor's stored key for that provider
and returns HTTP 403 with reason `provider_key_required` when the key is missing or visitor
keys are disabled. Only Auto may use the platform key; Auto uses the visitor's key when one is
available for its provider. Admission then checks volume limits and spend budgets against
`request_events`, `runs`, `batch_jobs` and `inference_calls`. A refusal answers
HTTP 429 with `{ "error": "policy_refused", "reason", "scope", "measured", "limit",
"retry_after_seconds" }` and writes a `policy_decisions` row. Public query and batch requests
block over budget rather than switching to a different platform-paid model, even when
`over_budget_behaviour` is configured for fallback. Requests paid with a visitor key bypass
spend budgets when
`visitor_keys_bypass_spend_limits` is set, and volume limits only when
`visitor_keys_bypass_volume_limits` is set.

Routes: `GET /models` returns the active model, the selectable catalog with prices, and only
providers used by those selectable models, with the visitor's key status. Internal providers
without visitor-selectable models are omitted. `GET /keys` lists the visitor's keys (suffix and usage only),
`PUT /keys/:provider` with `{ "api_key" }` checks the key against the provider's model-list
endpoint and stores it AES-256-GCM encrypted with the secret in `ATLAS_PROVIDER_KEY_SECRET_FILE`,
and `DELETE /keys/:provider` removes it. Keys are decrypted only for the request that uses them.

## HPA data releases

`hpa_datasets` is the HPA bulk-download catalog (one row per file, keyed by the catalog ID from the
HPA team's sheet) with the local sync state of each file. `platform_config.active_hpa_version`
selects the release in use; rows of other versions are ignored. `scripts/sync-hpa-data.js` reads
the active version, downloads every missing or changed file with curl from `download_url`,
checks the size against the server, hashes it, unpacks it into `HPA_DATA_LOCAL_DIR` (a single
TSV keeps its name; multi-file archives become a directory) and records `local_status`,
`local_path`, `download_bytes`, `download_sha256`, `unpacked_bytes` and the timestamps.
`scripts/build-hpa-duckdb.js` then loads every ready TSV into one DuckDB file beside them
(`hpa-<version>-<stamp>.duckdb`, named by the set of files it was built from, with
`hpa-<version>.duckdb.json` naming the current build and holding each table's column profile);
the Investigator's reads are queries against it, servers open it read-only, and a server builds
it at start when the files changed and no build matches. The
deployment runs it before switching releases (`--check` only reports). To ship a new release the
HPA team inserts the new rows, sets `active_hpa_version`, and redeploys; the first deployment
after that downloads the release.

The three research agents are schema-walking "trail" agents that never carry atlas rules in
code or prompts. `deep_research_hpa` (`src/system/agents/deepResearchTrail.js`) plans which
search fields answer the goal from the schema the search adapter exposes
(`src/hpa/searchAdapter.js` over `hpaSchema.js`, `searchOptions.js` and the atlas's own
definitions in `searchDocs.js`), fills each field from its option tree, composes the URL and
executes it. `investigator_hpa` answers a question with rows from the release: for one gene
(`investigatorTrail.js`) it reads the gene's rows from the per-gene tables the gene data adapter
catalogs (`src/hpa/geneDataAdapter.js`) and answers with the row it cites; for a list of points
(`investigatorBulk.js`, one gene or hundreds, or any values such as tissues) it finds the table
whose columns hold the answer, fetches those fields for every point, and returns the rows as one
artifact per source table.

`aso_hpa` (`asoStudy.js`) runs a study in turns over a desk (`src/system/aso/desk.js`) rebuilt
from state every turn: the plan, every artifact as one line (id, title, description, columns,
rows, what made it), the rows it asked to see, what is running, its history and its notes. It
never reads a file. It summons the search and the Investigator, whose results become artifacts,
and computes over artifact ids with the registered operations (`tableOperations.js`,
`studyTools.js`: join, filter, select, rank, aggregate, classify, compute, correlate, plus combine,
pivot, chart, overlap, explode). `finish` delivers the report (`studyReport.js`): tables and
figures by id, findings as claims bound to the rows and columns they rest on; a stated number that
is not among the bound cells refuses the report and says where the number lives. Figures are chart
specifications rendered by `pipelines/render_charts.py`.

Searches and Investigator reads run against the release in `HPA_DATA_LOCAL_DIR`:
`src/hpa/offlineSearch.js` evaluates a composed search with the proteinatlas.org search
semantics for category, class, location, evidence, cluster, prognostic, IHC and interaction
fields, and a field the release files cannot express stops the search with the unexpressible
requirement named. The dictionary expert reads proteinatlas.org.

## ASO study history and outputs

The frontend builds the study map and per-node View trace from ordered run events (`start`,
`turn`, `plan`, `note`, `tool.start`, `tool.done`, `tool.failed`, `call.failed`, `skip`,
`finish.refused`, `finish`). The trace follows recorded artifact IDs through their producing
steps and exposes the associated agent activity and ASO decisions. `aso_artifacts` and
`aso_artifact_links` retain the stored artifacts and their derivation links.

Completed studies show saved figures below the workspace download. The authenticated
`GET /workspaces/:uuid/artifacts/:filename` route serves registered artifacts, including figure
images; `GET /workspaces/:uuid/download` returns the workspace archive. Both routes check
workspace ownership.

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

A frontend dev server that talks to the production backend runs over HTTPS on
port 47831 (`HTTPS=true PORT=47831 npm start` in `Frontend/`), the one local
origin listed in `HPA_CORS_ORIGINS`. The production cookies are `Secure` and
cross-site, so a plain-HTTP or differently numbered local origin is refused.

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
