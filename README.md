# HPA Agent

Monorepo containing the HPA Agent backend (Node/Express) and frontend (React).

```
Repo/
├── Backend/   # Node API server (port 8012)
└── Frontend/  # React app (port 8010)
```

## Prerequisites
- Node.js 18+
- (Optional) MySQL with a `webserver_hpa` database — without it the backend uses an in-memory store

## Configuration

Copy the template and fill in your own values:

```bash
cp Backend/config.env.example Backend/config.env
```

`config.env` is gitignored and never pushed.

### Required env vars (Backend will not work without these)
| Variable | Purpose |
|---|---|
| `HPA_MODEL` | Model ID passed to the LLM provider. **Recommended: `gpt-4.1-mini-2025-04-14`**. Throws on startup if missing. |
| `LLM_PROVIDER` | `openai` \| `gemini` \| `anthropic` \| `openrouter`. **Recommended: `openai`**. |
| `OPENAI_API_KEY` (or matching provider key) | API key for the chosen provider |
| `HPA_TBL_COOKIES`, `HPA_TBL_CONVERSATIONS`, `HPA_TBL_MESSAGES` | MySQL table names — `hpa_cookies` (visitor sessions), `hpa_conversations` (chat threads), `hpa_messages` (individual messages). Use the defaults from the example file unless you've renamed the tables in your DB. Required even with the in-memory fallback. |
| `HPA_CORS_ORIGINS` | Comma-separated allow-list. Include the frontend URL (`http://localhost:8010` for local dev) |

### Recommended (for persistence)
`HPA_DB_HOST`, `HPA_DB_USER`, `HPA_DB_PASS`, `HPA_DB_NAME`, `HPA_DB_CONN`. If any are missing, the backend falls back to an in-memory store — data is lost on restart.

### Optional
Tuning (`HPA_PORT`, `HPA_JSON_LIMIT`, `HPA_QUERY_RATE_LIMIT_*`, `TRUST_PROXY`), feature-specific (`HPA_ADMIN_USERNAME`/`HPA_ADMIN_PASSWORD` for `/hpa-admin`, `HPA_BATCH_SECRET` for `/batch`), and debug flags (`HPA_FORCE_MEMORY`, `HPA_SSE_DEBUG`, `HPA_LOG_LLM_IO`, `HPA_ASO_LOG_TOOL_STEPS`). All have sane defaults — see `Backend/config.env.example` for the full list.

The Frontend reads `REACT_APP_HPA_API_BASE` and `REACT_APP_HPA_ENV`, but both are pre-set by the npm scripts (`start:local`, `start:prod`) — no extra config needed for normal use.

## Backend

```bash
cd Backend
npm install
node server.js
```

Server listens on `http://localhost:8012` (configured via `HPA_PORT` in `config.env`).

Health check: `GET http://localhost:8012/healthz`

## Frontend

```bash
cd Frontend
npm install
npm run start:local
```

App opens at `http://localhost:8010` and talks to the backend at `http://localhost:8012` (set via `REACT_APP_HPA_API_BASE`).

Other scripts:
- `npm run start:prod` — dev server pointed at production API
- `npm run build` — production bundle to `Frontend/build/`

## TO TEST LOCALLY:

Run two terminals:

```bash
# Terminal 1
cd Backend && node server.js

# Terminal 2
cd Frontend && npm run start:local
```

Make sure `HPA_CORS_ORIGINS` in `Backend/config.env` includes `http://localhost:8010`
