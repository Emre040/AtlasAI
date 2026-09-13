# Benchmark results

All 45 questions count for every model and arm. Cells below are **Correct / Partial / Wrong**; accuracy counts only Correct. Correct means a complete deliverable: every requested number, table and figure is delivered and matches the reference. An answer with the right numbers and no figure file is Partial. MCP and SQL delivered no figure file for any question, so their Correct cells are among the eleven questions that ask for no figure.

| Arm | Model | Easy (9) | Medium (14) | Hard (22) | All (45) | Accuracy |
| --- | --- | --- | --- | --- | --- | --- |
| MCP | Gemini 3.8 Flash | 1 / 1 / 7 | 1 / 0 / 13 | 0 / 0 / 22 | 2 / 1 / 42 | 4.4% |
| MCP | GPT-OSS 120B | 1 / 1 / 7 | 0 / 0 / 14 | 0 / 0 / 22 | 1 / 1 / 43 | 2.2% |
| MCP | Qwen 3.8 27B | 0 / 1 / 8 | 0 / 0 / 14 | 0 / 0 / 22 | 0 / 1 / 44 | 0.0% |
| MCP | DeepSeek V4 Flash | 1 / 1 / 7 | 0 / 0 / 14 | 0 / 0 / 22 | 1 / 1 / 43 | 2.2% |
| MCP | DeepSeek Flash (low effort) | 1 / 1 / 7 | 0 / 0 / 14 | 0 / 0 / 22 | 1 / 1 / 43 | 2.2% |
| MCP | GPT-5.6 Luna | 1 / 1 / 7 | 0 / 0 / 14 | 0 / 0 / 22 | 1 / 1 / 43 | 2.2% |
| MCP | GPT-5.6 Terra | 1 / 1 / 7 | 0 / 0 / 14 | 0 / 0 / 22 | 1 / 1 / 43 | 2.2% |
| SQL | Gemini 3.8 Flash | 4 / 0 / 5 | 3 / 9 / 2 | 0 / 19 / 3 | 7 / 28 / 10 | 15.6% |
| SQL | GPT-OSS 120B | 3 / 0 / 6 | 0 / 0 / 14 | 0 / 5 / 17 | 3 / 5 / 37 | 6.7% |
| SQL | Qwen 3.8 27B | 4 / 0 / 5 | 1 / 6 / 7 | 0 / 8 / 14 | 5 / 14 / 26 | 11.1% |
| SQL | DeepSeek V4 Flash | 3 / 0 / 6 | 4 / 5 / 5 | 0 / 17 / 5 | 7 / 22 / 16 | 15.6% |
| SQL | DeepSeek Flash (low effort) | 4 / 0 / 5 | 3 / 10 / 1 | 0 / 17 / 5 | 7 / 27 / 11 | 15.6% |
| SQL | GPT-5.6 Luna | 4 / 0 / 5 | 1 / 9 / 4 | 0 / 18 / 4 | 5 / 27 / 13 | 11.1% |
| SQL | GPT-5.6 Terra | 4 / 0 / 5 | 4 / 10 / 0 | 1 / 19 / 2 | 9 / 29 / 7 | 20.0% |
| ASO | Qwen 3.8 27B | 8 / 1 / 0 | 11 / 0 / 3 | 21 / 1 / 0 | 40 / 2 / 3 | 88.9% |
| ASO | Gemini 3.8 Flash | 9 / 0 / 0 | 10 / 1 / 3 | 18 / 4 / 0 | 37 / 5 / 3 | 82.2% |

ASO is the AtlasAI system, recorded for Qwen 3.8 27B and Gemini 3.8 Flash at low reasoning effort. Its study loop answers the forty analysis and data questions; every study answer is a report whose numbers are bound to cells of the tables it computed. The five documentation questions Q22–Q26 go to its reader agent (`dictionary_expert_hpa` in its about mode), which browses the atlas's own information pages, follows links by number, and returns prose in which every sentence carries a quote that code verified on the page; the reader is 5 of 5 under Flash and 4 of 5 under Qwen, which did not follow the 2003 milestone link that holds the second half of Q23. Each model's three Wrong cells are the ambiguous pair variants Q37, Q39 and Q41; their explicit twins Q38, Q40 and Q42 are Correct for both models. 34 questions ask for a figure. Qwen delivered a rendered figure in 31 of them; the other three are the empty sets of Q10 and Q19 and the declined stand-in figures of Q44. Flash delivered one in 31: the empty set of Q19, the declined figures of Q44, and Q35, whose three figures were not delivered. Q35 is Partial for that reason, as is Q34, where one of three figures is missing, while Flash's other Partial cells (Q15, Q17, Q21) and Qwen's Q35 are a list, a mean or a count that differs from the reference.

