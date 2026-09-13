# Difficulty rubric

All 30 questions use the same rubric, applied to the question and its
reference before any run. It is a benchmark-defined measure of how much of
the release the investigator has to navigate, not a validated universal scale.

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Points | One gene named in the question | A list of a few to twenty symbols | A long list, or points given as Ensembl ids |
| Source | The obvious file for the words used (consensus nTPM) | One file among several alike (GTEx beside HPA and consensus; a per-cancer summary beside the cell line table; a pair file read in both directions) | A file whose vocabulary is not the question's (mass spectrometry intensity, proximity extension assay fold change, immunohistochemistry level, deep visual proteomics) |
| Context | One value per point | A named context: a tissue, a cell type, a cell line, a cohort | A context narrowed by a second attribute: a cell type within a tissue's clusters, a donor, a control group, a cohort label with its source, a sample type with its publication |
| Handling | Plain | Spelling or format to resolve: lower-case names, synonyms, ids, a value that is a list | A negative (nothing in the release holds the value) or a rejection (two fields asked at once) |

Easy: total 0–2 with no dimension scoring 2. Hard: total 4 or more with a
dimension scoring 2. All other cases are Medium. The resulting split is
**12 Easy, 9 Medium and 9 Hard**. Each question records its four scores in
`questions.json`.
