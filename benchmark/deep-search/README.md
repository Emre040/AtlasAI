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

No question names an atlas category by its label. The wording is a
scientist's: "liver-specific", "absent from kidney", "expressed in every
tissue", "elevated in Kupffer cells relative to other cell types", "validated
markers of longer survival". The agent sees each category's definition in the
schema it plans over; the question tests whether it reads them. Every
question asks for something the atlas search can express, and asks for brain
regions and cell types by name, never for the search's aggregate tissues.

By the rubric in [questions/difficulty.md](questions/difficulty.md): 53 Easy,
146 Medium, 37 Hard. Every question's scores and rationale are in
[questions/questions.json](questions/questions.json); the index is
[questions/README.md](questions/README.md).

## The references

[references/queries.json](references/queries.json) holds each question's
reference filters (field, path, operator), the query they compose to, and a
check recorded before any run: the query executed on the local copy of
release 25.1 and fetched from proteinatlas.org, with both gene counts. All 236
references return the same, non-empty gene set both ways (median 21 genes).

## Scoring

| Measure | Meaning |
| --- | --- |
| Same genes | The composed query returns the reference's gene set on the atlas. An equivalent query written differently passes. |
| Same clauses | The composed query has exactly the reference's filters, in any order. |
| Count verified | The row count the agent reports from the local release equals the atlas's count for its own query. |

Same genes is the headline. Nothing is graded by a model or by hand;
[execution/README.md](execution/README.md) describes the runner and the three
modes.

## Results

Recorded runs live under `results/<label>/` with one JSON per question (the
query, the trail, the plan, rows, tokens, seconds, every step), a
`results.tsv` and a `summary.json`. No full run is recorded yet.

## Folder

| Path | Content |
| --- | --- |
| questions/ | questions.json, difficulty.md, README.md |
| references/ | queries.json: reference filters, composed query, verification |
| execution/ | README.md: the runner, its modes, the scoring |
| results/ | one folder per recorded run |
