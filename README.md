# AtlasAI

Monorepo containing the AtlasAI backend (Node/Express) and frontend (React).

```
Repo/
├── Backend/   # Node API server (port 8012)
└── Frontend/  # React app (port 8010)
```

## Prerequisites
- Node.js 18+

## Configuration

```bash
cp Backend/config.env.example Backend/config.env
```

Open `Backend/config.env` and paste your `OPENAI_API_KEY`. That's the only value you need to fill in for local mode — everything else is pre-set with working defaults.

`config.env` is gitignored and never pushed.

## Run

Two terminals:

```bash
# Terminal 1 — Backend (http://localhost:8012)
cd Backend
npm install
node server.js

# Terminal 2 — Frontend (http://localhost:8010)
cd Frontend
npm install
npm run start:local
```

Health check: `GET http://localhost:8012/healthz`

## Notes

- **Database:** runs in-memory by default — no MySQL needed. Data resets on restart. To enable persistence, fill in the `HPA_DB_*` block in `config.env`.
- **Other LLM providers:** swap `LLM_PROVIDER` to `gemini` / `anthropic` / `openrouter` and set the matching API key.
- **Other scripts:** `npm run start:prod` (dev server pointed at production API), `npm run build` (production bundle).
- **Optional features:** admin analytics (`/hpa-admin`) and batch API (`/batch`) require their own env vars — see `Backend/config.env.example`.
