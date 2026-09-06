# ASO harness evaluation, 6 September 2026

The backend rollback checkpoint is `96dbafd2f527172ca60360eaa0cbe42c772cfff4`, pushed to `origin/main`. Subsequent changes are local on `work/aso-harness-reliability-2026-09-06`. This is an ongoing engineering evaluation, not a scientific validation or publication-readiness claim.

## Repeated comparison

The checkpoint and three candidates each ran the same six development questions three times, in a frozen randomized order, using Gemini 3.8 Flash with low reasoning. Independent raw-file calculations and an explicit output/grounding rubric were frozen before inference. All attempts were retained; application completion is separate from a passing answer. Review was evaluator-assisted and not blinded.

| Measure across 18 attempts | Checkpoint | Candidate1 | Candidate2 | Candidate3 |
| --- | ---: | ---: | ---: | ---: |
| Total tokens, all agents | 3,440,132 | 2,209,941 | 1,596,091 | 1,569,007 |
| Model calls, all agents | 251 | 236 | 199 | 202 |
| Recorded inference cost, USD | 1.911240 | 1.409811 | 1.024647 | 0.983095 |
| Strict complete passes | 2 | 6 | 9 | 13 |
| Correct recorded numerical values | 15 | 18 | 18 | 18 |
| Correct data and order | 15 | 15 | 18 | 18 |
| Grounded reports | 3 | 7 | 9 | 14 |
| Original figures meeting visual standard | 6 of 21 | 6 of 21 | 21 of 21 | 20 of 21 |

Candidate1 total tokens fell 35.8%. Candidate1 fixed premature rounding in the cancer-fraction calculations. Remaining failures included incorrect ordering of tied results, obscured labels, and unsupported narrative claims despite correct saved values. Timing was descriptive: candidate1 was slower in five of six case medians. Runs were not interleaved under controlled host load, so no latency improvement is claimed.

Checkpoint API responses omitted 893,540 specialist tokens. The comparison uses the authoritative all-agent recorder. Candidate1 API totals matched the independent recorder in all 18 runs. Cached input is a subset of input, not an additional token category.

## Candidate2 and the next revision

Candidate2 completed all 18 development attempts and was graded against the unchanged oracle. Total tokens fell 53.6% from the checkpoint and 27.8% from candidate1. The six known kinase/chromosome-Y regression repeats completed on this frozen runtime: 6/6 exact data and figures, 4/6 grounded reports, 576,581 total tokens across 90 model calls ($0.374164). The kinase repeats used 54,751, 67,807 and 139,258 tokens; the wide range exposes unnecessary extra work despite correct results. Report claims remain the limiting failure: only 9/18 runs pass completely, including examples of a reversed regional ranking and unsupported methodological explanations. Its final pre-freeze unit suite passed 199 tests. Registered operation graphs allow dependent table calculations in one ASO call; intermediate artifacts remain available. Composite joins and secondary sorting address general table operations. Axis domains and label placement improve rendered charts. Replaying the 21 previous chart specifications produced 21 legible figures; this separate replay does not change the original live grades or fix constraints absent from those specifications.

Ordinary row reads now return exact selected data and lineage without repeating the specialist narrative. Full provenance remains explicitly accessible. Bulk receipts include row identities with new measurement fields. Finished table operations no longer lose numerical precision or complete empty-table schemas. Partial row execution cannot satisfy a plan by passing through a derived table; completed source evidence remains usable when a specialist assignment still has calculations for ASO to finish.

Single Investigator, bulk Investigator, Deep Research and the existing registered data tools remain available. Productive specialist repairs are governed by explicit caller controls and repeated-state detection, rather than private retry/turn ceilings. Raw imported HPA files remain the measurement source. There is no generated Python/SQL executor, precomputed study-answer source, hidden reviewer agent, model switch, deployment or service restart.

The separate scripted actual-module audit passed 37 data/tool checks, including complete 1/7/600/1023-input bulk processing, unsorted raw records, missing versus zero, and exact reconstruction of oversized Unicode cells. These checks use scripted tool decisions and are not live-model reliability evidence. Three crafted unsupported prose claims still bypass the numeric-only report checker. Reference and numeric-membership validation do not prove that a free scientific sentence follows from its evidence.

## Reproducibility and remaining work

Local evidence is under `/home/green/Misc/AtlasAI/aso-reliability-2026-09-06/`. Each live attempt archives runtime source hashes, raw-source hashes, exact model requests and responses, events, artifacts, reports, figures and all-agent usage. Frozen suite/oracle files are excluded from model inputs. Tests and benchmarks write isolated local workspaces and use read-only database transactions; no benchmark result is a production deployment.

The six development questions cover categorical immunohistochemistry, localization, immune expression, blood assays, cancer fractions, and exact brain-region joins/correlations. Three original hard questions remain untouched by inference at the candidate2 freeze. Original kinase/chromosome-Y regression grading is complete; the next candidate will test all nine original questions three times, retaining the three hard questions as first-exposure evidence. Three additional sealed challenges remain untouched by inference.

Nature Methods readiness also requires a justified novelty claim, fair contemporary baselines and ablations, independent scientific adjudication, documented data/code availability, and clean external reproduction. Hosted-model replay and fresh API reruns have different reproducibility limits. Engineering checks here cannot establish those external requirements by themselves.

## Candidate3 and remaining context defects

Candidate3 passes 238 unit tests and completed the same 18 live attempts. Exact data/order remain correct in all attempts; 13/18 pass the full rubric, up from 9/18. Total tokens are 54.4% below the checkpoint but only 1.7% below candidate2: 1,534,309 input and 34,698 output. Every API total matches the independent all-agent recorder. Output tokens fell 27.8% from candidate2, but repeated input dominates. The 538.644 seconds of summed application time and 568.355 seconds including recorder/process overhead are descriptive, not controlled latency evidence.

The changes retain requested interpretation while allowing exact tables and figures to finish without compulsory prose. Delegated plan-item ownership is visible. Evidence can be attached in finish without a separate bookkeeping call. Unary missing/numeric predicates preserve zero and negative measurements. Logical object arguments preserve literal data while only marked artifact-reference fields resolve dependencies. Actual for_each input ancestry prevents partial work being marked complete. Structured cells cannot silently become `[object Object]` through compute.

Three brain reports still add unsupported methodological explanations; one also reverses a region ranking in prose despite correct saved values. One pancreatic report asserts specific validation methods not established for those records. One blood scatter has correct values, units and literal requested scatter delivery, but no gene identifiers. It fails the frozen stricter visual-identity standard; this is a disclosed borderline interpretation of that standard, not a numerical or renderer failure. A previous candidate2 tick-label concern was reviewer error and was corrected after original-resolution review; original records are retained.

The separate candidate3 scripted audit passes 69 data/tool checks and 13 native transport tests, including 1/7/600/1023-input raw lookup and Unicode paging. Three crafted unsupported-prose probes remain accepted by the numeric-only checker. These scripted decisions do not count as live-model passes.

Trace-supported next fixes are isolated pending integration: preserve the exact original request alongside delegated work; state whether inherited measurements exist; accept logical-object run arguments through the existing Gemini transport; include dictionary inference in canonical token totals; scope category definitions to their actual source/column; and avoid empty-desk inference solely because tool schemas loaded while a specialist runs. They introduce no question-specific answer data. Their net token savings and behavior on hard studies remain to be measured.
