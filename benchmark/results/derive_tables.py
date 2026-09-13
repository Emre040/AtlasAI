#!/usr/bin/env python3
"""derive_tables.py [--check]: rebuild difficulty.tsv, ambiguity.tsv and negative-tests.tsv from results/<arm>/results.tsv.

Rows are ordered by arm (mcp, sql, aso) and, within an arm, by the model order of that arm's summary.tsv.
--check prints, instead of writing, every existing row that the rebuilt tables would change or drop."""
import csv, json, os, sys
B = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = f'{B}/results'
q = json.load(open(f'{B}/questions/questions.json'))
qs = {x['id']: x for x in (q if isinstance(q, list) else q.values())}
check = '--check' in sys.argv

def rows(arm):
    order = [r['model'] for r in csv.DictReader(open(f'{R}/{arm}/summary.tsv'), delimiter='\t')]
    data = list(csv.DictReader(open(f'{R}/{arm}/results.tsv'), delimiter='\t'))
    for model in order:
        yield model, [r for r in data if r['model'] == model]

def tally(rs):
    c = sum(1 for r in rs if r['correct'] == 'True'); p = sum(1 for r in rs if r['correct'] == 'PARTIAL')
    return [len(rs), c, p, len(rs) - c - p, repr(c / len(rs)) if rs else '0']

difficulty, ambiguity, negative = [], [], []
for arm in ('mcp', 'sql', 'aso'):
    for model, rs in rows(arm):
        for level in ('Easy', 'Medium', 'Hard'):
            difficulty.append([model, arm, level] + [str(x) for x in tally([r for r in rs if qs[r['question']]['difficulty'] == level])])
        for variant in ('ambiguous', 'explicit'):
            ambiguity.append([model, arm, variant] + [str(x) for x in tally([r for r in rs if qs[r['question']].get('pair_variant') == variant])] + ['0'])
        for r in rs:
            meta = qs[r['question']]
            if meta.get('negative_type'):
                negative.append([model, arm, r['question'], meta['negative_type'], meta.get('family_id') or '', r['correct'], meta.get('expected_behavior') or '', r['note']])

tables = {
    'difficulty.tsv': (['model', 'condition', 'difficulty', 'evaluated', 'correct', 'partial', 'incorrect', 'accuracy'], difficulty, 3),
    'ambiguity.tsv': (['model', 'condition', 'variant', 'evaluated', 'correct', 'partial', 'incorrect', 'accuracy', 'clarification_answers'], ambiguity, 3),
    'negative-tests.tsv': (['model', 'condition', 'question', 'negative_type', 'family_id', 'correct', 'expected_behavior', 'note'], negative, 3),
}
for name, (hdr, body, keylen) in tables.items():
    path = f'{R}/{name}'
    if check:
        old = {tuple(r[:keylen]): r for r in csv.reader(open(path), delimiter='\t')} if os.path.exists(path) else {}
        new = {tuple(r[:keylen]): r for r in body}
        changed = [k for k in old if k != tuple(hdr[:keylen]) and old[k] != new.get(k)]
        print(f'{name}: {len(old) - 1} rows on disk, {len(new)} rebuilt, {len(changed)} existing rows differ')
        for k in changed: print('  ', k, '|', old[k][keylen:], '->', new[k][keylen:] if k in new else 'dropped')
        continue
    with open(path, 'w', newline='') as f:
        w = csv.writer(f, delimiter='\t', lineterminator='\n'); w.writerow(hdr); w.writerows(body)
    print(f'{name}: {len(body)} rows')
