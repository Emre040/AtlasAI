# Results

One folder per recorded run. Each holds `runs/<id>.json` (the tables
returned with their source file, columns, rows and mapping, the note, tokens,
calls, turns, seconds, every step, and the score), `results.tsv`,
`summary.json` and `run.json` (the settings). Scores are mechanical: see
[../execution/README.md](../execution/README.md).

## flash-low

Gemini 3.8 Flash at low reasoning effort, offline against release 25.1, four
questions at a time, 13 September 2026.

| | Questions | Correct |
| --- | --- | --- |
| Easy | 12 | 12 |
| Medium | 9 | 9 |
| Hard | 9 | 8 |
| All | 30 | 29 |

Every expected row of the 28 row questions came back from the reference
file, including the 120 Ensembl ids, the 123 interaction partners read in
both directions of the pair file, the four synonyms resolved to their
symbols, and the per-donor and per-publication rows. The negative question
(protein half-life) ended with the agent reporting that its searches found
nothing. The miss is I28, the two-field question: the investigator fetched
both fields, one of them empty, instead of refusing the question as several
fields.

Tokens: 189,425 in total (182,997 in, 6,428 out), a median of 5,832 per
question; $0.16 at list price, $0.005 per question. The run took 5 minutes of
wall clock; the median question took 32 seconds.
