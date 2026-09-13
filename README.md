# AtlasAI

AtlasAI is the natural-language research assistant of the [Human Protein Atlas](https://www.proteinatlas.org),
developed by the Human Protein Atlas project at Science for Life Laboratory, KTH Royal Institute
of Technology, together with King's College London.

Ask it a research question and it returns a report in which every number is bound to the table
cell it was computed from. A claim whose number is not in a cited cell is refused, so a report
cannot state what the data does not hold. Every intermediate table is an artifact with its
operation and inputs recorded, and a finished study is shown as a map of those steps with its
provenance graph.

Measured on the [benchmarks](benchmark/README.md) in this repository:

- On 45 research questions that need tables, statistics and figures, an open-weight 27B model
  running inside AtlasAI delivers 40 complete answers. The strongest closed model with SQL access
  to the same files delivers 9; any model over the atlas's MCP server delivers at most 2. The same
  two models that run inside AtlasAI deliver 0 and 1 over MCP and 5 and 7 over SQL: the gain is
  the system.
- On the three questions written to invite inference beyond the data, AtlasAI declined every
  time; the tool arms invented in 36 of 42 answers.
- Its search agent composes the exact atlas query for 216 of 236 plain-language questions and
  the right gene set for 220. Its investigator returns the right rows from the right file for 30
  of 30. Its reader answers 19 of 20 documentation questions from the atlas's own pages with
  every quote verified, at a fifth of the tokens an open web search spends.

Four agents answer:

- **Search** (`deep_research_hpa`): finds the genes matching a description the way the atlas
  search would, from the atlas's own schema, and returns them as a table with the search it ran.
- **Investigator** (`investigator_hpa`): answers a question with rows read from the HPA data
  release, for one gene or for hundreds, or for any list of points such as tissues or cell lines.
- **Dictionary expert**: histology, pathology and cell-biology questions answered from the atlas
  dictionary with its annotated images, and questions about the atlas itself answered from its
  pages with verified quotes.
- **ASO, the Autonomous Scientific Orchestrator** (`aso_hpa`): a research objective that needs
  several steps. It plans the deliverables, summons the search and the Investigator, combines
  their tables with declarative operations (join, filter, rank, aggregate, compute, pivot,
  correlate, overlap, chart), and finishes with the bound report.

Every study computes on a versioned release of the atlas's published data (25.1 today), so the
same question gives the same tables; the frontend streams each run as it happens.

Live instance: <https://atlas-ai-livid.vercel.app>

## What is where

```text
AtlasAI/
├── Backend/                         # Node API (Express 5, MySQL `atlasai`, one inference gateway)
│   ├── server.js                    # process bootstrap and route composition
│   ├── src/system/agents/           # the agents: deepResearchTrail, investigatorTrail, investigatorBulk,
│   │                                #   dictionaryExpert, checkInclusion, asoStudy (the study loop)
│   ├── src/system/aso/              # the study's desk, table operations, report binder, provenance, chart rendering
│   ├── src/hpa/                     # atlas schema and search options, the search evaluator, the data-release adapter
│   ├── src/inference/               # the gateway and the provider adapters (OpenAI-compatible, Gemini, Anthropic)
│   ├── src/http/                    # routes, CORS, authentication, rate limiting
│   ├── src/database/schema.sql      # the schema, the model catalog, the HPA file catalog
│   ├── scripts/sync-hpa-data.js     # downloads the active HPA release
│   ├── scripts/build-hpa-duckdb.js  # loads the release into one DuckDB file beside the TSVs
│   ├── scripts/manual/              # manual agent runners
│   └── tests/unit/                  # the backend test suite (node --test)
├── Frontend/                        # React app (Create React App); see Frontend/README.md
├── .github/workflows/               # tests on every push to main that touches Backend/, then the release webhook
├── AUTHORS.md · CITATION.cff · CODE_OF_CONDUCT.md · CONTRIBUTING.md · SECURITY.md
└── LICENSE · NOTICE                 # Apache License 2.0
```

`Backend/README.md` documents the backend in detail: configuration, the database and the
inference catalog, conversations and runs, authentication, the platform policy, HPA data
releases, the study orchestrator, provenance, and deployment.

## Benchmarks

[benchmark/](benchmark/README.md) holds four benchmarks with their questions,
references, execution notes and every recorded run: the 45-question system
benchmark (AtlasAI against the same models over the atlas's MCP server and
over SQL), and one benchmark each for the search agent (236 questions), the
investigator (30) and the reader against open web tools (20). The three
agent benchmarks are scored by code against references.

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
node scripts/build-hpa-duckdb.js   # loads the release into hpa-<version>-<stamp>.duckdb beside the files (the server does it at start if it must)
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

> Green E, von Feilitzen K, Johansson F, Forsberg M, Sumer Z, Song X, Liao X, Li M, Altay Ö,
> Yang H, Zhang T, Kong X, Li X, Mardinoglu A, Uhlén M\*, Zhang C\*. *AtlasAI: Multi-Agent Reasoning
> for Knowledge Discovery in the Human Protein Atlas.* Research Square (2026).
> <https://doi.org/10.21203/rs.3.rs-9452188/v1> (\* corresponding authors)

`CITATION.cff` carries the same reference in machine-readable form.

## Licence, conduct and contributions

- Licensed under the Apache License, Version 2.0; see `LICENSE` and `NOTICE`.
- Authors, credits and funding: `AUTHORS.md`.
- How to contribute: `CONTRIBUTING.md`. Conduct: `CODE_OF_CONDUCT.md`. Security reports: `SECURITY.md`.
