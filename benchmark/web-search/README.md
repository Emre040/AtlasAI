# Web-search benchmark

AtlasAI answers questions about the atlas itself with a reader that browses
proteinatlas.org by the site's own links and quotes what it cites, every quote
checked against the page by code. This benchmark asks 20 documentation
questions with known answers to that reader and to the same model given open
web tools (a search engine and a page opener), and counts the facts each
answer contains.

## The questions

20 questions about the Human Protein Atlas as a resource: its release and
what it added, its licence and citations, its funding and history, the
detection cut-off and the specificity definitions, the consensus rule for
nTPM, antibody validation methods and reliability scores, the single cell,
blood and cancer sections' coverage, the prognostic gene definition, the
survival cohort, programmatic access, and why raw RNA-seq is withheld. Each
asks for one to five facts. By the rubric in
[questions/difficulty.md](questions/difficulty.md): 5 Easy, 10 Medium,
5 Hard. Questions are in [questions/questions.json](questions/questions.json).

## The references

[references/answers.json](references/answers.json) holds, for each question,
the facts an answer must contain, each with the spellings accepted, the page
they were read from, a verbatim quote from it, and the date it was read
(13 September 2026). Questions avoid the counts on which the site
contradicts itself.

## Scoring

A question is correct when every reference fact is present in the answer,
compared case-insensitively with thousands separators removed. The score
also records whether the answer cites proteinatlas.org, and the tokens, time
and list-price cost. Nothing is graded by a model or by hand;
[execution/README.md](execution/README.md) describes both arms and the
scorer.

## Results

Gemini 3.8 Flash, 13–14 September 2026
([results/README.md](results/README.md)):

| Arm | Correct | Facts | Tokens in | Cost | Median seconds |
| --- | --- | --- | --- | --- | --- |
| reader (AtlasAI) | 20 / 20 | 50 / 50 | 312,488 | $0.25 | 6 |
| open web tools | 20 / 20 | 50 / 50 | 1,819,594 | $1.44 | 14 |

Both arms cite proteinatlas.org in every answer. The reader reads 2.8 pages
per question and returns each fact with a quote verified against the page;
the open-web arm reads whatever the search engine returns and verifies
nothing.

## Folder

| Path | Content |
| --- | --- |
| questions/ | questions.json, difficulty.md |
| references/ | answers.json: facts, accepted spellings, source page, quote, date read |
| execution/ | README.md: the two arms and how to run them; score.py |
| results/ | reader/ and web/, one folder per model under runs/ |
