# ASO rollback checkpoint — 2026-09-06

This checkpoint preserves the current native-conversation ASO and additive bulk Investigator implementation before further harness work. It is a reproducible rollback baseline, not a claim that generated scientific reports are fully validated.

The evaluation model is Gemini 3.8 Flash with low reasoning. Existing single-gene Investigator, Deep Research and direct study tools remain available. Measurements are read from imported raw HPA files; no study-specific answer tables or generated analysis-code executor were added.

The latest original kinase study completed in 23.093 seconds with 113,016 total tokens across all agents, six ASO model turns and eight ASO tool requests. Its 16 independent numerical/output checks passed. A report-citation retry and a clipped chart-axis label remain.

A fresh chromosome-Y immune-expression study completed in 36.142 seconds with 253,864 total tokens, 14 ASO turns and 16 ASO tool requests. All 45 genes, 855 raw measurements, 180 numerical summaries, ranking and chart values were correct. The final table omitted tied maximum cell categories for 30 all-zero genes, and the report inferred an unperformed experiment from an absent localization record. These are unresolved output-completeness and grounding failures.

The five-question bulk comparison reduced ASO tool requests from 149 to 79 and all-agent total tokens from 1,388,970 to 1,219,749. Its strict output checks passed 307 of 308; one heatmap applied an unrequested numerical transformation. This does not establish repeated-run reliability.

The read-only evaluation harness saves exact requests, responses, usage, source hashes and output artifacts. All-agent accounting is authoritative: the current ASO result.tokens field still includes only the main agent. Existing tests cover the additive bulk route and preserved single-gene behavior; full scientific validation remains separate.

No database migration, deployment or service action accompanies this checkpoint. The retired context-budget SQL file is deliberately a no-op.
