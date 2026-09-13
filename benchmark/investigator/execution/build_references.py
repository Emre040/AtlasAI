#!/usr/bin/env python3
"""Builds references/answers.json for the investigator benchmark from the local atlas files.

Every reference is read straight from the release file the question is about: the rows for the
question's points in the question's context, and the value column. Negative and rejection
questions carry no rows. Run from the benchmark folder with the local data directory:

    python3 execution/build_references.py /path/to/Backend/data_local
"""
import csv, json, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1])
here = Path(__file__).resolve().parent.parent
questions = {q["id"]: q for q in json.load(open(here / "questions/questions.json"))}

# Per question: the file, the point spelling column(s), the row filters, the context columns kept
# beside the value, and the value column.
SPEC = {
    "I1": dict(file="rna_tissue_consensus.tsv", key="Gene name", filters={"Tissue": "liver"}, value="nTPM"),
    "I2": dict(file="rna_tissue_consensus.tsv", key="Gene name", filters={"Tissue": "pancreas"}, value="nTPM"),
    "I3": dict(file="subcellular_location.tsv", key="Gene name", filters={}, value="Main location"),
    "I4": dict(file="cancer_data.tsv", key="Gene name", filters={"Cancer": "breast cancer"}, value="High"),
    "I5": dict(file="rna_single_cell_type.tsv", key="Gene name", filters={"Cell type": "pancreatic islet cells"}, value="nCPM"),
    "I6": dict(file="rna_brain_region_hpa.tsv", key="Gene name", filters={"Brain region": "cerebral cortex"}, value="nTPM"),
    "I7": dict(file="rna_immune_cell.tsv", key="Gene name", filters={"Immune cell": "naive B-cell"}, value="nTPM"),
    "I8": dict(file="blood_ms_concentration.tsv", key="Gene", filters={}, value="Conc [pg/L]", ensembl="ENSG ID"),
    "I9": dict(file="subcellular_location.tsv", key="Gene name", filters={}, value="Reliability"),
    "I10": dict(file="rna_celline.tsv", key="Gene name", filters={"Cell line": "A-431"}, value="nTPM"),
    "I11": dict(file="rna_tissue_consensus.tsv", key="Gene name", filters={"Tissue": "kidney"}, value="nTPM"),
    "I12": dict(file="rna_tissue_gtex.tsv", key="Gene name", filters={"Tissue": "liver"}, value="nTPM"),
    "I13": dict(file="rna_tissue_fantom.tsv", key="Gene name", filters={"Tissue": "liver"}, value="Normalized tags per million"),
    "I14": dict(file="normal_ihc_data.tsv", key="Gene name", filters={"Tissue": "Skin", "Cell type": "cells in basal layer"}, value="Level", context=["Cell type"]),
    "I15": dict(file="rna_cell_line_cancer.tsv", key="Gene name", filters={"Cancer": "Leukemia"}, value="nTPM"),
    "I16": dict(file="interaction_consensus.tsv", partners_of="ENSG00000141510"),
    "I17": dict(file="cancer_prognostic_data.tsv", key="Gene name", filters={"Cancer": "Kidney Renal Clear Cell Carcinoma (TCGA)"}, value="*nonempty*"),
    "I18": dict(file="dvp_cell_type.tsv", key="Gene name", filters={"Cell type": "hepatocytes"}, value="Intensity"),
    "I19": dict(file="ms_tissue.tsv", key="Gene name", filters={"Tissue": "heart muscle"}, value="Intensity"),
    "I20": dict(file="blood_pea_disease_de.tsv", key="Gene", filters={"Disease": "Hepatocellular cancer", "Control": "Healthy"}, value="logFC", ensembl="ENSG ID", context=["Control"]),
    "I21": dict(file="rna_single_cell_type.tsv", key="Gene name", filters={"Cell type": "t-cells"}, value="nCPM"),
    "I22": dict(file="rna_mouse_brain_hpa.tsv", key="Gene name", filters={"Brain region": "cerebellum"}, value="nTPM"),
    "I23": dict(file="rna_tissue_consensus.tsv", key="Gene", filters={"Tissue": "liver"}, value="nTPM", first_ids=120),
    "I24": dict(file="rna_single_cell_cluster.tsv", key="Gene name", filters={"Tissue": "skin"}, match={"Cell type": "keratinocytes"}, value="nCPM", context=["Cluster", "Cell type"]),
    "I25": dict(file="rna_immune_cell_sample.tsv", key="Gene name", filters={"Immune cell": "classical monocyte"}, value="nTPM", ensembl="ENSG ID", context=["Donor"]),
    "I26": dict(file="blood_immunoassay_concentration.tsv", key="gene", filters={"sample type": "Plasma"}, value="conc [pg/L]", ensembl="ENSG ID", context=["pubmed id"]),
    "I27": dict(kind="negative", why="No file of the release records protein half-life."),
    "I28": dict(kind="rejection", why="Two fields from two files (rna_tissue_consensus.tsv nTPM, blood_ms_concentration.tsv concentration); the investigator answers one field in one context per run."),
    "I29": dict(file="rna_tissue_consensus.tsv", key="Gene name", filters={"Tissue": "liver"}, value="nTPM", synonyms={"p53": "TP53", "HER2": "ERBB2", "PD-L1": "CD274", "c-Myc": "MYC"}),
    "I30": dict(file="cancer_cptac.tsv", key="Gene name", filters={"Cancer": "Lung SQCC"}, value="logFC"),
}

