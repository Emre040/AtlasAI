# HPA Agent

Monorepo containing the HPA Agent backend (Node/Express) and frontend (React).

```
Repo/
├── Backend/   # Node API server (port 8012)
└── Frontend/  # React app (port 8010)
```

## Prerequisites
- Node.js 18+
- MySQL running locally with a `webserver_hpa` database

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
