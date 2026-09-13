# Difficulty rubric

All 236 questions use the same rubric, applied to the reference query and the
wording before any run. It is a benchmark-defined measure of how much of the
search schema a question exercises, not a validated universal scale.

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Scope | One filter | Two or three filters | Four or more filters |
| Schema depth | Every filter is one option of its field | A filter needs a second level: a subclass under a class, a category under a tissue, a reliability or role under a location | A three-level path (tissue, cell type, staining level), several values on one level, or a category with no entity named |
| Logic | Inclusions only | One exclusion | An exclusion beside an absence category (the two kinds of "not" must be told apart), or several exclusions |
| Wording | The atlas's own words | A derived or plural form that must be matched to an option (tyrosine kinases, neutrophils, a cluster named without its number) | A category given by its definition, never by its label (at least four-fold higher than in any other tissue; below the detection cut-off) |

Easy: total 0–2 with no dimension scoring 2. Hard: total 6–8. All other
cases are Medium. The resulting split is **51 Easy, 147 Medium and 38 Hard**.
Each question records its four scores and a rationale in `questions.json`.

All four scores follow from the question by fixed rules: scope, schema depth
and logic from the reference filters in `references/queries.json`, wording
from the phrases the text uses. No question spells out a category label
("Tissue enriched"); the wording is a scientist's ("liver-specific", "no
detectable mRNA in kidney", "expressed in a handful of tissues"), using the
atlas's own word where it is the natural one ("enhanced expression in
pancreas"), and the agent must match it to the category whose definition it
sees in the schema.