def grep_rows(file, needles):
    """Rows of a tab-separated file whose line contains one of the needles, as dicts."""
    path = root / file
    with open(path, newline="") as fh:
        header = next(csv.reader(fh, delimiter="\t"))
    if not needles:
        with open(path, newline="") as fh:
            return header, list(csv.DictReader(fh, delimiter="\t"))
    pattern = "\n".join(needles) + "\n"
    out = subprocess.run(["grep", "-F", "-f", "-", str(path)], input=pattern, capture_output=True, text=True).stdout
    rows = list(csv.DictReader(out.splitlines(), fieldnames=header, delimiter="\t"))
    return header, rows

references = {}
for qid, spec in SPEC.items():
    q = questions[qid]
    if spec.get("kind") in ("negative", "rejection"):
        references[qid] = {"kind": spec["kind"], "why": spec["why"], "rows": [], "source_file": None}
        continue
    if "partners_of" in spec:
        header, rows = grep_rows(spec["file"], [spec["partners_of"]])
        partners = sorted({r["ensembl_gene_id_2"] if r["ensembl_gene_id_1"] == spec["partners_of"] else r["ensembl_gene_id_1"] for r in rows if spec["partners_of"] in (r["ensembl_gene_id_1"], r["ensembl_gene_id_2"])})
        references[qid] = {"kind": "rows", "source_file": spec["file"], "value_column": "the other gene of each pair", "rows": [{"point": ["TP53", spec["partners_of"]], "context": {}, "value": p} for p in partners]}
        continue
    points = q["points"]
    if spec.get("first_ids"):
        seen = []
        with open(root / spec["file"], newline="") as fh:
            next(fh)
            for line in fh:
                g = line.split("\t", 1)[0]
                if g not in seen:
                    seen.append(g)
                    if len(seen) == spec["first_ids"]: break
        points = seen
        q["points"] = points
    synonyms = spec.get("synonyms", {})
    lookup = [synonyms.get(p, p) for p in points]
    header, rows = grep_rows(spec["file"], lookup)
    key, ensembl = spec["key"], spec.get("ensembl", "Gene")
    out = []
    for p, name in zip(points, lookup):
        for r in rows:
            if r.get(key) != name: continue
            if any(r.get(c) != v for c, v in spec.get("filters", {}).items()): continue
            if any(v not in (r.get(c) or "") for c, v in spec.get("match", {}).items()): continue
            if spec["value"] == "*nonempty*":
                cols = [c for c in header if c not in (key, ensembl, "Cancer") and (r.get(c) or "").strip()]
                for c in cols: out.append({"point": sorted({p, name, r.get(ensembl, "")} - {""}), "context": {"Cancer": r["Cancer"], "column": c}, "value": r[c]})
                continue
            value = r.get(spec["value"])
            if value is None or str(value).strip() == "": continue
            out.append({"point": sorted({p, name, r.get(ensembl, "")} - {""}), "context": {c: r[c] for c in spec.get("context", [])}, "value": value})
    references[qid] = {"kind": "rows", "source_file": spec["file"], "value_column": spec["value"], "filters": spec.get("filters", {}), "rows": out}
    if not out: print(f"WARNING {qid}: no rows", file=sys.stderr)

json.dump(references, open(here / "references/answers.json", "w"), indent=1)
json.dump(list(questions.values()), open(here / "questions/questions.json", "w"), indent=1)
for qid, ref in references.items():
    print(qid, ref["kind"], ref.get("source_file"), len(ref["rows"]), "rows", (ref["rows"][0] if ref["rows"] else ""))
