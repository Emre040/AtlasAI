#!/usr/bin/env python3
"""Scores the web-search benchmark: every reference fact must appear in the answer.

    python3 execution/score.py <arm> <model>

Reads results/<arm>/runs/<model>/, where an answer is either <id>.answer.md beside <id>.json (the
web-tool runner) or <id>/answer.md beside <id>/result.json (the reader runner). Writes
results/<arm>/runs/<model>/scores.json, appends the model to results/<arm>/results.tsv and
writes results/<arm>/summary.json. A fact is present when one of its accepted spellings occurs in
the answer, compared case-insensitively with thousands separators removed. Nothing is graded by a
model or by hand.
"""
import json, re, sys
from pathlib import Path

here = Path(__file__).resolve().parent.parent
arm, model = sys.argv[1], sys.argv[2]
questions = json.load(open(here / "questions/questions.json"))
references = json.load(open(here / "references/answers.json"))
runs = here / "results" / arm / "runs" / model

def normalize(text):
    text = text.lower().replace(" ", " ").replace(" ", " ")
    text = re.sub(r"(?<=\d)[,\s](?=\d{3}\b)", "", text)   # 27,800 and 27 800 -> 27800
    return re.sub(r"\s+", " ", text)

def answer_of(qid):
    flat = runs / f"{qid}.answer.md"
    nested = runs / qid / "answer.md"
    if flat.exists(): return flat.read_text(), runs / f"{qid}.json"
    if nested.exists(): return nested.read_text(), runs / qid / "result.json"
    return None, None

def usage_of(meta_file):
    if not meta_file or not meta_file.exists(): return {}
    meta = json.load(open(meta_file))
    usage = meta.get("usage") or meta.get("accounting") or meta.get("tokens") or {}
    tokens_in = usage.get("input_tokens", usage.get("prompt", usage.get("input")))
    tokens_out = usage.get("output_tokens", usage.get("completion", usage.get("output")))
    cost = meta.get("cost_usd")
    if cost is None and tokens_in is not None and meta.get("model") in PRICES:
        p = PRICES[meta["model"]]; cost = (tokens_in * p["input"] + (tokens_out or 0) * p["output"]) / 1e12
    return {"tokens_in": tokens_in, "tokens_out": tokens_out, "seconds": meta.get("seconds"), "cost_usd": cost, "model_calls": meta.get("model_calls") or usage.get("calls")}

PRICES = json.load(open(here.parent / "system/execution/runner/prices.json"))

scores = {}
for q in questions:
    text, meta_file = answer_of(q["id"])
    ref = references[q["id"]]
    if text is None:
        scores[q["id"]] = {"answered": False, "correct": False, "facts_found": 0, "facts_total": len(ref["facts"]), "missing": [f[0] for f in ref["facts"]]}
        continue
    body = normalize(text)
    found, missing = 0, []
    for alternatives in ref["facts"]:
        if any(normalize(a) in body for a in alternatives): found += 1
        else: missing.append(alternatives[0])
    cites = "proteinatlas.org" in text
    scores[q["id"]] = {"answered": True, "correct": found == len(ref["facts"]), "facts_found": found, "facts_total": len(ref["facts"]), "missing": missing, "cites_atlas": cites, **usage_of(meta_file)}

json.dump(scores, open(runs / "scores.json", "w"), indent=1)
by_id = {q["id"]: q for q in questions}
results = here / "results" / arm / "results.tsv"
lines = [] if not results.exists() else [l for l in results.read_text().splitlines() if l and not l.startswith("id\t") and l.split("\t")[1] != model]
header = "id\tmodel\tdifficulty\tanswered\tcorrect\tfacts_found\tfacts_total\tcites_atlas\ttokens_in\ttokens_out\tseconds\tcost_usd"
for qid, s in scores.items():
    lines.append("\t".join(str(x) for x in [qid, model, by_id[qid]["difficulty"], s["answered"], s["correct"], s["facts_found"], s["facts_total"], s.get("cites_atlas", ""), s.get("tokens_in", ""), s.get("tokens_out", ""), s.get("seconds", ""), s.get("cost_usd", "")]))
results.write_text(header + "\n" + "\n".join(sorted(lines, key=lambda l: (l.split("\t")[1], int(l.split("\t")[0][1:])))) + "\n")
summary_file = here / "results" / arm / "summary.json"
summary = json.load(open(summary_file)) if summary_file.exists() else {}
tier = lambda name: {"questions": sum(1 for q in questions if q["difficulty"] == name), "correct": sum(1 for q in questions if q["difficulty"] == name and scores[q["id"]]["correct"])}
summary[model] = {"questions": len(questions), "answered": sum(1 for s in scores.values() if s["answered"]), "correct": sum(1 for s in scores.values() if s["correct"]),
                  "facts_found": sum(s["facts_found"] for s in scores.values()), "facts_total": sum(s["facts_total"] for s in scores.values()),
                  "by_difficulty": {n: tier(n) for n in ("Easy", "Medium", "Hard")},
                  "tokens_in": sum(s.get("tokens_in") or 0 for s in scores.values()), "tokens_out": sum(s.get("tokens_out") or 0 for s in scores.values()),
                  "cost_usd": round(sum(s.get("cost_usd") or 0 for s in scores.values()), 4)}
json.dump(summary, open(summary_file, "w"), indent=1)
for qid, s in scores.items(): print(qid, "CORRECT" if s["correct"] else "WRONG", f"{s['facts_found']}/{s['facts_total']}", "missing:", s["missing"])
print(json.dumps(summary[model]))
