# Execution method

The MCP arm uses the ProteinAtlas MCP server. The SQL arm uses the HPA TSV data
through a DuckDB MCP server. Both use a plain model/tool loop. The benchmark
contains four models, 45 questions each, in both arms. No AtlasAI runs are
included in this results collection.

## Recorded execution

| Questions | Execution |
| --- | --- |
| Q1–Q21 | Captured launchers ran the loop on Aurem; the MCP service ran on buildbox and SQL ran locally. The initial Flash SQL basic launcher used an 8,000-token output limit; captured MCP launchers used 32,000. |
| Q22–Q26 | The loop ran on Aurem, with MCP on buildbox and SQL locally; 32,000 output tokens and 20,000 displayed characters per tool result. |
| Q27–Q45 | The loop and both servers ran on buildbox; one MCP worker and two SQL workers. Configuration: 32,000 output tokens, 20,000 displayed characters per tool result, 30 configured calls and 30 turns. |

These are recorded launch settings; historical batches must not be described
as identical. The data manifest records 98 HPA files totaling 26,112,818,882
bytes. The SQL server limits returned rows to 2,000 and query time to 120
seconds, and restricts filesystem access to the HPA data directory.

Each question is a fresh conversation. Full message history is replayed.
No explicit sampling override is set. The original 30-call threshold can
request a final answer and still continue within the turn limit; it is not a
strict ceiling. SDK provider retries and reconnection behaviour remain in the
runner. The paired ambiguity prompts are independent conversations, not an
interactive clarification exchange.

## Run the current harness

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
the model prompt. These instructions describe the current entrypoint; they
do not claim that every historical question used the same runner revision.

## Scoring and accounting

[grading.md](grading.md) defines Correct, Partial and Wrong. All questions remain
in both arms' denominators, with no access-related allowances. Difficulty is
separate metadata under the [common rubric](../questions/difficulty.md).

The per-question and summary tables retain recorded token totals and estimated
costs. Cached input is included in input and must not be added a second time.
Table accounting charges uncached input, cached input and output at their
recorded rates, with retained provider-reported additional generation tokens
included. `runner/prices.json` preserves the historical rates. Raw trace costs
can differ from the normalized tables. Retried calls without retained usage
are not silently estimated; totals are not provider invoices.
