# Results

Two arms, one folder each, one folder per model under `runs/`. The reader
arm holds one directory per question (`answer.md`, `result.json`,
`events.json`, every recorded model call); the web arm holds one answer,
one trace and the saved tool outputs per question. `scores.json` beside each
model's runs, `results.tsv` and `summary.json` per arm come from
`execution/score.py`, which is mechanical: see
[../execution/README.md](../execution/README.md).

## gemini-3.8-flash, 13–14 September 2026

Both arms use Gemini 3.8 Flash. Reader uses low reasoning effort; the web
arm does not set an explicit reasoning effort.

| Arm | Easy | Medium | Hard | Correct | Facts | Model calls | Tokens in | Tokens out | Cost | Median seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reader | 5 / 5 | 10 / 10 | 5 / 5 | 20 / 20 | 50 / 50 | 77 | 312,488 | 4,562 | $0.25 | 6 |
| web | 5 / 5 | 10 / 10 | 5 / 5 | 20 / 20 | 50 / 50 | 187 | 1,819,594 | 9,099 | $1.44 | 14 |

Both arms cite proteinatlas.org in all 20 answers. The reader read 55 pages
in all (2.8 per question), each quote checked against the page text before
the answer was returned.
