# Investigator benchmark

The investigator reads the atlas's release files for a study: a question
about a gene or a list of genes in, the rows that answer it out, from one
file, with the mapping it made (field, file, column). This benchmark asks it
30 such questions whose answer is known row for row, and checks that every
expected row comes back from the expected file.

## The questions

30 questions over 19 release files: consensus, HPA, GTEx and FANTOM tissue
transcriptomics, brain regions (human and mouse), single-cell types and
tissue clusters, immune cells and per-donor immune samples, cell lines and
their per-cancer summary, cancer staining, TCGA prognostics, CPTAC
proteomics, normal-tissue immunohistochemistry, subcellular annotation,
consensus interactions, plasma concentrations by mass spectrometry and by
immunoassay, proximity extension assay disease profiles, tissue mass
spectrometry and deep visual proteomics. Points range from one named gene to
120 Ensembl ids, and include synonyms the files do not use (p53, HER2,
PD-L1, c-Myc). One question asks for a value no file holds; one asks for two
fields at once, which the investigator is meant to refuse.

By the rubric in [questions/difficulty.md](questions/difficulty.md): 12 Easy,
9 Medium, 9 Hard. Questions and their points are in
[questions/questions.json](questions/questions.json).

## The references

[references/answers.json](references/answers.json) is built by
[execution/build_references.py](execution/build_references.py) straight from
the release files: for each question, the rows of the named file for the
question's points in the question's context, with the value column. The
negative and the rejection question carry no rows and say why.

## Scoring

A question is correct when every expected row appears in a returned table
(the point, its context, its value) and the table's source file is the
reference's. The negative question is correct when the agent reports that no
table holds the value; the rejection question when it refuses. Nothing is
graded by a model or by hand; [execution/README.md](execution/README.md)
describes the runner.

## Results

Gemini 3.8 Flash at low reasoning effort, offline against release 25.1
([results/README.md](results/README.md)):

| | Questions | Correct |
| --- | --- | --- |
| Easy | 12 | 12 |
| Medium | 9 | 9 |
| Hard | 9 | 8 |
| All | 30 | 29 |

The one miss is the two-field question: the investigator fetched both fields
instead of refusing. 189,425 tokens in total, a median of 5,832 per question,
$0.16 at list price; 5 minutes of wall clock at four questions in parallel.

## Folder

| Path | Content |
| --- | --- |
| questions/ | questions.json, difficulty.md |
| references/ | answers.json: expected rows per question, built from the release files |
| execution/ | README.md: the runner and the scoring; build_references.py |
| results/ | one folder per recorded run |
