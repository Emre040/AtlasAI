# Reference notes

`answers.json` contains the reference for every Q1–Q45 item. Numeric reference
values were retained from the frozen sources; documentation answers were
transcribed directly from the reference captured on 2026-09-09. `checks.json`
preserves the independent SQL checks, with question labels updated.

## Q21: thyroid labels

The original truth generator used substring membership: `thyroid gland:` also
matched `parathyroid gland:`. Its thyroid count 41 combines 12 thyroid and 29
parathyroid genes. Blood/FDA shares 4/41 and 5/41 likewise combine both; the
thyroid-only values are 1/12 and 2/12. This also changes the ranking.
The frozen numeric reference is preserved, but the existing grading accepts
the supported thyroid-only count 12. The saved SQL Flash Q21 trace, tool call
13, independently groups the exact label before the colon.

The reference also mixes 51 consensus tissues with grouped labels such as
brain, intestine and lymphoid tissue, and numbered tissue labels. A literal
zero from incompatible labels is not biological absence. A stated, supported
remapping is assessed on its evidence; coverage and all requested analyses
still have to be correct.

## Negative and paired tasks

Q10/Q11 share an empty-cohort family. Q37/Q38, Q39/Q40 and Q41/Q42 are paired
wordings of shared tasks, evaluated in separate fresh conversations. They
must not be described as independent task families or interactive follow-ups.
Q43–Q45 require both the feasible source analyses and recognition of the
unsupported conclusion. Correct source data do not rescue an invalid central
claim about absence, absolute molecule counts or treatment benefit.
