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

Candidate4 integrates the following trace-supported fixes: preserve the exact original request alongside delegated work; state whether inherited measurements exist; accept logical-object run arguments through the existing Gemini transport; include dictionary inference in canonical token totals; scope category definitions to their actual source/column; and avoid empty-desk inference solely because tool schemas loaded while a specialist runs. It also makes default explicit opens return all columns, projects actual ranking fields in receipts, and retains every tied maximum in offline inclusion/exclusion queries. Missing source values do not become measured zero. These are general operation and source semantics, not question-specific answer data.

The combined suite passes 287 tests. A new frozen 27-attempt batch has started: all nine original questions, each three repetitions. It includes the first exposure of the three original hard questions; their results will be reported separately from the 18 development attempts. Additional sealed challenges remain untouched. All net token savings, hard-task outcomes and report reliability claims remain pending live grading. The evaluated candidate3 runtime is retained locally in commit `d3d6715a6fd0dbec30394701605b1d80da3a3d2b`; candidate4 is not deployed or pushed.


Candidate4 was stopped after its sixth attempt because a repeated assignment/completion defect caused excessive retries. All six attempts are preserved; the remaining 21 planned attempts were not executed. The partial batch used 2,025,999 tokens (1,980,998 input and 45,001 output), 166 model calls and $1.337946. Development results were 2/4 complete; original hard results were 0/2 complete. These unequal subsets must not be compared with an 18-attempt total. Core hard-study values were correct, but requested output fields/counts and report evidence remained incomplete.

Eleven of twelve bulk finishes in this prefix reported parent-wide work outside their assigned question. One correct cancer analysis then used 793,085 tokens and five Investigator invocations before returning incomplete. The original request remains useful for source constraints, but its broader work list was incorrectly treated as the specialist assignment. Candidate4 is an experimental regression, not a stable replacement for candidate3. The original third hard question and all three additional sealed challenges remain unexposed.

The controlled stop retained the active sixth result and reserved the seventh output directory to trigger the existing fresh-output guard before any seventh inference; its marker is explicitly not an attempt. The frozen runtime and manifest were not modified while tests ran. A native assignment-scoped completion field, independent row/coverage citation validation, and faithful scientific-notation screening are being prepared separately. No completion gate is being waived merely because a report or plot exists.

## Candidate5 preparation

Candidate4 is retained in local commit `4153636e7ef57ba0cac807cbd49f5c1056eb16ed`. Candidate5 repairs its assignment boundary: the exact original request is labeled as context, the delegated question is authoritative, and the native `unfinished_requirements` field maps to the existing public completion contract. Separate fixes validate row and coverage citations independently and parse displayed scientific notation as its complete quantity. No scientific completion predicate is waived by these changes.

Two additive operations address observed capability gaps without embedding study answers. `classify` uses ordered existing predicates, explicit scalar values and a required default, retaining every row. The same operation is available to ASO and bulk Investigator. `reduce_result` composes registered aggregates within each supplied identity over saved raw rows, retaining intermediate tables and explicit count provenance. `aggregate.group_domains` can materialize every explicitly requested category combination; absent counts are zero while undefined measurement statistics remain null. Mixed scalar values preserve their JSON types through the Gemini tool schema.

Exact source descriptions, definitions and schema sample reads are retained as separately citable artifacts. Samples describe the displayed records, not all members of a cohort. The numerical report checker still does not verify arbitrary scientific entailment. The next live evaluation must assess both report grounding and whether these context changes reduce repeated work; passing scripted contract tests is not live-model success.

The recorder now verifies the fixed Gemini 3.8 Flash model and effective low reasoning effort on every agent inference, recording whether low was explicit or inherited from model configuration. The serial runner supports a deliberate stop between attempts, preserving the active result and distinguishing unrun cases from failures. The final runtime will be frozen before the nine original questions are each run three times.

The final candidate5 deterministic suite passes 365 tests. Independent synthetic audits confirm nested weighting, typed grouping, raw retention, count lineage and partial-stage repair. Failed source snapshots are preserved with their originating execution status; they remain citable but cannot close unfinished work through a projection. The recorder persists failed requests with sanitized error metadata and labels unknown usage explicitly, instead of treating it as zero tokens. A generic two-pair correlation correction returns the defined coefficient while retaining the appropriate Pearson versus Spearman inference limits; the frozen study expected values remain unchanged.

Candidate5 live results remain pending. Hard1 and hard2 are previously exposed regression cases; hard3 and the additional sealed suite retain their first-exposure status until inference starts. No candidate5 publication-readiness, token-reduction or stability claim follows from the unit suite.
