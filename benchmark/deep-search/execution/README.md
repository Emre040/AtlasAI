# Execution method

One agent is under test: the search agent (`deep_research_hpa`, the trail agent
in `Backend/src/system/agents/deepResearchTrail.js`). It receives one question,
plans the filters over the atlas search schema, walks each field's option tree,
composes one search query, executes it on the local atlas release and returns
the query, the trail behind it, the rows found and the tokens used. No question
words, category names or examples are given to it beyond the schema it always
plans over.

Every run is made with `Backend/scripts/manual/search_benchmark.js`, which binds
one catalog model for the process, keeps the database read only and records
every step. The three modes:

| Mode | What it does |
| --- | --- |
| `--check` | Composes every reference query from `references/queries.json`, executes it on release 25.1, fetches it from proteinatlas.org, and records the query, its clauses and both gene counts. A reference is sound when both gene sets are the same and not empty. |
| `--run --model <key> --effort <level> --label <name>` | Runs each question once and writes `results/<name>/runs/<id>.json`: the composed query, the trail (requirement, field, path, operator, reason), the plan, rows found, tokens, seconds, every step. A question with a file is not run again. |
| `--score --label <name>` | Executes each composed query and its reference on release 25.1 and fetches both from the atlas; writes `results/<name>/results.tsv` and `summary.json`. |

Run from `Backend/` with its `.env` loaded, for example:

```
node scripts/manual/search_benchmark.js --check --benchmark /abs/path/benchmark/deep-search
node scripts/manual/search_benchmark.js --run --benchmark /abs/path/benchmark/deep-search --model gemini-3.8-flash --effort low --label flash-low --parallel 10
node scripts/manual/search_benchmark.js --score --benchmark /abs/path/benchmark/deep-search --label flash-low
```

## Scoring

Three measures per question, all mechanical:

| Measure | Meaning |
| --- | --- |
| Same clauses | The composed query has exactly the reference's filters: same fields, same values, same operators, in any order. |
| Same genes | The composed query returns the same gene set as the reference on the same atlas release, fetched live. A different but equivalent query passes here and fails the clause measure. |
| Count verified | The composed query returns the same genes on release 25.1 as on proteinatlas.org, so the count the agent works from is the atlas's count. This is the check the original 236-query benchmark used, applied to the gene set rather than the row count (a filter that leaves a level open returns one row per gene and matched value). |

The headline number is same genes. Same clauses is stricter and reported
beside it. Nothing is graded by a model or by hand.

## Execution

Every query is executed on release 25.1 of the atlas, and the check and score
modes fetch it from proteinatlas.org as well: every reference returns the
same genes both ways, and so does every composed query but one. Questions
name brain regions and cell types rather than the search's aggregate tissues.
