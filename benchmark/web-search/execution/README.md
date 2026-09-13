# Execution method

Two arms answer the same 20 questions about the Human Protein Atlas from
proteinatlas.org:

| Arm | What runs |
| --- | --- |
| reader | AtlasAI's reader (`dictionary_expert_hpa`, about mode, `Backend/src/system/agents/reader.js`): it browses proteinatlas.org by following the site's own sections and links, quotes what it cites, and every quote is checked against the page text by code before the answer is returned. Run with `Backend/scripts/manual/reader_question.js`, one process per question, one catalog model bound, every model call recorded. |
| web | The same model with open web tools: a DuckDuckGo search and a page opener (`../../system/execution/servers/web/`), driven by the system benchmark's runner `../../system/execution/runner/run.mjs` with `--server web` and this folder's question file. Nothing is verified for it. |

Only the question text reaches the model in either arm. Run from the
respective directories, for example:

```
# reader arm, from Backend/ with its .env loaded
node scripts/manual/reader_question.js --question-file <text file with the question> --model gemini-3.8-flash --effort low --out /abs/path/benchmark/web-search/results/reader/runs/gemini-3.8-flash/W1

# web arm, from benchmark/system/execution
HPA_BENCH_ENV_FILE=<backend .env> HPA_DATA_DIR=<local data dir> node runner/run.mjs --provider openai --api chat \
  --model gemini-3.8-flash --base-url https://generativelanguage.googleapis.com/v1beta/openai/ --api-key-env GEMINI_API_KEY \
  --server web --questions-file /abs/path/benchmark/web-search/questions/questions.json --questions all \
  --max-output 32000 --result-chars 20000 --max-calls 30 --max-turns 30 --out /abs/path/benchmark/web-search/results/web/runs/gemini-3.8-flash
```

## References

`references/answers.json` holds, for each question, the facts the answer must
contain (each with the spellings accepted), the page they come from, a
verbatim quote from that page, and the date the page was read.

## Scoring

`execution/score.py <arm> <model>` reads every answer under
`results/<arm>/runs/<model>/` and checks each reference fact for presence,
comparing case-insensitively with thousands separators removed. A question is
correct when every fact is present. The script also records whether the
answer cites proteinatlas.org, the tokens, seconds and list-price cost, and
writes `results/<arm>/results.tsv` and `summary.json`. Nothing is graded by a
model or by hand.