MCP and SQL are recorded for six models: the two above, GPT-OSS 120B, DeepSeek V4 Flash at two reasoning settings, GPT-5.6 Luna and GPT-5.6 Terra. Their documentation cells are Wrong for every model, as the atlas tools and the bulk files hold no documentation. The strongest tool arm, Terra on SQL, delivers a complete answer in 9 questions. Counting right numbers alone, figures aside (a cell that is Correct, or Partial only because the figure file is missing), ASO leads as well: Qwen 40 of 45 and Flash 39, with all 22 Hard questions right for both; on SQL, Flash 29, Terra 28, DeepSeek at low effort 28, DeepSeek with thinking on 23, Luna 19, Qwen 10, GPT-OSS 3, and at best 15 of the 22 Hard questions. The remaining Partial cells of the tool arms carry a bounded error in a number, a list or a cohort, stated in their notes. Of the SQL and MCP cells that are Partial, 97 have every requested number, table and list right and lack only the figure file; each of the others carries a defect in a number, a list or a cohort, stated in its note. What separates the arms beyond figures is the three negative questions on inference (every SQL and MCP answer turned missing measurements into biological absence on Q43; 12 of 14 invented molecules per cell on Q44; 10 of 14 an intervention benefit on Q45; ASO declined all six times) and, for the open models, the numbers themselves: Qwen on SQL is right on 19 questions and 8 of the 22 Hard ones.

Reasoning settings differ by arm and model. The study loop and the reader ran Qwen and Flash at low reasoning effort against the offline release 25.1. The recorded MCP and SQL runs of Flash, GPT-OSS and Qwen set no effort and took the provider defaults (Qwen and DeepSeek with thinking on, Flash without). The "DeepSeek V4 Flash" rows use that default. The "DeepSeek Flash (low effort)" rows request the model id deepseek-flash, which the DeepSeek API serves for deepseek-v4-flash as well, with reasoning effort low through the standard reasoning_effort field of the runner. GPT-5.6 Luna and GPT-5.6 Terra ran at low reasoning effort through the OpenAI Responses API, since the Chat Completions API refuses function tools together with reasoning for these models. MCP and SQL answers were graded by [grading.md](../execution/grading.md).

## Complete deliverables

A question is complete when every deliverable it asks for is Correct, figures included; that is the Correct count. Tokens per complete deliverable divides the arm's recorded usage by that count.

| Arm | Model | Complete (45) | Tokens | Tokens per complete |
| --- | --- | --- | --- | --- |
| MCP | Gemini 3.8 Flash | 2 | 33,957,838 | 16,978,919 |
| MCP | GPT-OSS 120B | 1 | 9,221,940 | 9,221,940 |
| MCP | Qwen 3.8 27B | 0 | 16,184,473 | n/a |
| MCP | DeepSeek V4 Flash | 1 | 18,635,786 | 18,635,786 |
| MCP | DeepSeek Flash (low effort) | 1 | 13,852,844 | 13,852,844 |
| MCP | GPT-5.6 Luna | 1 | 823,919 | 823,919 |
| MCP | GPT-5.6 Terra | 1 | 861,502 | 861,502 |
| SQL | Gemini 3.8 Flash | 7 | 16,315,108 | 2,330,730 |
| SQL | GPT-OSS 120B | 3 | 11,386,142 | 3,795,381 |
| SQL | Qwen 3.8 27B | 5 | 9,448,593 | 1,889,719 |
| SQL | DeepSeek V4 Flash | 7 | 11,373,310 | 1,624,759 |
| SQL | DeepSeek Flash (low effort) | 7 | 8,216,142 | 1,173,735 |
| SQL | GPT-5.6 Luna | 5 | 3,041,677 | 608,335 |
| SQL | GPT-5.6 Terra | 9 | 2,748,768 | 305,419 |
| ASO | Qwen 3.8 27B | 40 | 7,682,121 | 192,053 |
| ASO | Gemini 3.8 Flash | 37 | 13,537,292 | 365,873 |

Every tool arm delivers at most nine complete answers of 45, against 40 for Qwen in ASO, and none of them for fewer tokens per complete deliverable than Qwen's. DeepSeek and GPT-OSS on SQL spend more raw tokens than Qwen in ASO for 7, 7 and 3 complete deliverables against 40.

## Ambiguity and explicit counterparts

Q37/Q38 test modality; Q39/Q40 test expression threshold; Q41/Q42 test prognostic evidence scope. Each pair uses two separate fresh conversations. An ambiguous variant is Correct only when the answer states the reading it takes and matches that branch of the reference; a silent restriction fails. No ambiguous response is recorded as a clarification answer.

