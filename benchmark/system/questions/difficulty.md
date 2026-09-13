# Difficulty rubric

All 45 questions use the same manual rubric. This classification was applied
after the recorded runs; it does not alter question wording or correctness grades.
It is a benchmark-defined measure of task complexity, not an independently
validated universal difficulty scale. Task type and difficulty are separate.

| Dimension | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Data integration | One evidence source | Combine comparable sources | Reconcile modalities, populations or measurement systems |
| Analysis | Lookup, filter, count, sort | Aggregation, ratios, set comparisons | Statistical testing, graph analysis or matched-sample analysis |
| Dependencies | Direct answer or independent lookups | 2–3 dependent analytical stages | 4 or more dependent analytical stages |
| Interpretation | Explicit definitions and straightforward evidence | Justify a denominator, definition or limitation | Resolve competing interpretations or assess an unsupported inference |

Easy: total 0–2, with no dimension scoring 2. Hard: total 6–8. All other cases
are Medium. The resulting split is **9 Easy, 14 Medium and 22 Hard**.
Each question records its four scores and a rationale in `questions.json`.

A stage is a scientific dependency, not an API call. Assess required subparts
and their dependencies. Several independent simple lookups do not automatically
make a hard study. Figures do not add difficulty by themselves; assess the
calculations and numerical results needed to support them. When a verified
empty cohort makes further analysis inapplicable, do not count that analysis.

Q37, Q39 and Q41 are Medium because a targeted clarification satisfies the
frozen protocol. Their underlying analyses are Hard, recorded separately as
`analysis_difficulty`. A clarification answer is distinguished from a completed
analysis in the verdict's `answer_type` field. Explicit counterparts remain
Hard. Model failures and success rates were not used as the scoring formula.

Documentation, ambiguity and negative-test tags do not change the correctness
rules or denominators. All 45 questions count for both MCP and SQL. No allowance
or extra credit is made for access failures, and PARTIAL is never counted as Correct.
