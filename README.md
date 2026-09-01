# AtlasAI

Human Protein Atlas research agent: a Node/Express API that runs HPA search, gene investigation,
dictionary, inclusion-check, and ASO analysis agents against a catalog of language models, and a
React app that streams the runs.

```text
AtlasAI/
├── Backend/    # Node API (Express 5, MySQL `atlasai`, one inference gateway)
├── Frontend/   # React (Create React App)
└── .github/    # main-push workflow: Backend tests, then the Aurem release webhook
```

## Backend

Requirements: Node 20, MySQL 8, Chrome for Puppeteer (installed on first `npx puppeteer browsers install chrome`).

```bash
cd Backend
cp .env.example .env            # fill every value; nothing has a hidden default
mysql < src/database/schema.sql # creates the `atlasai` schema, the model catalog, the policy row, and the HPA file catalog
npm install
npm test
node scripts/sync-hpa-data.js   # downloads the active HPA release into HPA_DATA_LOCAL_DIR (optional; agents fall back to proteinatlas.org)
npm start                       # listens on HPA_HOST:HPA_PORT from .env
curl http://127.0.0.1:9000/healthz
```

The active model is the single `inference_models` row with `status = 'active'`; every model
request goes through `src/inference/gateway.js`, is admitted by the policy in `platform_config`
(budgets, limits, model selection, visitor keys), and is recorded with its cost in
`inference_calls`. `Backend/README.md` documents the layout, the conversation tables, the policy
layer, the HPA data releases and offline agent modes, ASO provenance, authentication, and the
Cloudflare request metadata.

## Frontend

```bash
cd Frontend
npm install
REACT_APP_HPA_API_BASE=http://localhost:9000 npm start   # any origin; HTTPS required off localhost
```

`npm run start:local` and `npm run start:prod` are the same command pointed at `localhost:8012`
and at the production API.

## Production

- Frontend: Vercel builds `Frontend/` on every push to `main` (`REACT_APP_HPA_API_BASE` is a Vercel build variable).
- Backend: Aurem, PM2 app `atlas-api`, reached at `https://p9000.greenaurem.org`.
- Releases: a push touching `Backend/**` runs the tests in GitHub Actions and posts the commit to
  `POST /deploy/github` on the API; `Backend/deploy/production/deploy.sh` checks the exact commit
  out into an isolated worktree, tests it, boots a canary, switches PM2, and rolls back on failure.
