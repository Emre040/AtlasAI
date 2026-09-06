# ASO harness evaluation, 6 September 2026

The backend rollback checkpoint is `96dbafd2f527172ca60360eaa0cbe42c772cfff4`, pushed to `origin/main`. Subsequent changes are local on `work/aso-harness-reliability-2026-09-06`. This is an ongoing engineering evaluation, not a scientific validation or publication-readiness claim.

## Repeated comparison

The checkpoint and candidate1 each ran the same six development questions three times, in a frozen randomized order, using Gemini 3.8 Flash with low reasoning. Independent raw-file calculations and an explicit output/grounding rubric were frozen before inference. All attempts were retained; application completion is separate from a passing answer. Review was evaluator-assisted and not blinded.

| Measure across 18 attempts | Checkpoint | Candidate1 | Candidate2 |
| --- | ---: | ---: | ---: |
| Total tokens, all agents | 3,440,132 | 2,209,941 | 1,596,091 |
| Model calls, all agents | 251 | 236 | 199 |
| Recorded inference cost, USD | 1.911240 | 1.409811 | 1.024647 |
| Fully correct runs | 2 | 6 | 9 |
| Correct recorded numerical values | 15 | 18 | 18 |
| Correct data and order | 15 | 15 | 18 |
| Grounded reports | 3 | 7 | 9 |
| Legible original figures | 6 of 21 | 6 of 21 | 21 of 21 |

Total tokens fell 35.8%. Candidate1 fixed premature rounding in the cancer-fraction calculations. Remaining failures included incorrect ordering of tied results, obscured labels, and unsupported narrative claims despite correct saved values. Timing was descriptive: candidate1 was slower in five of six case medians. Runs were not interleaved under controlled host load, so no latency improvement is claimed.

Checkpoint API responses omitted 893,540 specialist tokens. The comparison uses the authoritative all-agent recorder. Candidate1 API totals matched the independent recorder in all 18 runs. Cached input is a subset of input, not an additional token category.

## Candidate2 and the next revision

Candidate2 completed all 18 development attempts and was graded against the unchanged oracle. Total tokens fell 53.6% from the checkpoint and 27.8% from candidate1. The six known kinase/chromosome-Y regression repeats are now running on this same frozen runtime. Report claims remain the limiting failure: only 9/18 runs pass completely, including examples of a reversed regional ranking and unsupported methodological explanations. Its final pre-freeze unit suite passed 199 tests. Registered operation graphs allow dependent table calculations in one ASO call; intermediate artifacts remain available. Composite joins and secondary sorting address general table operations. Axis domains and label placement improve rendered charts. Replaying the 21 previous chart specifications produced 21 legible figures; this separate replay does not change the original live grades or fix constraints absent from those specifications.

Ordinary row reads now return exact selected data and lineage without repeating the specialist narrative. Full provenance remains explicitly accessible. Bulk receipts include row identities with new measurement fields. Finished table operations no longer lose numerical precision or complete empty-table schemas. Partial row execution cannot satisfy a plan by passing through a derived table; completed source evidence remains usable when a specialist assignment still has calculations for ASO to finish.

Single Investigator, bulk Investigator, Deep Research and the existing registered data tools remain available. Productive specialist repairs are governed by explicit caller controls and repeated-state detection, rather than private retry/turn ceilings. Raw imported HPA files remain the measurement source. There is no generated Python/SQL executor, precomputed study-answer source, hidden reviewer agent, model switch, deployment or service restart.

The separate scripted actual-module audit passed 37 data/tool checks, including complete 1/7/600/1023-input bulk processing, unsorted raw records, missing versus zero, and exact reconstruction of oversized Unicode cells. These checks use scripted tool decisions and are not live-model reliability evidence. Three crafted unsupported prose claims still bypass the numeric-only report checker. Reference and numeric-membership validation do not prove that a free scientific sentence follows from its evidence.

## Reproducibility and remaining work

Local evidence is under `/home/green/Misc/AtlasAI/aso-reliability-2026-09-06/`. Each live attempt archives runtime source hashes, raw-source hashes, exact model requests and responses, events, artifacts, reports, figures and all-agent usage. Frozen suite/oracle files are excluded from model inputs. Tests and benchmarks write isolated local workspaces and use read-only database transactions; no benchmark result is a production deployment.

The six development questions cover categorical immunohistochemistry, localization, immune expression, blood assays, cancer fractions, and exact brain-region joins/correlations. Three original hard questions remain untouched by inference at the candidate2 freeze. Original kinase/chromosome-Y regression grading is underway; repeated hard/unseen studies remain to be run after development reliability improves.

Nature Methods readiness also requires a justified novelty claim, fair contemporary baselines and ablations, independent scientific adjudication, documented data/code availability, and clean external reproduction. Hosted-model replay and fresh API reruns have different reproducibility limits. Engineering checks here cannot establish those external requirements by themselves.

The next isolated proposal removes compulsory narrative when exact tables/figures already answer the request, retains requested interpretation, exposes ownership of delegated plan items, adds explicit missing/numeric predicates, and allows evidence to be attached at finish without separate bookkeeping calls. Its combined 221-test suite passes; it has not yet established live improvements. A reviewer initially misread one candidate2 chart tick label, then corrected that grade after original-resolution independent review. Prior grades are preserved; evaluator error is not treated as a renderer failure.
