# ASO native study conversation

ASO coordinates the existing HPA agents and directly exposed table tools. Gemini 3.8 Flash with low reasoning remains the evaluation model. The runtime consumes imported raw files; it adds no benchmark-specific datasets, classifications or code-generation path.

## Conversation

The original goal and all native assistant/tool exchanges remain in order for the entire study. Calls retain their IDs and provider signatures. There is no automatic compaction, replacement checkpoint or separate 32,768-byte context limit. Individual observation deliveries are paginated at 8 KiB. Receipts have a 2 KiB row budget: tables with at most 40 rows can be shown whole if they fit; larger tables show two sample rows. Bulk receipts prioritize measurement columns over source-row bookkeeping. These limits control previews, not the stored data or conversation length. Unshown text has an explicit retrieval cursor.

Every result receipt preserves the producing arguments and source provenance. New measurement/calculation columns appear first. A filtered schema request includes only matching headers and samples; it does not repeat the full raw master header. Investigator receives the source catalog for measurement discovery. ASO can request the catalog through its existing datasets tool when needed; it is not automatically repeated in every study. Source observations are archived for pagination/search; model decisions are retained as native messages rather than duplicated into the evidence archive.

The current remaining plan and running jobs are rendered once at the end of the request. Prior copies of that changing control frame are not accumulated. Actual plan changes remain in their native tool exchanges, and asynchronously delivered source evidence is retained independently of the current frame. Every unfinished result is visible so a pending first item does not hide independent work.

A provider context-limit error remains an explicit failure. This change does not silently drop history to fit, infer a token limit from bytes, or claim to support an indefinitely long study. Context size and actual provider tokens are measured in every request manifest.

## Tools and agents

Calculation operations and specialist agents have their native schemas available from the first turn. A plan and independent searches can start in the same response. The help/run/delegate indirection is no longer exposed. Independent native calls execute up to the existing ASO parallel limit; plan changes and finish are ordered barriers. skip alongside an inspection still waits for a running agent instead of polling the model again. Agents run asynchronously through the shared orchestrator. ASO itself is excluded from its tool list.

Deep Research handles descriptive gene-set questions throughout a study, including later eligibility questions. Investigator handles source discovery and bulk measurements as well as its existing focused gene investigations. ASO passes complete measurement questions, then uses returned tables for cohort combinations, ranking and figures. All existing direct table tools remain callable for additional analysis and reported source gaps. The existing agents may use online HPA search when raw exports lack a search category; the returned artifact records that provenance.

## Additive bulk Investigator

The existing `investigator_hpa({ gene, question, mode })` path and response are preserved. Supplying the optional `genes` array selects bulk investigation:

```js
investigator_hpa({ genes: ['ALB', 'TF'], question: 'Return liver and kidney consensus nTPM and their ratio.', mode: 'offline' })
```

Within ASO, `from: 'a1'` binds a saved cohort to that array in the runtime. ASO does not copy the list or choose a gene column. Investigator receives its question, the assigned plan result when `node` is present, and existing input column names. The rest of the study stays in ASO's context. Full input rows stay outside model messages. The assigned result prevents a shortened question from discarding the statistics or comparisons that the plan asks Investigator to complete.

Investigator chooses source tables, matching columns, value columns, filters and explicit reducers through `apply_bulk`. Several scalar lookups, registered compute expressions and requested result ranking can produce one combined table. Rows mode returns raw source rows or the requested top source entities per input. Separate results can return statistics and entity rows together. `open_result` reads a bounded page of any saved result, so unseen rows do not require another source lookup. No generated Python or SQL is executed.

The source reader resolves the list against one master snapshot, deduplicates physical gene reads, and uses the existing raw-file readers and in-memory indexes. Each source is reused across lookups within the investigation. Concurrent agents share a pending index build for the same file identity; newline and field boundaries use native buffer searches. No prepared answer table or new import-time transformation is required. The current bulk reader supports local gene-keyed tables; it explicitly reports sources that only support whole-file streaming.

Results retain all supplied entries in input order unless sorting or a top result was explicitly requested. Sorting without a top limit keeps undefined values as unranked rows. Unresolved names and existing input measurements remain in the results. Repeated scalar measurements require an explicit reduction. Zero, missing source cells, absent source rows and unresolved inputs are recorded separately; undefined divisions remain null. Complete result tables, lookup definitions, coverage, calculations and unanswered requirements are saved as linked artifacts. Only bounded previews enter either agent's context. A bulk result with unanswered requirements reports `partial`; plan execution status alone does not establish scientific completeness.

Investigator returns cross-cohort counting, correlations and figures to ASO through `remaining_for_aso`. A union list does not carry cohort membership implicitly. A partial bulk result supplies supporting evidence but cannot automatically finish its plan item. If an investigation stops after successful lookups, those tables are returned with the explicit error and unfinished assignment rather than discarded. No source lookup is treated as proof that the full scientific question has been answered.

ASO's existing aggregate operation also accepts `group_by_columns` for several grouping columns. The original single-column `group_by` remains supported. Multiple group labels stay in separate columns, so a grouped chart does not need concatenation, splitting or repeated per-cohort aggregation.

The native pivot operation preserves all input row and column labels. Requested subsets are selected explicitly before reshaping; pivot exposes no additional ranking/truncation controls. Chart axes name exact source columns, and missing values require explicit omission. Finish asks for concise, cited interpretation and uses saved tables for numerical results.

## Plan and completion

Plans describe short, revisable result steps using kind: gene_set, table, interpretation, summary, or a chart type such as heatmap, bar or scatter. Each figure has its own step; there is no conditional extra chart-type field. There are no upfront low-level tool or column guesses. Gene-set and interpretation steps require direct results from Deep Research and Investigator respectively; a specialist buried in a derived table's ancestry cannot complete a later specialist question. Table steps require saved data, and figures require rendered images of the stated type. An old asynchronous result cannot complete a replacement plan item.

Finish waits for pending or unseen agent results. Report tables insert exact stored values. Numerical citation checks and incomplete outcomes remain; they do not establish scientific correctness. Independent raw-file verification is required for evaluation claims.

## Evaluation

Requests, responses, observations, figures, usage and source hashes are saved in each isolated run. The manual harness uses a read-only local database transaction and intercepts study/accounting writes into memory and the selected local output directory.

```bash
node scripts/manual/compare_study_context.js --case kinase --effort low --out /tmp/aso-kinase
node scripts/manual/compare_study_context.js --goal-file /path/to/study.txt --effort low --out /tmp/aso-advanced
node scripts/manual/compare_study_context.js --genes-file /path/to/genes.json --goal-file /path/to/question.txt --effort low --out /tmp/investigator-bulk
```

No database migration is needed. The earlier context-budget migration is withdrawn. Historical traces remain unchanged. Frontend, deployment and service state are outside this local change.