| Arm | Model | Ambiguous | Explicit |
| --- | --- | --- | --- |
| MCP | Gemini 3.8 Flash | 0/3 | 0/3 |
| MCP | GPT-OSS 120B | 0/3 | 0/3 |
| MCP | Qwen 3.8 27B | 0/3 | 0/3 |
| MCP | DeepSeek V4 Flash | 0/3 | 0/3 |
| MCP | DeepSeek Flash (low effort) | 0/3 | 0/3 |
| MCP | GPT-5.6 Luna | 0/3 | 0/3 |
| MCP | GPT-5.6 Terra | 0/3 | 0/3 |
| SQL | Gemini 3.8 Flash | 0/3 | 0/3 |
| SQL | GPT-OSS 120B | 0/3 | 0/3 |
| SQL | Qwen 3.8 27B | 0/3 | 0/3 |
| SQL | DeepSeek V4 Flash | 0/3 | 0/3 |
| SQL | DeepSeek Flash (low effort) | 0/3 | 0/3 |
| SQL | GPT-5.6 Luna | 0/3 | 0/3 |
| SQL | GPT-5.6 Terra | 0/3 | 0/3 |
| ASO | Qwen 3.8 27B | 0/3 | 3/3 |
| ASO | Gemini 3.8 Flash | 0/3 | 3/3 |

All six pair questions ask for figures, so no MCP or SQL answer is Correct on them; the per-question verdict notes say which answers matched the numbers of the reference. Among the SQL answers, Terra and DeepSeek at low effort declared a reading and matched the numbers on all three ambiguous variants, Flash and Luna on two, DeepSeek with thinking on on one, Qwen and GPT-OSS on none; Qwen imposed nTPM ≥5 in Q39 and matched Q40 with the explicit ≥1 threshold, and Terra missed the explicit Q38 on a cohort query that ignores the named tissue. In ASO both models are Wrong on the three ambiguous variants and Correct on the three explicit twins.

## Negative tests

Seven prompts cover six negative-test families. Q10/Q11 share one empty intersection; Q12 checks measurement provenance; Q19 checks an empty filtering workflow; Q43 tests missingness versus absence; Q44 tests absolute calibration; Q45 tests causal inference.

| Arm | Model | C / P / W (7) |
| --- | --- | --- |
| MCP | Gemini 3.8 Flash | 2 / 0 / 5 |
| MCP | GPT-OSS 120B | 1 / 0 / 6 |
| MCP | Qwen 3.8 27B | 0 / 0 / 7 |
| MCP | DeepSeek V4 Flash | 1 / 0 / 6 |
| MCP | DeepSeek Flash (low effort) | 1 / 0 / 6 |
| MCP | GPT-5.6 Luna | 1 / 0 / 6 |
| MCP | GPT-5.6 Terra | 1 / 0 / 6 |
| SQL | Gemini 3.8 Flash | 3 / 2 / 2 |
| SQL | GPT-OSS 120B | 1 / 0 / 6 |
| SQL | Qwen 3.8 27B | 2 / 2 / 3 |
| SQL | DeepSeek V4 Flash | 3 / 1 / 3 |
| SQL | DeepSeek Flash (low effort) | 4 / 0 / 3 |
| SQL | GPT-5.6 Luna | 2 / 2 / 3 |
| SQL | GPT-5.6 Terra | 5 / 1 / 1 |
| ASO | Qwen 3.8 27B | 7 / 0 / 0 |
| ASO | Gemini 3.8 Flash | 7 / 0 / 0 |

The figures these questions ask for are inapplicable for an empty cohort (Q10, Q19) and for quantities the atlas cannot identify (Q44), so a correct answer without them is Correct there; Q43 and Q45 also ask for a figure the data supports, which no MCP or SQL answer delivered. Every MCP and SQL answer failed Q43, and MCP passes only Q12 (no invented half-life). On SQL, the empty cohort of Q10 was established by Flash, DeepSeek at both settings and Terra, and the empty funnel of Q19 by DeepSeek at both settings and Terra; on Q44 Terra declined the absolute quantities and was Correct, Luna was Partial (15 complete rows for 16), and the rest invented them or failed; on Q45 Flash, DeepSeek with thinking on, Luna and Terra had the descriptive results and declined the benefit chart but delivered no association scatter (Partial), while DeepSeek at low effort built a survival-benefit score and named a best target. In ASO, Qwen and Flash pass all seven. Expected behaviour and question-specific verdict notes are in [negative-tests.tsv](negative-tests.tsv).

## Documentation questions with open web tools and with the reader

The five documentation questions were also put to every model row in two further ways. The web arm is the benchmark runner with a third server (`execution/servers/web/`): a web search and a page opener that returns a page's text with numbered links, the same budget of 30 tool calls, and a prompt that names no site. The reader is the AtlasAI agent described above, run under each model through the same inference gateway (`scripts/manual/reader_question.js`, build ea5d2d0; DeepSeek's Q23 on 2ec8625). Grading is by reading against the reference answers; the Q24 reference names the study article of 2 September, and a newer image post appeared on the site on 10 September, so an answer that reports the study article is Correct and one that stops at the image post is Partial.

