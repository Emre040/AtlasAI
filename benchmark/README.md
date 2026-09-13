# AtlasAI benchmarks

Four benchmarks, one per folder, each laid out the same way: `questions/`
(the questions and their difficulty), `references/` (what a correct answer
is), `execution/` (how the runs were made and graded) and `results/` (every
recorded run and its verdict).

| Folder | What it measures | Questions |
| --- | --- | --- |
| [system](system/README.md) | The whole system: a model inside AtlasAI against the same model over the atlas's MCP server and over SQL, on research questions that need tables, statistics and figures | 45 |
| [deep-search](deep-search/README.md) | The search agent alone: a question in plain language becomes one atlas search query, scored against the reference query on the same release | 236 |
| [investigator](investigator/README.md) | The investigator agent alone: a question about a gene or a list in, the rows that answer it out of one release file, checked row for row against the file | 30 |
| [web-search](web-search/README.md) | The reader agent against the same model with open web tools, on documentation questions about the atlas with known facts | 20 |

The 45-question system benchmark is the one the paper reports. The others
test one agent each on its own task, and every one of them is scored by code
against references: no model and no hand grades them.
