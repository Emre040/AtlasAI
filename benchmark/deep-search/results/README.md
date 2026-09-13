# Results

One folder per recorded run. Each holds `runs/<id>.json` (the composed query,
the trail, the plan, rows found, tokens, seconds, every step, and the score),
`results.tsv` (one line per question), `summary.json` and `run.json` (the
settings). Scores are mechanical: see [../execution/README.md](../execution/README.md).

## flash-low

Gemini 3.8 Flash at low reasoning effort, offline against release 25.1, ten
questions at a time, 13 September 2026.

| | Questions | Same genes | Same clauses | Count verified |
| --- | --- | --- | --- | --- |
| Easy | 51 | 49 | 49 | 50 |
| Medium | 147 | 140 | 137 | 143 |
| Hard | 38 | 31 | 30 | 38 |
| All | 236 | 220 | 216 | 231 |

232 of 236 questions produced a query; 4 ended inside the agent (three in
the option-tree repair step on a not-detected tissue, one declaring the
"multilocalizing" option inexpressible). Count verified is out of the 232
composed queries: the one miss is a query on the immune-cell "not detected"
category with no cell named, which the local release evaluates differently
from the atlas.

Tokens: 1,370,500 in total (1,216,967 in, 153,533 out), a median of 5,395
per question; $1.48 at list price, $0.006 per question. The run took 15
minutes of wall clock; the median question took 16 seconds.

The 12 composed queries that return a different gene set from the reference:

| Cause | Questions |
| --- | --- |
| A neighbouring category added: "enriched" also takes Group enriched | D56, D121, D211, D214, D217, D235 |
| An RNA absence ("no detectable mRNA in liver") sent to immunohistochemistry with a cell type the question never named | D169, D215, D220, D230 |
| A requirement dropped | D103 |
| Per-location antibody reliability read as the protein's overall reliability | D88 |

Four composed queries differ in clauses but return the reference's genes
(D71, D96, D107, D209).
