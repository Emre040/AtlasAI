# AtlasAI benchmark

An open-weight 27B model running inside AtlasAI answers 40 of 45 Human Protein
Atlas questions completely. The strongest closed model with SQL access answers 9;
any model over the atlas's MCP server answers at most 2. The same two models that
run inside AtlasAI answer 0 and 1 questions over MCP and 5 and 7 over SQL, so the
gain is the system, and every number AtlasAI reports can be traced to the table
it was computed from.

## The benchmark

45 questions about the Human Protein Atlas: 4 lookups, 26 analyses, 7 negative
tests that tempt an unsupported conclusion, 3 questions written ambiguously with
their explicit twins, and 5 questions about the atlas's own documentation.
Difficulty is fixed by a [rubric](questions/difficulty.md): 9 Easy, 14 Medium,
22 Hard. Every question has a [reference answer](references/answers.json)
computed from the atlas files.

Each question is asked three ways, each in a fresh conversation:

| Way of answering | What the model gets |
| --- | --- |
| MCP | the search and lookup tools of the [ProteinAtlas MCP server](https://github.com/mcp-servers/proteinatlas-mcp-server) (version 1.0.0) |
| SQL | the atlas's bulk files as SQL tables (DuckDB) and a query tool |
| AtlasAI | the AtlasAI system: its study loop over the same files, and its reader for documentation questions |

Models: Gemini 3.8 Flash, GPT-OSS 120B, Qwen 3.8 27B (the open-weight 27B
model), DeepSeek V4 Flash at two reasoning settings, GPT-5.6 Luna and GPT-5.6
Terra. All six ran over MCP and SQL; Qwen 3.8 27B and Gemini 3.8 Flash ran inside
AtlasAI.

An answer is **complete** when everything the question asks for is delivered and
matches the reference. That is the only grade counted as right; an answer with a
correct part is Partial, an answer with a wrong cohort, an invented quantity or
no result is Wrong.

## Results

Complete answers out of 45:

| Model | MCP | SQL | AtlasAI |
| --- | --- | --- | --- |
| Qwen 3.8 27B | 0 | 5 | **40** |
| Gemini 3.8 Flash | 2 | 7 | **37** |
| GPT-5.6 Terra | 1 | 9 | |
| DeepSeek Flash (low effort) | 1 | 7 | |
| DeepSeek V4 Flash | 1 | 7 | |
| GPT-5.6 Luna | 1 | 5 | |
| GPT-OSS 120B | 1 | 3 | |

**Every number is a computed cell.** An AtlasAI answer is a report of tables and
figures the run computed from the atlas files, step by step, each step recorded
with its inputs. A statement in the report has to point at the cells it rests on,
and the system rejects a statement whose number is not there. Across the two
AtlasAI passes that is 80 reports, 350 statements and 3,469 computed tables, each
checkable in one step. A SQL or MCP answer is prose with the queries or API
replies beside it; checking it means redoing it.

**Same model, three ways.** Qwen 3.8 27B answers 0 questions completely over MCP,
5 over SQL and 40 inside AtlasAI. Gemini 3.8 Flash: 2, 7 and 37. Weights,
questions and reference are the same in all three columns.

**Cost.** A complete answer from the 27B model inside AtlasAI costs 192 thousand
tokens, the lowest figure in the benchmark; the same model over SQL spends 1.89
million per complete answer, ten times more. Flash: 366 thousand inside AtlasAI
against 2.33 million over SQL. The full 45-question pass of the 27B model cost
7.7 million tokens, about nine dollars. Counted per answer with the right numbers
rather than per complete answer, GPT-5.6 Terra and Luna over SQL are cheaper,
because their conversations are short; they reach 28 and 19 right answers to 40.

**It is not presentation.** Counting only whether the numbers are right, whatever
was or was not delivered around them: on the 26 analysis questions the 27B model
inside AtlasAI is right on 25 and wrong on 0; the best model over SQL is right on
19, the same 27B model over SQL on 5. On the 22 Hard questions both AtlasAI
models are right on all 22; the best over SQL reaches 15.

| Model | Right numbers over SQL | Right numbers inside AtlasAI |
| --- | --- | --- |
| Qwen 3.8 27B | 10 | 40 |
| Gemini 3.8 Flash | 29 | 39 |
| GPT-5.6 Terra | 28 | |
| DeepSeek Flash (low effort) | 28 | |
| DeepSeek V4 Flash | 23 | |
| GPT-5.6 Luna | 19 | |
| GPT-OSS 120B | 3 | |

**Nobody else gets there.** 36 of the 45 questions are answered completely by no
model over SQL or MCP. The 27B model inside AtlasAI answers 31 of them.

**It does not invent findings.** Three questions tempt a conclusion the data cannot
support: a biological absence read off blank measurements, molecules per cell read
off relative intensities, a treatment benefit read off an association. Every
model over SQL or MCP fell for at least one, and all fourteen runs fell for the
first. AtlasAI fell for none. Across all seven negative tests AtlasAI is 14 of 14;
the best anyone else manages is 5 of 7.

**MCP does not work for analysis.** Nearly a third of the 315 MCP answers are refusals,
and no model reaches more than 2 complete answers through it.

**Documentation.** SQL and MCP cannot answer the five questions about the atlas
itself. AtlasAI's reader answers all five with Gemini 3.8 Flash and with DeepSeek,
every sentence backed by a quote verified on the page, using six to eleven times
fewer tokens than the same models searching the open web. The GPT-5.6 models stop
at the atlas front page and answer none.

**Ambiguous wording.** Three questions leave a term open that the atlas records in
more than one way. AtlasAI picks one meaning without saying so: 0 of 3. The same
three questions written explicitly: 3 of 3 complete, where no other setup
completes any. In the product a clarifying step runs before the study loop; the
benchmark protocol asks each question once, without follow-up, so that step is
not exercised.

## How to read the rest

| Material | Contents |
| --- | --- |
| [Questions](questions/README.md) | Q1–Q45, exact prompts, task types, difficulty scores |
| [References](references/answers.json) | reference answers; [notes](references/notes.md) on two of them |
| [Results](results/README.md) | every model, every way of answering, per-question verdicts with a note each, and the difficulty, ambiguity and negative-test views |
| [Execution](execution/README.md) | the runner, the three servers, the grading definitions, prices |

Every answer and its trace is kept under results, and every verdict carries a
note saying what matched the reference and what did not. We assigned the verdicts
ourselves, reading every answer in full against the reference. Reasoning settings
are listed in the results README.
