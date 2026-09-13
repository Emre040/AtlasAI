# Execution method

One agent is under test: the investigator (`investigator_hpa`, the bulk
investigator in `Backend/src/system/agents/investigatorBulk.js`). It receives a
question and, when the question is about a list, the list of points. It
searches the release for where the question's words and the points live, reads
the rows of a file for the points, and returns them as tables with the mapping
it made (field, file, column) and a note. A question over two fields comes
back as one table per field, each from its own file.

Every run is made with `Backend/scripts/manual/investigator_benchmark.js`,
which binds one catalog model for the process, keeps the database read only
and records every step:

| Mode | What it does |
| --- | --- |
| `--run --model <key> --effort <level> --label <name>` | Runs each question once and writes `results/<name>/runs/<id>.json`: the tables returned (source file, columns, rows, mapping), the note, tokens, calls, turns, seconds, every step. A question with a file is not run again. |
| `--score --label <name>` | Scores every record against `references/answers.json` and writes `results/<name>/results.tsv` and `summary.json`. |

Run from `Backend/` with its `.env` loaded, for example:

```
node scripts/manual/investigator_benchmark.js --run --benchmark /abs/path/benchmark/investigator --model gemini-3.8-flash --effort low --label flash-low --parallel 4
node scripts/manual/investigator_benchmark.js --score --benchmark /abs/path/benchmark/investigator --label flash-low
```

## References

`references/answers.json` is built by `execution/build_references.py` straight
from the release files in the local data directory: for each question, the
rows of the named file for the question's points in the question's context,
with the value column. The two-field question lists both files. The negative
question carries no rows and says why.

## Scoring

A question is correct when every expected row appears in a returned table: a
row whose cells hold the point (its symbol or Ensembl id), the expected
context values, and the expected value (numbers compared as numbers, text
case-insensitively), and when every reference file is among the sources of
the matching tables. A context that is itself a value (a publication id
beside a concentration) may sit in a sibling table's row for the same point,
since the investigator returns one table per value column. The negative
question is correct when the agent reports that no table holds the value and
returns no rows. Nothing is graded by a model or by hand.
