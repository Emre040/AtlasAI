# Execution method

Three ways of answering are recorded. The MCP arm gives a model the
ProteinAtlas MCP server's tools; the SQL arm gives it the HPA files through a
DuckDB SQL server; both run a plain model and tool loop. The AtlasAI arm runs
ASO, the Autonomous Scientific Orchestrator.

## Settings

The model and tool loop runs with 32,000 output tokens, 20,000 displayed
characters per tool result, 30 configured calls and 30 turns; the Flash SQL
runs of Q1–Q21 were limited to 8,000 output tokens. The data manifest records
98 HPA files totaling 26,112,818,882 bytes. The SQL server limits returned
rows to 2,000 and query time to 120 seconds, and restricts filesystem access
to the HPA data directory.

Each question is a fresh conversation. Full message history is replayed. No
explicit sampling override is set. The 30-call threshold asks for a final
answer, and the loop may still continue within the turn limit. Provider
retries and reconnection remain in the runner. The paired ambiguity prompts
are independent conversations, not an interactive clarification exchange.

## Run the current harness

The AtlasAI runs were made with `Backend/scripts/manual/compare_study_context.js`
(one question through ASO, every model call recorded, the database
read only) and, for the five documentation questions,
`Backend/scripts/manual/reader_question.js` (one question through the reader);
both bind one catalog model for the process and write a run directory.

`runner/run.mjs` is the single entrypoint; `servers/sql/` and `servers/web/`
contain the SQL and web servers, and `servers/mcp/README.md` says where the
ProteinAtlas MCP server comes from. Install locked dependencies with `npm ci`
in the runner and in the SQL and web server directories on the execution host. Under
`results/*/runs/` the saved tool outputs are gzip-compressed (`.txt.gz`);
answers, traces and verdicts are plain text.
The HPA data and provider credentials remain external.

From this directory, with the variables set to the intended external files,
model, provider endpoint and a **new** output directory:

```bash
HPA_BENCH_ENV_FILE="$BENCHMARK_ENV_FILE" HPA_DATA_DIR="$BENCHMARK_DATA_DIR" \
node runner/run.mjs --provider openai --api chat \
  --model "$BENCHMARK_MODEL" --base-url "$BENCHMARK_API_URL" \
  --api-key-env "$BENCHMARK_API_KEY_NAME" --server sql \
  --questions all --max-output 32000 --result-chars 20000 \
  --max-calls 30 --max-turns 30 --out "$BENCHMARK_NEW_OUTPUT_DIR"
```

Use `--server mcp` for the other arm, `--server web` for the open-web tools
(a DuckDuckGo search and a page opener, `servers/web/`), or `--questions Q1,Q45` for an explicit subset. The default question file is `../questions/questions.json` relative
to this directory. Only question `text` is sent to the model: difficulty,
negative-test labels, expected behaviour and references are not included in
the model prompt.

## Scoring and accounting

[grading.md](grading.md) defines Correct, Partial and Wrong. All questions remain
in both arms' denominators, with no access-related allowances. Difficulty is
separate metadata under the [common rubric](../questions/difficulty.md).

The per-question and summary tables retain recorded token totals and estimated
costs. Cached input is included in input and must not be added a second time.
Table accounting charges uncached input, cached input and output at their
recorded rates, with retained provider-reported additional generation tokens
included. `runner/prices.json` holds the list prices used. Raw trace costs
can differ from the normalized tables. Retried calls without retained usage
are not silently estimated; totals are not provider invoices.