| Model | Web arm (search and page opener): C / P / W (5) | Tool calls | Tokens | Estimated USD |
| --- | --- | --- | --- | --- |
| Gemini 3.8 Flash | 4 / 0 / 1 | 52 | 903,121 | 0.728121 |
| GPT-OSS 120B | 0 / 2 / 3 | 96 | 2,854,471 | 1.743295 |
| Qwen 3.8 27B | 4 / 1 / 0 | 58 | 974,274 | 1.572294 |
| DeepSeek V4 Flash | 5 / 0 / 0 | 72 | 1,241,148 | 0.583217 |
| DeepSeek Flash (low effort) | 5 / 0 / 0 | 55 | 713,503 | 0.333914 |
| GPT-5.6 Luna | 4 / 0 / 1 | 44 | 331,865 | 0.074353 |
| GPT-5.6 Terra | 4 / 1 / 0 | 40 | 384,131 | 0.863205 |

| Model | Reader: C / P / W (5) | Model calls | Tokens | Estimated USD |
| --- | --- | --- | --- | --- |
| Gemini 3.8 Flash | 5 / 0 / 0 | 19 | 78,151 | 0.063702 |
| GPT-OSS 120B | 3 / 1 / 1 | 31 | 128,050 | 0.050616 |
| Qwen 3.8 27B | 4 / 1 / 0 | 29 | 167,435 | 0.177395 |
| DeepSeek V4 Flash | 5 / 0 / 0 | 25 | 166,153 | 0.087910 |
| DeepSeek Flash (low effort) | 5 / 0 / 0 | 20 | 110,218 | 0.057110 |
| GPT-5.6 Luna | 0 / 0 / 5 | 17 | 60,202 | 0.028176 |
| GPT-5.6 Terra | 0 / 0 / 5 | 15 | 46,864 | 0.147568 |

With open web tools most models reach the answers, at 300 thousand to 2.9 million tokens per five questions: the release-history page opened seven times in a row, up to 30 tool calls, and in Flash's case an answer blanked by the provider's recitation filter (Q26). GPT-OSS spent its whole call budget on Q22 and reported the wrong release. The reader answers the same questions at a tenth of the tokens, with every sentence tied to a verified quote, and it lifts GPT-OSS from 0 to 3 Correct. Its misses are the models' choices within the reader's protocol: Luna and Terra at low effort open the home page, read a section, and answer that the pages do not say, instead of following the link in front of them; Qwen did not follow the 2003 milestone link; GPT-OSS asked to open pages that did not exist. The web arm's traces are in [web](web/) and the reader's in [reader](reader/).

## Usage

Recorded token totals and estimated costs describe retained usage, not an invoice total. The reader's costs charge every input token at the uncached rate.

| Arm | Model | Tokens | Estimated USD |
| --- | --- | --- | --- |
| MCP | Gemini 3.8 Flash | 33,957,838 | 8.450675 |
| MCP | GPT-OSS 120B | 9,221,940 | 3.304951 |
| MCP | Qwen 3.8 27B | 16,184,473 | 16.646477 |
| MCP | DeepSeek V4 Flash | 18,635,786 | 3.257367 |
| MCP | DeepSeek Flash (low effort) | 13,852,844 | 6.594254 |
| MCP | GPT-5.6 Luna | 823,919 | 0.200385 |
| MCP | GPT-5.6 Terra | 861,502 | 2.127660 |
| SQL | Gemini 3.8 Flash | 16,315,108 | 9.385824 |
| SQL | GPT-OSS 120B | 11,386,142 | 4.148767 |
| SQL | Qwen 3.8 27B | 9,448,593 | 9.792054 |
| SQL | DeepSeek V4 Flash | 11,373,310 | 1.690688 |
| SQL | DeepSeek Flash (low effort) | 8,216,142 | 4.196031 |
| SQL | GPT-5.6 Luna | 3,041,677 | 0.799621 |
| SQL | GPT-5.6 Terra | 2,748,768 | 7.777606 |
| ASO | Qwen 3.8 27B | 7,682,121 | 8.486223 |
| ASO | Gemini 3.8 Flash | 13,537,292 | 8.896229 |

Detailed answers, seven-field verdicts and per-question tables are in [mcp](mcp/), [sql](sql/), [aso](aso/), [web](web/) and [reader](reader/); the ASO folder also holds each run's events, model calls and rendered figures, and the reader's answers for Q22–Q26. Summary views: [difficulty](difficulty.tsv), [ambiguity](ambiguity.tsv), and [negative tests](negative-tests.tsv). The five documentation questions scored Wrong for every model in the MCP and SQL arms and remain included.
