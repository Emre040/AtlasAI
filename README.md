# AtlasAI

AtlasAI is the natural-language research assistant of the [Human Protein Atlas](https://www.proteinatlas.org),
developed by the Human Protein Atlas project at Science for Life Laboratory, KTH Royal Institute
of Technology, together with King's College London.

A question in plain language is routed to the agent that answers it:

- **Search** (`deep_research_hpa`): finds the genes matching a description the way the atlas
  search would, from the atlas's own schema, and returns them as a table with the search it ran.
- **Investigator** (`investigator_hpa`): answers a question with rows read from the HPA data
  release, for one gene or for hundreds, or for any list of points such as tissues or cell lines.
- **Dictionary expert**: histology, pathology and cell-biology questions answered from the atlas
  dictionary with its annotated images.
- **Inclusion check**: whether a gene appears in an earlier result.
- **Study** (`aso_hpa`): a research objective that needs several steps. The orchestrator plans
  the deliverables, summons the search and the Investigator, combines their tables with
  declarative operations (join, filter, rank, aggregate, compute, pivot, correlate, overlap,
  chart), and finishes with a report whose every claim is bound to the cells it rests on.

Studies run on the pinned HPA data release only; nothing is read from the website. Every
intermediate result is an artifact with a title, a description, its columns, and the operation
and inputs that produced it. The report cites artifacts by id, prints the bound cells beside every
finding, and is refused when a stated number is not among them. The frontend streams each run as
it happens, draws a study as a map of its steps, and shows the stored provenance graph of a
finished study.

Live instance: <https://atlas-ai-livid.vercel.app>

## What is where

```text
AtlasAI/
├── Backend/                         # Node API (Express 5, MySQL `atlasai`, one inference gateway)
│   ├── server.js                    # process bootstrap and route composition
│   ├── src/system/agents/           # the agents: deepResearchTrail, investigatorTrail, investigatorBulk,
│   │                                #   dictionaryExpert, checkInclusion, asoStudy (the study loop)
│   ├── src/system/aso/              # the study's desk, table operations, report binder, provenance, chart rendering
│   ├── src/hpa/                     # atlas schema and search options, the offline search, the data-release adapter
│   ├── src/inference/               # the gateway and the provider adapters (OpenAI-compatible, Gemini, Anthropic)
│   ├── src/http/                    # routes, CORS, authentication, rate limiting
│   ├── src/database/schema.sql      # the schema, the model catalog, the HPA file catalog
│   ├── scripts/sync-hpa-data.js     # downloads the active HPA release
│   ├── scripts/manual/              # manual agent runners
│   └── tests/unit/                  # the backend test suite (node --test)
├── Frontend/                        # React app (Create React App); see Frontend/README.md
├── .github/workflows/               # tests on every push to main that touches Backend/, then the release webhook
├── AUTHORS.md · CITATION.cff · CODE_OF_CONDUCT.md · CONTRIBUTING.md · SECURITY.md
└── LICENSE · NOTICE                 # Apache License 2.0
```

`Backend/README.md` documents the backend in detail: configuration, the database and the
inference catalog, conversations and runs, authentication, the platform policy, HPA data
releases and offline agents, the study orchestrator, provenance, and deployment.

## Backend

Requirements: Node 20, MySQL 8, Python 3 with Matplotlib and NumPy for figure rendering,
Chrome for Puppeteer (installed on first `npx puppeteer browsers install chrome`).

```bash
cd Backend
cp .env.example .env            # fill every value; nothing has a hidden default
mysql < src/database/schema.sql # creates the `atlasai` schema, the model catalog, the policy row, and the HPA file catalog
npm install
npm test
node scripts/sync-hpa-data.js   # downloads the active HPA release into HPA_DATA_LOCAL_DIR; the Investigator and studies read it
npm start                       # listens on HPA_HOST:HPA_PORT from .env
curl http://127.0.0.1:9000/healthz
```

The active model is the single `inference_models` row with `status = 'active'`. The catalog
seeds seven providers (OpenAI, Google Gemini, Anthropic, Z.ai GLM, GroqCloud, Alibaba Model
Studio, DeepSeek) and their models, open-weight models included; every model request goes
through `src/inference/gateway.js`, is admitted by the policy in `platform_config`, and is
recorded with its cost in `inference_calls`.

## Frontend

```bash
cd Frontend
npm install
REACT_APP_HPA_API_BASE=http://localhost:9000 npm start   # any origin; HTTPS required off localhost
```

## Production

- Frontend: Vercel builds `Frontend/` on every push to `main` (`REACT_APP_HPA_API_BASE` is a Vercel build variable).
- Backend: PM2 app `atlas-api` behind `https://p9000.greenaurem.org`.
- Releases: a push touching `Backend/**` runs the tests in GitHub Actions and posts the commit to
  `POST /deploy/github` on the API; `Backend/deploy/production/deploy.sh` checks the exact commit
  out into an isolated worktree, tests it, boots a canary, switches PM2, and rolls back on failure.

## Data

AtlasAI reads the bulk data files published by the Human Protein Atlas. They are downloaded by
`scripts/sync-hpa-data.js` from the catalog in the database, are not part of this repository, and
are subject to the [Human Protein Atlas licence terms](https://www.proteinatlas.org/about/licence).

## Citation

If you use AtlasAI, please cite the preprint:

> Zhang C, Green E, von Feilitzen K, Johansson F, Forsberg M, Sumer Z, Song X, Liao X, Li M,
> Altay Ö, Yang H, Zhang T, Kong X, Li X, Mardinoglu A, Uhlén M. *AtlasAI: Multi-Agent Reasoning
> for Knowledge Discovery in the Human Protein Atlas.* Research Square (2026).
> <https://doi.org/10.21203/rs.3.rs-9452188/v1>

`CITATION.cff` carries the same reference in machine-readable form.

## Licence, conduct and contributions

- Licensed under the Apache License, Version 2.0; see `LICENSE` and `NOTICE`.
- Authors, credits and funding: `AUTHORS.md`.
- How to contribute: `CONTRIBUTING.md`. Conduct: `CODE_OF_CONDUCT.md`. Security reports: `SECURITY.md`.
