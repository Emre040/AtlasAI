# AtlasAI

AtlasAI is the natural-language research assistant of the [Human Protein Atlas](https://www.proteinatlas.org),
developed by the Human Protein Atlas project at Science for Life Laboratory and KTH Royal
Institute of Technology, and deployed in the Human Protein Atlas.

A research question in plain language is answered with a report, the tables it rests on and the
figures it asks for. Every statement in a report is bound to the cells of the table it was
computed from; every table records the operation and the inputs that produced it; a report that
states a number absent from its cited cells is refused. The provenance of a finished study is
stored and shown as a graph.

## Evaluation

The [system benchmark](benchmark/system/README.md) comprises 45 questions about the atlas: 4
lookups; 26 analyses, among them cohort construction, hypergeometric and matched-sample tests,
prognostic associations across cancers and expression contrasts across tissues; 7 negative tests
that tempt an unsupported conclusion; 3 ambiguous questions with explicit counterparts; and 5
documentation questions. 22 are Hard by a fixed rubric. Each question has a reference answer
computed from the atlas files. An answer is scored correct only when every requested number, list,
table and figure is delivered and matches the reference; there is no partial credit. Each question
is asked three ways, each in a fresh conversation: through the ProteinAtlas MCP server, through
SQL over the atlas files, and through AtlasAI over the same files.

| Configuration | Correct of 45 | Tokens, all 45 questions | Tokens per correct answer |
| --- | --- | --- | --- |
| AtlasAI, Qwen 3.8 27B (open weights) | 40 | 7,682,121 | 192,053 |
| AtlasAI, Gemini 3.8 | 37 | 13,537,292 | 365,873 |
| SQL, GPT-5.6 Terra | 9 | 2,748,768 | 305,419 |
| SQL, Gemini 3.8 | 7 | 16,315,108 | 2,330,730 |
| SQL, DeepSeek V4 Flash | 7 | 11,373,310 | 1,624,759 |
| SQL, DeepSeek V4 Flash (low effort) | 7 | 8,216,142 | 1,173,735 |
| SQL, Qwen 3.8 27B | 5 | 9,448,593 | 1,889,719 |
| SQL, GPT-5.6 Luna | 5 | 3,041,677 | 608,335 |
| SQL, GPT-OSS 120B | 3 | 11,386,142 | 3,795,381 |
| MCP, Gemini 3.8 | 2 | 33,957,838 | 16,978,919 |
| MCP, GPT-5.6 Terra | 1 | 861,502 | 861,502 |
| MCP, GPT-5.6 Luna | 1 | 823,919 | 823,919 |
| MCP, DeepSeek V4 Flash | 1 | 18,635,786 | 18,635,786 |
| MCP, DeepSeek V4 Flash (low effort) | 1 | 13,852,844 | 13,852,844 |
| MCP, GPT-OSS 120B | 1 | 9,221,940 | 9,221,940 |
| MCP, Qwen 3.8 27B | 0 | 16,184,473 | – |

Tokens per correct answer is the configuration's total over all 45 questions divided by its
correct answers. On numerical results alone, AtlasAI is correct on all 22 Hard questions with either model;
the best tool configuration reaches 15. On the three questions that invite inference beyond the
data, AtlasAI declined in all six runs; the tool configurations inferred in 36 of 42. The 80
recorded studies contain 350 statements bound to 3,469 computed tables.

Three further [benchmarks](benchmark/README.md) evaluate single agents against references, scored
by code: the search agent composes the reference query for 216 of 236 questions and an equivalent
gene set for 220; the investigator returns the reference rows from the reference file for 30 of
30; the reader answers 20 of 20 documentation questions from the atlas's pages with every quotation
verified, using 17% of the total tokens of the same model with web search.

## Agents

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

## What is where

```text
AtlasAI/
├── Backend/                         # Node API (Express 5, MySQL `atlasai`, one inference gateway)
│   ├── server.js                    # process bootstrap and route composition
│   ├── src/system/agents/           # the agents: deepResearchTrail, investigatorTrail, investigatorBulk,
│   │                                #   dictionaryExpert, asoStudy (ASO)
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
