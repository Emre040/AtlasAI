# AtlasAI benchmarks

Four benchmarks, one per folder, each laid out the same way: `questions/`
(the questions and their difficulty), `references/` (what a correct answer
is), `execution/` (how the runs were made and graded) and `results/` (every
recorded run and its verdict).

| Folder | What it measures | Questions |
| --- | --- | --- |
| [system](system/README.md) | The whole system: a model inside AtlasAI against the same model over the atlas's MCP server and over SQL, on research questions that need tables, statistics and figures | 45 |
| [deep-search](deep-search/README.md) | The search agent alone: a question in plain language becomes one atlas search query, scored against the reference query on the same release | 236 |
| [investigator](investigator/README.md) | The investigator agent alone: reading atlas files into artifacts | to be defined |
| [web-search](web-search/README.md) | The reader agent against open web tools on documentation questions | to be defined |

The 45-question system benchmark is the one the paper reports. The others
test one agent each on its own task.
