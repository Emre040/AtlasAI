# Difficulty rubric

All 20 questions use the same rubric, applied to the question and the page
that answers it before any run. It is a benchmark-defined measure of how far
into proteinatlas.org an answer sits, not a validated universal scale.

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Hops | An About page linked from the home page (releases, licence, history, help) | A section overview page (single cell, blood, brain, cancer) | A method or help subpage two or more links deep |
| Facts | One fact | Two or three facts | Four or more facts |
| Precision | A name or a word | A number or a date | A rule or definition that must be read exactly (a threshold, a comparison, a parameter) |

Easy: total 0–2 with no dimension scoring 2. Hard: total 4 or more with a
dimension scoring 2. All other cases are Medium. The resulting split is
**5 Easy, 10 Medium and 5 Hard**. Each question records its three scores in
`questions.json`.

Questions avoid the counts on which the site contradicts itself (the number
of immunohistochemistry tissues, of consensus RNA tissues, of brain regions,
the Brain Atlas launch year, the number of single-cell datasets).
