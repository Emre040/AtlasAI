#!/usr/bin/env python3
"""readme_tables.py: print the five tables of results/README.md from results/<arm>/results.tsv and summary.tsv.
Rows follow the arm order mcp, sql, aso and, within an arm, the model order of that arm's summary.tsv."""
import csv, json, os
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = f'{B}/results'
q = json.load(open(f'{B}/questions/questions.json'))
qs = {x['id']: x for x in (q if isinstance(q, list) else q.values())}
NO_FIGURE = {'Q1', 'Q2', 'Q3', 'Q4', 'Q11', 'Q12', 'Q22', 'Q23', 'Q24', 'Q25', 'Q26'}
NEGATIVE = [i for i in qs if qs[i].get('negative_type')]
ARM = {'mcp': 'MCP', 'sql': 'SQL', 'aso': 'ASO'}

def blocks():
    for arm in ('mcp', 'sql', 'aso'):
        summary = {r['model']: r for r in csv.DictReader(open(f'{R}/{arm}/summary.tsv'), delimiter='\t')}
        data = list(csv.DictReader(open(f'{R}/{arm}/results.tsv'), delimiter='\t'))
        for model in summary:
            yield arm, model, summary[model], {r['question']: r for r in data if r['model'] == model}

def cpw(rows):
    c = sum(1 for r in rows if r['correct'] == 'True'); p = sum(1 for r in rows if r['correct'] == 'PARTIAL')
    return c, p, len(rows) - c - p

def cell(rows): return '%d / %d / %d' % cpw(rows)

print('| Arm | Model | Easy (9) | Medium (14) | Hard (22) | All (45) | Accuracy |\n| --- | --- | --- | --- | --- | --- | --- |')
for arm, model, s, rows in blocks():
    by = lambda level: [r for r in rows.values() if qs[r['question']]['difficulty'] == level]
    print(f"| {ARM[arm]} | {model} | {cell(by('Easy'))} | {cell(by('Medium'))} | {cell(by('Hard'))} | {cell(list(rows.values()))} | {100 * cpw(list(rows.values()))[0] / 45:.1f}% |")

print('\n| Arm | Model | Complete (45) | Tokens | Tokens per complete |\n| --- | --- | --- | --- | --- |')
for arm, model, s, rows in blocks():
    complete = sum(1 for r in rows.values() if r['correct'] == 'True')   # Correct is the complete deliverable in every arm
    tokens = int(s['tokens'])
    print(f"| {ARM[arm]} | {model} | {complete} | {tokens:,} | {round(tokens / complete):,} |" if complete else f"| {ARM[arm]} | {model} | 0 | {tokens:,} | n/a |")

print('\n| Arm | Model | Ambiguous | Explicit |\n| --- | --- | --- | --- |')
for arm, model, s, rows in blocks():
    v = lambda variant: sum(1 for r in rows.values() if qs[r['question']].get('pair_variant') == variant and r['correct'] == 'True')
    print(f"| {ARM[arm]} | {model} | {v('ambiguous')}/3 | {v('explicit')}/3 |")

print('\n| Arm | Model | C / P / W (7) |\n| --- | --- | --- |')
for arm, model, s, rows in blocks():
    print(f"| {ARM[arm]} | {model} | {cell([rows[i] for i in NEGATIVE])} |")

print('\n| Arm | Model | Tokens | Estimated USD |\n| --- | --- | --- | --- |')
for arm, model, s, rows in blocks():
    print(f"| {ARM[arm]} | {model} | {int(s['tokens']):,} | {float(s['estimated_usd']):.6f} |")

# The documentation questions on the web arm and with the reader: five questions per model.
for arm, label in (('web', 'Web arm (search and page opener)'), ('reader', 'Reader')):
    if not os.path.exists(f'{R}/{arm}/summary.tsv'): continue
    print(f'\n| Model | {label}: C / P / W (5) | Tool calls | Tokens | Estimated USD |\n| --- | --- | --- | --- | --- |' if arm == 'web' else f'\n| Model | {label}: C / P / W (5) | Model calls | Tokens | Estimated USD |\n| --- | --- | --- | --- | --- |')
    data = list(csv.DictReader(open(f'{R}/{arm}/results.tsv'), delimiter='\t'))
    for s in csv.DictReader(open(f'{R}/{arm}/summary.tsv'), delimiter='\t'):
        rows = [r for r in data if r['model'] == s['model']]
        if arm == 'web': calls = sum(len(json.load(open(f"{R}/web/runs/{r['run']}/{r['question']}.json"))['tool_calls']) for r in rows)
        else: calls = sum(json.load(open(f"{R}/reader/runs/{r['run']}/{r['question']}.result.json"))['accounting']['calls'] for r in rows if os.path.exists(f"{R}/reader/runs/{r['run']}/{r['question']}.result.json"))
        n = int(s['evaluated']); tally = f"{s['correct']} / {s['partial']} / {s['incorrect']}" + (f' (of {n})' if n != 5 else '')
        print(f"| {s['model']} | {tally} | {calls} | {int(s['tokens']):,} | {float(s['estimated_usd']):.6f} |")
