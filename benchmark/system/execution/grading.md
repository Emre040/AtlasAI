# Correctness grading

Every answer was read in full against the reference answer and the question
text. Each question carries its verdict and a note naming what matched the
reference and what did not.

| Grade | Requirement |
| --- | --- |
| Correct (`true`) | All substantive requested results are correct and complete under a supported interpretation. |
| Partial (`"PARTIAL"`) | The central analysis is substantially correct, with a bounded error or omission. An independently usable major result must be delivered. |
| Wrong (`false`) | The central task is absent or invalid: a wrong cohort, fabricated measurements, invalid inference, unsupported access refusal or no final answer. |

Scattered facts, isolated counts, plans and caveats do not earn PARTIAL when
the main analysis is missing. Complete source data cannot rescue an invalid
central biological, absolute-quantity or causal conclusion. PARTIAL is reported
separately and has no implicit half-point. All 45 items remain in both arms'
denominators. Access failures do not receive a scoring allowance.

Correct means a complete deliverable: every requested number, table and figure
is delivered and matches. An answer with the right numbers and no figure file is
Partial. A correct empty cohort makes its downstream figures inapplicable.

Q37, Q39 and Q41 permit a targeted clarification, or a clearly declared,
defensible interpretation with correct results. Silent restrictions that
materially change the cohort fail. Clarification is distinguished from a
completed study using `answer_type`; paired prompts are fresh conversations.

Negative questions require the supported empirical work and the justified
limitation. Missingness is not biological absence; relative assays do not supply
absolute molecular calibration; association does not identify treatment effect.
Q21 has a documented reference-label issue in `../references/notes.md`.

Verdicts have the same seven fields: `correct`, `note`, `answer_type`,
`answer_sha256`, `full_answer_read`, `figure_files_delivered`, `evidence_paths`.
Keys use `runs/<model>/Q<number>`. Evidence paths are relative to the verdict
file. `answer_sha256` hashes the raw trace's UTF-8 `final_answer` text. Figure
delivery records actual artifacts, not a promise or a code snippet.
