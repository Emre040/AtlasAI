# Deep-search benchmark

The search agent turns a question in plain language into one Human Protein
Atlas search query. This benchmark asks it 236 questions whose correct query is
known, and scores the query it composes against that reference on the same
atlas release: same genes returned, and, more strictly, the same filters.

## The questions

236 questions over 16 search fields: protein classes and subclasses, tissue,
brain-region, single-cell, immune-cell and lineage categories, cancer cohorts,
secretome annotation, subcellular location with reliability and role,
prognostic associations, chromosome, evidence level, brain and blood
expression clusters, and immunohistochemical staining by tissue and cell
type. They range from one filter to seven, with exclusions, several values on
one level, categories with no entity named, and three-level paths.

No question spells out an atlas category label. The wording is a
scientist's: "liver-specific", "no detectable mRNA in kidney", "expressed in
every tissue", "enhanced in Kupffer cells (single-cell)", "validated markers
of longer survival". The agent sees each category's definition in the schema
it plans over; the question tests whether it reads them. Every question asks
for something the atlas search can express, and asks for brain regions and
cell types by name, never for the search's aggregate tissues.

By the rubric in [questions/difficulty.md](questions/difficulty.md): 51 Easy,
147 Medium, 38 Hard. Every question's scores and rationale are in
[questions/questions.json](questions/questions.json); the index is
[questions/README.md](questions/README.md).

## The references

[references/queries.json](references/queries.json) holds each question's
reference filters (field, path, operator), the query they compose to, and a
check recorded before any run: the query executed on release 25.1 and fetched from proteinatlas.org, with both gene counts. All 236
references return the same, non-empty gene set both ways (median 21 genes).

## Scoring

| Measure | Meaning |
| --- | --- |
| Same genes | The composed query returns the reference's gene set on the atlas. An equivalent query written differently passes. |
| Same clauses | The composed query has exactly the reference's filters, in any order. |
| Count verified | The row count the agent reports from release 25.1 equals the atlas's count for its own query. |

Same genes is the headline. Nothing is graded by a model or by hand;
[execution/README.md](execution/README.md) describes the runner and the three
modes.

## Results

Gemini 3.8 Flash at low reasoning effort against release 25.1
([results/README.md](results/README.md)):

| | Questions | Same genes | Same clauses | Count verified |
| --- | --- | --- | --- | --- |
| Easy | 51 | 49 | 49 | 50 |
| Medium | 147 | 140 | 137 | 143 |
| Hard | 38 | 31 | 30 | 38 |
| All | 236 | 220 | 216 | 231 |

232 of 236 questions produced a query. 1,370,500 tokens in total, a median
of 5,395 per question, $1.48 at list price; 15 minutes of wall clock at ten
questions in parallel. Each run folder holds one JSON per question (the
query, the trail, the plan, rows, tokens, seconds, every step, the score), a
`results.tsv` and a `summary.json`.

## Folder

| Path | Content |
| --- | --- |
| questions/ | questions.json, difficulty.md, README.md |
| references/ | queries.json: reference filters, composed query, verification |
| execution/ | README.md: the runner, its modes, the scoring |
| results/ | one folder per recorded run |
