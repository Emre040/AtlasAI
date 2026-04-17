'use strict';

/**
 * Deep Research — Clean, Minimal, Human-Librarian Flow
 * - No hardcoded switchcases or synonym tables
 * - Compact catalog summary + stepwise narrowing
 * - Explicit plan and coverage mapping
 */

const { client, MODEL } = require('../llm');
const https = require('https');

const { detailedSearchOptions } = require('./data.js');
const { hpaSchema } = require('../data/hpaSchema.js');

// Debug logging - off by default, enable with HPA_LOG_LLM_IO=1
const LOG_LLM_IO = process.env.HPA_LOG_LLM_IO === '1';

// -----------------------------
// Utilities
// -----------------------------
function lower(s) { return (s || '').toLowerCase(); }

function tokenize(text = '') {
  return lower(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreText(tokens, candidate = '') {
  if (!tokens || !tokens.length) return 0;
  const candTokens = tokenize(candidate);
  const candSet = new Set(candTokens);
  let score = 0;
  for (const t of tokens) {
    if (candSet.has(t)) { score++; continue; }
    // Stem-aware: "mitochondrial"↔"mitochondria", "nuclear"↔"nucleoplasm", "prognostic"↔"prognostic"
    for (const ct of candTokens) {
      let p = 0;
      while (p < t.length && p < ct.length && t[p] === ct[p]) p++;
      if (p >= 4) { score++; break; }
    }
  }
  return score;
}

function findSchemaField(fieldName) {
  for (const [category, fields] of Object.entries(hpaSchema)) {
    if (fields[fieldName]) return fields[fieldName];
  }
  return null;
}

/**
 * Check if a field level supports multi-select
 * @param {string} fieldName - Field name like "Protein class"
 * @param {number} levelIndex - Level index (0 = class, 1 = subclass, etc.)
 * @returns {boolean} - True if multi-select is supported
 */
function isMultiSelectLevel(fieldName, levelIndex = 0) {
  const schemaField = findSchemaField(fieldName);
  if (!schemaField?.levels) return false;
  const level = schemaField.levels[levelIndex];
  return level?.multiSelect === true;
}

function normalizeAgainstSchema(fieldName, value) {
  if (!value) return value;
  const schemaField = findSchemaField(fieldName);
  if (!schemaField?.levels) return value;
  for (const level of schemaField.levels) {
    if (!level?.options) continue;
    const match = level.options.find(o => lower(o) === lower(value));
    if (match) return match;
  }
  return value;
}

/**
 * Encode a value for URL, handling multi-select arrays with commas
 * @param {string|string[]} value - Single value or array of values
 * @param {string} fieldName - Field name for schema normalization
 * @returns {string} - URL-encoded value(s), comma-separated if array
 */
function encodeUrlValue(value, fieldName) {
  if (Array.isArray(value)) {
    return value
      .map(v => encodeURIComponent(normalizeAgainstSchema(fieldName, v)).replace(/%20/g, '+'))
      .join(',');
  }
  return encodeURIComponent(normalizeAgainstSchema(fieldName, value)).replace(/%20/g, '+');
}

/**
 * Check if value is empty or "Any"
 */
function isAnyOrEmpty(value) {
  if (!value) return true;
  if (Array.isArray(value)) return value.length === 0 || value.every(v => lower(v) === 'any');
  return lower(value) === 'any';
}

function buildUrlSegment(fieldName, cls, subclass) {
  const schemaField = findSchemaField(fieldName);
  const urlKey = schemaField?.urlKey;
  if (!urlKey) return null;

  const classIsAny = isAnyOrEmpty(cls);
  const subclassIsAny = isAnyOrEmpty(subclass);

  // If both class and subclass are "Any", nothing to filter
  if (classIsAny && subclassIsAny) return null;

  // If class is "Any" but subclass is specific, use just the subclass
  if (classIsAny && !subclassIsAny) {
    const subVal = encodeUrlValue(subclass, fieldName);
    return `${urlKey}:${subVal}`;
  }

  // Normal case: class is specific (can be array for multi-select)
  const classVal = encodeUrlValue(cls, fieldName);
  let segment = `${urlKey}:${classVal}`;

  if (!subclassIsAny) {
    const subVal = encodeUrlValue(subclass, fieldName);
    segment += `;${subVal}`;
  }
  return segment;
}

function dedupeAxes(axes) {
  const seen = new Set();
  const out = [];
  for (const a of axes) {
    const key = `${a.operator}::${a.field}::${a.class}::${a.subclass || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function extractGene(row) {
  if (!row || typeof row !== 'object') return null;
  return row.Gene || row.gene || row['Gene name'] || row['Gene'] || row.symbol || null;
}

function summarizeRows(rows) {
  const genes = [];
  for (const r of rows || []) {
    const g = extractGene(r);
    if (g) genes.push(g);
  }
  const uniq = Array.from(new Set(genes));
  return {
    count: uniq.length,
    top: uniq.slice(0, 10)
  };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// -----------------------------
// Path-Based Routing
// -----------------------------

/**
 * Category semantic purpose mapping
 * - "classification": describes WHAT the gene IS (function, type, class)
 * - "expression": describes WHERE/HOW the gene is expressed
 */
const CATEGORY_PURPOSE = {
  'GENE INFO': 'classification',
  'STRUCTURE & INTERACTION': 'classification',
  'PROTEIN EVIDENCE': 'classification',
  'TISSUE': 'expression',
  'BRAIN': 'expression',
  'SINGLE CELL': 'expression',
  'SUBCELLULAR': 'expression',
  'CANCER': 'expression',
  'CELL LINE': 'expression',
  'ANTIBODY VALIDATION': 'other',
  'EXTRA': 'other'
};




// -----------------------------
// LLM Wrapper + Stats
// -----------------------------
async function invokeLLM(sys, usr, onStep, label, stats) {
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: usr }
  ];

  if (LOG_LLM_IO && onStep) {
    await onStep({
      stage: 'planning_step',
      label: `LLM Request: ${label}`,
      message: `SYSTEM:\n${sys}\n\nUSER:\n${usr}`
    });
  }

  const res = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' }
  });

  const content = res.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(content); }
  catch (_) {
    // Attempt minimal recovery
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try { parsed = JSON.parse(content.slice(start, end + 1)); }
      catch (_) { parsed = {}; }
    }
  }

  if (LOG_LLM_IO && onStep) {
    await onStep({
      stage: 'planning_step',
      label: `LLM Response: ${label}`,
      message: `RAW:\n${content}\n\nPARSED:\n${JSON.stringify(parsed)}`
    });
  }

  const usage = res.usage || {};
  if (stats) {
    const p = usage.prompt_tokens || 0;
    const c = usage.completion_tokens || 0;
    stats.promptTokens += p;
    stats.completionTokens += c;
    stats.totalTokens += p + c;
    if (label) {
      stats.perStep[label] = stats.perStep[label] || { prompt: 0, completion: 0, total: 0 };
      stats.perStep[label].prompt += p;
      stats.perStep[label].completion += c;
      stats.perStep[label].total += p + c;
    }
  }

  return parsed;
}

function buildTokenReport(stats) {
  if (!stats) return null;
  const total = stats.totalTokens || 0;
  const perStep = Object.entries(stats.perStep)
    .map(([k, v]) => ({ step: k, total: v.total }))
    .sort((a, b) => b.total - a.total);

  const stepLines = perStep
    .map(s => `${s.step}: ${s.total} (${total ? ((s.total / total) * 100).toFixed(1) : '0'}%)`)
    .join(', ');

  return `Input tokens: ${stats.promptTokens} | Output tokens: ${stats.completionTokens} | Total: ${stats.totalTokens}\nTop steps: ${stepLines}`;
}

// -----------------------------
// Step 1: Parse Goal
// -----------------------------
async function parseGoalComponents(goal, onStep, stats) {
  const sys = `Parse the query into minimal components.
Return only what is explicitly stated.
If the subject is a generic placeholder and other components exist, set subject to null.
If the subject already encodes a location (e.g., "secreted in brain"), keep location null and include it in subject.

Words describing HOW something is expressed (e.g. specific, enriched, enhanced, elevated, highly expressed, detected, absent, group enriched) are qualifiers — put them in "qualifier", not in "subject" or "location".

When "markers" follows a cell type or tissue name (e.g. "B-cell markers", "cardiomyocyte markers", "stem cell markers"), it means genes enriched in that cell type — set location to the cell type, qualifier to "enriched", subject to null. "Markers" is not a protein class unless the user literally says "CD markers."

CRITICAL for cancer queries:
- "X cancer markers/genes/prognostic" → location is "X", location_type is "cancer", subject is "cancer markers/genes/prognostic"
- Examples:
  - "stomach cancer markers" → location: "stomach", location_type: "cancer", subject: "cancer markers"
  - "breast cancer prognostic genes" → location: "breast", location_type: "cancer", subject: "cancer prognostic genes"
  - "lung cancer biomarkers" → location: "lung", location_type: "cancer", subject: "cancer biomarkers"
- The organ/tissue before "cancer" is ALWAYS the location with location_type "cancer"`;

  const usr = `Query: "${goal}"

Return JSON:
{
  "subject": "<main thing or null>",
  "location": "<where or null>",
  "location_type": "tissue" | "cell_type" | "subcellular" | "cancer" | "other" | "none",
  "qualifier": "<how expressed or null>",
  "exclusion": "<exclude where or null>",
  "summary": "<one short sentence>"
}`;

  await onStep?.({ stage: 'planning_step', label: 'Parse Goal', message: 'Parsing query' });
  const result = await invokeLLM(sys, usr, onStep, 'Parse Goal', stats);
  if (result?.summary) {
    await onStep?.({ stage: 'reasoning_step', label: 'Understood', message: result.summary });
  }
  return result || {};
}

// -----------------------------
// Step 2: Plan Constraints
// -----------------------------
async function planConstraints(goal, parsedGoal, onStep, stats, rejectionContext = null) {
  const { subject, location, qualifier, exclusion, location_type } = parsedGoal || {};

  const rejectionNote = rejectionContext
    ? `\n\nIMPORTANT - PREVIOUS ATTEMPTS FAILED:\n${rejectionContext}\nDo NOT repeat the same fields or classes that failed. Try a DIFFERENT category or field entirely. For example, if Protein class failed for a concept, try Uniprot keyword instead. If a tissue field gave wrong subclasses, try a different tissue field. Generate new synonyms that might match different parts of the schema.`
    : '';

const sys = `Create a short ordered plan to satisfy the query.
- If both subject and location exist, create separate items for each.
- Attach qualifier to the location unless the qualifier clearly modifies the subject.
- Include each non-null component: subject, location, exclusion.
- Order: subject first, location second, exclusion last (if present).
- Use operator "AND" or "NOT".

CRITICAL for "not expressed/detected/found in X" patterns:
- When the goal says "not expressed in X", "not detected in X", "absent in X", "not in X"
- This is a LOCATION constraint, NOT an exclusion
- Use: { component: "location", intent: "X", qualifier: "not detected", operator: "AND" }
- The "not detected" qualifier will select "Not detected" subclass
- Do NOT use operator "NOT" for these patterns

CRITICAL for MULTIPLE LOCATIONS:
- Queries like "X-enriched proteins not in Y" have TWO locations:
  1. Location X with qualifier "enriched" → { component: "location", intent: "X", qualifier: "enriched", operator: "AND" }
  2. Location Y with qualifier "not detected" → { component: "location", intent: "Y", qualifier: "not detected", operator: "AND" }
- Create SEPARATE plan items for each location. Do not merge them.
- Example: "brain enriched proteins not in liver" →
  [
    { component: "location", intent: "brain", qualifier: "enriched", operator: "AND" },
    { component: "location", intent: "liver", qualifier: "not detected", operator: "AND" }
  ]

CRITICAL for "NOT ENRICHED in X" patterns:
- "not enriched in X" is DIFFERENT from "not detected in X"
  - "not detected" = zero expression
  - "not enriched" = may be expressed but not at enriched level
- For "not enriched in X": use { component: "exclusion", intent: "X", qualifier: "enriched", operator: "NOT" }
  This EXCLUDES genes that ARE enriched in X, but keeps genes with low/moderate expression there.
- For "not detected in X" / "absent from X" / "not in X": use qualifier "not detected", operator "AND"
  This requires zero expression.
- Example: "enriched in heart but not enriched in liver" →
  [
    { component: "location", intent: "heart", qualifier: "enriched", operator: "AND" },
    { component: "exclusion", intent: "liver", qualifier: "enriched", operator: "NOT" }
  ]
CRITICAL for CANCER queries:
- Queries like "X cancer markers/prognostic" → the cancer type already encodes the location
- Do NOT create a separate location item for cancer queries
- For PROGNOSTIC queries ("prognostic markers in X cancer"), INCLUDE the organ/cancer name in the intent so the trail can match the specific cancer type. Cancer databases use formal names like "Liver Hepatocellular Carcinoma" not "liver cancer" — include the organ name and the trail will find the matching formal name via token overlap.
  Example: "prognostic markers in testis cancer" →
  [
    { component: "subject", intent: "testis cancer prognostic", qualifier: "prognostic", operator: "AND", synonyms: ["testicular", "germ cell"] }
  ]
  Example: "prognostic markers in endometrial cancer" →
  [
    { component: "subject", intent: "endometrial cancer prognostic", qualifier: "prognostic", operator: "AND", synonyms: ["uterine", "endometrial", "corpus"] }
  ]
- Do NOT use generic intents like "cancer prognostic markers" — this loses the specific cancer type and the trail cannot narrow to the right one.
- Do NOT add: { component: "location", intent: "testis", ... } — the cancer type in the intent handles the location.
- Keep plan_summary to one sentence.
- PRESERVE the user's exact qualifier wording. If they say "group enriched", the qualifier must be "group enriched" — not just "enriched". If they say "detected in single", the qualifier must be "detected in single" — not "enriched". Do not normalize or simplify qualifiers.
- If the subject is already a known protein class name (e.g. "plasma proteins", "FDA approved drug targets", "ribosomal proteins"), keep it as a SINGLE subject item with the full name as intent. Do NOT split it into subject + location.
- Do NOT add extra axes beyond what the user asked for. If the user says "prognostic markers in colorectal cancer", that's ONE subject axis for prognostic + cancer type. Do NOT add cell line or tissue axes unless the user explicitly asked.${rejectionNote}

CRITICAL for "not secreted to X" patterns:
- "not secreted to blood", "not secreted to ECM", etc.
- These are TRUE EXCLUSIONS requiring NOT operator
- Use: { component: "exclusion", intent: "Secreted to blood", operator: "NOT" }
- "Secreted to blood" is an exact class name in Secretome annotation - use it directly as the intent
- Do NOT use "blood" as location with "not secreted" qualifier - that doesn't work

CRITICAL for "absent from blood" / "not in blood" / "not found in blood":
- HPA does NOT have "blood" as a tissue category - there is no tissue_category_rna:blood filter!
- Instead, treat these as "not secreted to blood" → { component: "exclusion", intent: "Secreted to blood", operator: "NOT" }
- This uses the Secretome annotation field which DOES have "Secreted to blood" as a class

"not expressed in X" vs "not secreted to X":
- "not expressed in brain" → location: brain, qualifier: "not detected", operator: AND (uses "Not detected" subclass)
- "not secreted to blood" → exclusion: "Secreted to blood", operator: NOT (excludes the entire class)
- "absent from blood" → SAME as "not secreted to blood" (blood is not a tissue in HPA)

CRITICAL for COMPOUND SUBJECTS:
- When a query combines a MODIFIER with a SPECIFIC protein type, these are TWO separate protein classes that must be ANDed:
  Modifiers: "FDA approved", "cancer-related", "disease related", "metabolic", "predicted secreted", "predicted membrane"
  Specific types: "kinases", "enzymes", "transporters", "membrane proteins", "secreted proteins", etc.
- Create SEPARATE subject items for each - they will be ANDed together:
  Example: "FDA approved kinases" →
  [
    { component: "subject", intent: "kinases", qualifier: null, operator: "AND" },
    { component: "subject", intent: "FDA approved drug targets", qualifier: null, operator: "AND" }
  ]
  Example: "cancer-related transporters" →
  [
    { component: "subject", intent: "transporters", qualifier: null, operator: "AND" },
    { component: "subject", intent: "cancer-related genes", qualifier: null, operator: "AND" }
  ]
  Example: "metabolic enzymes" →
  [
    { component: "subject", intent: "enzymes", qualifier: null, operator: "AND" },
    { component: "subject", intent: "metabolic proteins", qualifier: null, operator: "AND" }
  ]
  Example: "FDA approved membrane proteins" →
  [
    { component: "subject", intent: "predicted membrane proteins", qualifier: null, operator: "AND" },
    { component: "subject", intent: "FDA approved drug targets", qualifier: null, operator: "AND" }
  ]
- Do NOT combine into one item like "FDA approved kinases" - this cannot be matched to a single class
- The intersection of both classes gives exactly what the user wants

SYNONYM EXPANSION (critical for matching):
For each plan item, add a "synonyms" array of specific biological terms that a protein/gene atlas database would list as class names.

Cell type terms — expand to specific cell type names:
- "germ cells" → ["spermatogenic cell types", "oocytes"] (use group-level names when available, not individual subtypes)
- "immune cells" → ["T-cells", "B-cells", "NK-cells", "macrophages", "dendritic cells", "monocytes", "granulocytes"]
- "glial cells" / "glia" → ["glial cells"] (group-level name exists in atlas)
- "stem cells" → ["stem cells"] (group-level name exists)
- "endothelial cells" → ["endothelial cells"]
- "neurons" / "neuronal cells" → ["neuronal cells"] (group-level name exists)
- "myocytes" / "muscle cells" → ["myocytes"] (group-level name exists)
When a group-level name exists in the atlas (e.g. "Glial cells", "Stem cells", "Neuronal cells", "Myocytes"), use that instead of expanding to individual subtypes.

Tissue terms — expand to atlas-style names:
- "heart" → ["heart muscle"] (atlas uses "heart muscle" not "heart")
- "liver" → ["liver"] (already specific)
- For tissues that may not exist as individual entries in RNA data, ALWAYS include the broader RNA parent category as a synonym. Common groupings in RNA:
  - "intestine" covers colon, small intestine, rectum, duodenum
  - "lymphoid tissue" covers thymus, spleen, appendix, tonsil, lymph node
  If the query mentions one of these sub-tissues, include the parent as a synonym so RNA-based paths can match.
  Example: "thymus" → synonyms: ["thymus", "lymphoid tissue"]
  Example: "colon" → synonyms: ["colon", "intestine"]
Brain region terms — these are in the BRAIN category, not TISSUE:
- "hippocampus" → ["hippocampal formation"] (HPA uses "hippocampal formation")
- "cerebellum" → ["cerebellum"] (brain region)
- "cerebral cortex" → ["cerebral cortex"] (brain region)

Qualifier normalization — also provide qualifier_synonyms when the qualifier could be expressed differently:
- "specific" / "specific to" → qualifier_synonyms: ["enriched", "tissue enriched", "cell type enriched"]
- "highly expressed" → qualifier_synonyms: ["is highest expressed"]
- "absent" / "absent from" → qualifier_synonyms: ["not detected"]
- "expressed in" / "expressed" → qualifier_synonyms: ["detected"] (means present at ANY level, not just highest)
- "detected in" / "detected" / "found in" → qualifier_synonyms: ["detected"]
- "elevated" → qualifier_synonyms: ["cell type enriched", "group enriched", "cell type enhanced"] (elevated = all three in HPA)
- "group enriched" → qualifier_synonyms: ["group enriched"] (exact HPA subclass name)
- "enriched" → qualifier_synonyms: [] (already standard)

IMPORTANT: "expressed in X" means the gene is PRESENT in X at any level — NOT that X is where it's highest.
"Is highest expressed" means X is the SINGLE tissue with peak expression. These are very different.
Only use "is highest expressed" when the user explicitly says "highest" or "most expressed".

CRITICAL: If the query asks for "markers" or "marker genes" for a cell type or tissue (e.g. "cardiomyocyte markers", "stem cell markers", "endothelial cell markers"), this implies enrichment:
- Treat "X markers" as: location = "X", qualifier = "enriched". The subject "markers" is generic and should be skipped.
- Do NOT interpret "markers" as the "CD markers" protein class. "CD markers" is only used when the user literally says "CD markers".
- Examples: "stem cell markers" → location: "stem cells", qualifier: "enriched"
            "endothelial cell markers" → location: "endothelial cells", qualifier: "enriched"
            "cardiomyocyte markers" → location: "cardiomyocyte", qualifier: "enriched"

CRITICAL: "not found in X" / "not in X" / "absent from X" refers to tissue/cell EXPRESSION, not secretome.
- Use tissue_category_rna with "Not detected" subclass, NOT secretome annotation.
- Secretome annotation (sa_location) is ONLY for "not secreted to X" — when the user explicitly says "secreted".

HPA SEMANTIC CONVENTIONS — the subclass names encode universal meanings:
- "Detected in all" on ANY tissue means detected in ALL 37 tissues. You only need ONE tissue axis.
  Example: "genes detected in all tissues" → { intent: "liver" (or any tissue), qualifier: "detected in all" }
  Do NOT enumerate multiple tissues.
- "Not detected" on ANY tissue means zero RNA expression in that tissue. ONE tissue axis is enough.
  Example: "genes not detected in any tissue" → This is not directly expressible. The closest is "Not detected" on a representative tissue.
- "Tissue enriched" means >=4x higher in ONE tissue vs all others. It already encodes "specific to" / "only in".
  Example: "genes only found in placenta" → { intent: "placenta", qualifier: "enriched" }
  Do NOT add exclusion axes for all other tissues. "Tissue enriched" already means that.
- Brain regions (hippocampus, cerebellum, cerebral cortex, etc.) are in the BRAIN category, not TISSUE.
  Use brain_category_rna for brain regions, not tissue_category_rna or normal_expression (IHC).
  Example: "expressed in hippocampus" → { intent: "hippocampus", qualifier: "detected" } using brain_category_rna

Only expand when the term is a broad category. Do NOT expand terms already specific enough.
Do NOT expand specific cell type names into umbrella synonyms — "oligodendrocytes" → ["oligodendrocytes"], NOT ["astrocytes", "microglial cells", ...].

CRITICAL for SUBCELLULAR LOCATION modifiers:
- When query has "X proteins" where X is a subcellular compartment (cytosol, mitochondrial, nuclear, golgi, endoplasmic reticulum, plasma membrane, vesicle, centrosome, nucleolus, peroxisome, lysosome, actin filament, intermediate filament, cell junction, lipid droplet, nuclear speckle, cell projection, kinetochore, aggresome, rods and rings, focal adhesion, centriolar satellite, nuclear membrane, cytoplasmic body), create a SEPARATE plan item:
  { component: "subcellular", intent: "<compartment name>", qualifier: null, operator: "AND" }
- This is separate from the subject and location items.
- Example: "mitochondrial kinases enriched in heart" →
  [
    { component: "subject", intent: "kinases", operator: "AND" },
    { component: "subcellular", intent: "mitochondria", operator: "AND" },
    { component: "location", intent: "heart", qualifier: "enriched", operator: "AND" }
  ]
- Example: "cytosol proteins enriched in liver not secreted to blood" →
  [
    { component: "subcellular", intent: "cytosol", operator: "AND" },
    { component: "location", intent: "liver", qualifier: "enriched", operator: "AND" },
    { component: "exclusion", intent: "Secreted to blood", operator: "NOT" }
  ]
- Example: "mitochondrial kinases enriched in heart" →
  [
    { component: "subject", intent: "kinases", operator: "AND" },
    { component: "subcellular", intent: "mitochondria", operator: "AND" },
    { component: "location", intent: "heart", qualifier: "enriched", operator: "AND" }
  ]
- Example: "nuclear proteins enriched in testis" →
  [
    { component: "subcellular", intent: "nucleoplasm", operator: "AND" },
    { component: "location", intent: "testis", qualifier: "enriched", operator: "AND" }
  ]
- DO NOT prefix subcellular intents with "predicted" — use the actual compartment name (mitochondria, nucleoplasm, cytosol, golgi apparatus, endoplasmic reticulum, plasma membrane, vesicles, etc.)
- The "proteins"/"genes" subject is generic and will be skipped — the subcellular item provides the filtering.
`;




  const usr = `GOAL: "${goal}"

Parsed components:
- subject: ${subject || 'null'}
- location: ${location || 'null'}
- location_type: ${location_type || 'null'}
- qualifier: ${qualifier || 'null'}
- exclusion: ${exclusion || 'null'}

Return JSON:
{
  "plan_summary": "<one short sentence>",
  "plan": [
    {
      "component": "subject" | "location" | "exclusion" | "subcellular",
      "intent": "<what to cover>",
      "qualifier": "<qualifier or null>",
      "operator": "AND" | "NOT",
      "synonyms": ["<specific term 1>", "<specific term 2>", ...] or [],
      "qualifier_synonyms": ["<alt qualifier>", ...] or []
    }
  ]
}`;

  await onStep?.({ stage: 'planning_step', label: 'Plan', message: 'Creating plan' });
  const result = await invokeLLM(sys, usr, onStep, 'Plan', stats);
  if (result?.plan_summary) {
    await onStep?.({ stage: 'planning_step', label: 'Plan', message: result.plan_summary });
  }

  // Minimal validation: ensure plan is non-empty
  const plan = Array.isArray(result?.plan) ? result.plan : [];
  if (!plan.length) return [];
  return plan;
}

// -----------------------------
// Generic Subject Detection
// -----------------------------
// These are too broad to meaningfully filter - skip axis creation for these
const GENERIC_SUBJECTS = new Set([
  'genes', 'gene', 'proteins', 'protein', 'all genes', 'all proteins',
  'markers', 'marker', 'any', 'everything', 'all'
]);

function isGenericSubject(term, componentType) {
  if (componentType !== 'subject') return false;
  const normalized = lower(term).trim();
  return GENERIC_SUBJECTS.has(normalized);
}

// ============================================================
// Trail-based navigation — scores all paths up front, then
// auto-selects or presents candidates to LLM in one call.
// Replaces the step-by-step category→field→class cascade.
// ============================================================

let _trailPathCache = null;

/**
 * Flatten the schema into class-level paths for trail scoring.
 * Each entry is { category, field, cls }.  Cached after first call.
 */
function flattenClassPaths() {
  if (_trailPathCache) return _trailPathCache;
  const paths = [];
  for (const [cat, fields] of Object.entries(detailedSearchOptions)) {
    for (const [field, classes] of Object.entries(fields)) {
      for (const [cls] of Object.entries(classes)) {
        if (lower(cls) === 'any') continue;
        paths.push({ category: cat, field, cls });
      }
    }
  }
  _trailPathCache = paths;
  return paths;
}

/**
 * Score every class-level path against the intent tokens.
 * Returns sorted array (best first) with { category, field, cls, score, exact }.
 */
function trailScorePaths(paths, tokens, intent, componentType, qualifier = null, synonyms = [], qualifierSynonyms = []) {
  const EXACT_BONUS = 50;
  const PURPOSE_BOOST = 3;
  const QUAL_BOOST = 5;
  const boostPurpose = componentType === 'subject' ? 'classification' :
    (componentType === 'location' || componentType === 'exclusion') ? 'expression' : null;
  // Include qualifier synonyms in qual token matching
  const allQualTerms = [qualifier, ...qualifierSynonyms].filter(Boolean);
  const qualTokens = allQualTerms.flatMap(q => tokenize(q));

  // Build expanded token list: original tokens + all synonym tokens
  const synTokens = synonyms.flatMap(s => tokenize(s));
  const allTokens = [...new Set([...tokens, ...synTokens])];
  const synLower = new Set(synonyms.map(s => lower(s)));

  return paths.map(p => {
    // Include subclass names in scoring so "kinases" matches Enzymes (via Kinases subclass)
    const subs = detailedSearchOptions[p.category]?.[p.field]?.[p.cls];
    const subNames = Array.isArray(subs) ? subs.filter(s => lower(s) !== 'any').join(' ') : Object.keys(subs || {}).filter(s => lower(s) !== 'any').join(' ');
    const textScore = scoreText(allTokens, p.cls + ' ' + p.field + ' ' + subNames);
    const exact = lower(p.cls) === lower(intent) || synLower.has(lower(p.cls));
    const catPurpose = CATEGORY_PURPOSE[p.category] || 'other';
    const isSpecialised = catPurpose === 'expression' &&
      (p.category === 'CANCER' || p.category === 'CELL LINE');
    const purposeMatch = boostPurpose && catPurpose === boostPurpose && !isSpecialised;
    let qualBoost = 0;
    if (qualTokens.length > 0) {
      const subs = detailedSearchOptions[p.category]?.[p.field]?.[p.cls];
      const subList = Array.isArray(subs) ? subs : Object.keys(subs || {});
      for (const sub of subList) {
        if (scoreText(qualTokens, sub) > 0) { qualBoost = QUAL_BOOST; break; }
      }
    }
    return {
      ...p,
      score: textScore + (exact ? EXACT_BONUS : 0) + (purposeMatch ? PURPOSE_BOOST : 0) + qualBoost,
      exact
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Pick the top candidates for LLM presentation, capped per category
 * so the list has diversity across TISSUE / SINGLE CELL / etc.
 */
function selectTrailCandidates(scored, maxCandidates = 120) {
  // Ensure every category gets representation — no category dominates
  const candidates = [];
  const catCounts = {};
  const MAX_PER_CAT = 25;
  for (const p of scored) {
    catCounts[p.category] = (catCounts[p.category] || 0);
    if (catCounts[p.category] >= MAX_PER_CAT) continue;
    candidates.push(p);
    catCounts[p.category]++;
    if (candidates.length >= maxCandidates) break;
  }
  return candidates;
}

/**
 * Trail-based navigation.  Scores all class-level paths, auto-selects
 * if there's a clear winner, otherwise presents top candidates to the
 * LLM in a single call.  Then selects subclass (qualifier-driven).
 *
 * Returns the same shape as navigateWithScores:
 *   { category, field, class, subclass, score, display, note }
 */
async function navigateTrail(tokens, intent, componentType, onStep, stats, qualifier = null, parsedGoal = null, failedPaths = [], synonyms = [], qualifierSynonyms = []) {
  const EXACT_MATCH_BONUS = 50;

  // --- 1. Score every class-level path (synonyms + boosters) ---
  const allPaths = flattenClassPaths();
  const scored = trailScorePaths(allPaths, tokens, intent, componentType, qualifier, synonyms, qualifierSynonyms);

  const top = scored[0];
  const second = scored[1];
  // Don't auto-select if multiple paths have exact matches — let the LLM pick all relevant ones
  const exactCount = scored.filter(p => p.exact).length;
  const multipleExactMatches = exactCount > 1;
  let category, field, cls;
  let partialMatchNote = null;

  // --- Always present candidates to LLM — no auto-select ---
  {
    const candidates = selectTrailCandidates(scored);
    const catSummary = [...new Set(candidates.map(c => c.category))].join(', ');
    console.log(`[NAV-TRAIL] Ambiguous (top=${top?.score}). ${candidates.length} candidates across: ${catSummary}`);
    await onStep?.({ stage: 'reasoning_step', label: 'Trail', message: `Evaluating ${candidates.length} paths across ${catSummary}` });

    const failedNote = failedPaths.length > 0
      ? `\n\nPREVIOUS FAILED — do NOT repeat these paths or fields:\n${failedPaths.map(f => `- Paths: ${f.paths.join(', ')}\n  Fields tried: ${(f.fields || []).join(', ')}\n  Reason: ${f.reason}`).join('\n')}\nYou MUST pick a DIFFERENT field or category than the ones listed above.`
      : '';

    // Build candidate list with subclass previews — this is the key context
    // that lets the LLM reason about which path fits the query
    const candidateList = candidates.map((c, i) => {
      const subs = detailedSearchOptions[c.category]?.[c.field]?.[c.cls];
      const subList = Array.isArray(subs) ? subs : Object.keys(subs || {});
      const filtered = subList.filter(s => lower(s) !== 'any');
      const preview = filtered.length > 15
        ? filtered.slice(0, 15).join(', ') + ', ...'
        : filtered.join(', ');
      const subNote = preview ? `  [subs: ${preview}]` : '';
      return `${i + 1}. ${c.category} > ${c.field} > ${c.cls}${subNote}`;
    }).join('\n');

    const result = await invokeLLM(
      `Pick ONLY the path(s) that match "${intent}"${qualifier ? ` (qualifier: ${qualifier})` : ''} for a ${componentType || 'filter'} component.

Each path shows: category > field > class [subs: available subclasses].
The subclasses shown are what you will choose from AFTER picking a path, so consider them.

The current term may be broader than the original goal. Always check the original goal to understand what the user actually wants.
If the candidates are specific items (e.g. individual cancer types, individual tissues) and the original goal mentions a specific one, select ONLY the ones matching the goal — not all of them.
Multiple classes in the same field are combined with OR — only multi-select when the user's intent genuinely spans multiple classes.

CRITICAL: You are picking paths for the CURRENT TERM only. Other parts of the query (exclusions, other locations) are handled by separate parallel calls. Do NOT select classes for exclusions or other locations here — only for the current term. If the current term is "testis" and the goal says "not in liver", do NOT select liver here. Liver will be handled by its own trail call.

When multiple fields cover the same tissue/region, prefer RNA-based fields (Tissue category RNA, Brain category RNA, Cell type category RNA) over IHC-based fields (Tissue expression IHC, normal_expression). IHC requires cell-type subclasses and is for protein-level questions about specific cell types within a tissue. RNA is the default for general expression queries.

CRITICAL: Check the qualifier against available subclasses before picking a path. If the qualifier is "not detected" or "enriched", the path's subclasses MUST include a matching option (e.g., "Not detected", "Tissue enriched"). IHC paths only have cell type subclasses (e.g., "cortical cells", "hepatocytes") — they do NOT have "Not detected" or "Enriched". So for exclusion/detection queries, prefer RNA paths even if IHC has a more exact tissue name match.

For brain regions, prefer human Brain region category (RNA) over Mouse brain or Pig brain categories unless the user specifically asks about mouse or pig data.${failedNote}`,
      `Original goal: "${parsedGoal?.summary || intent}"\nCurrent term: "${intent}"\n\nCandidate paths:\n${candidateList}\n\nReturn JSON: { "picks": [<number>, ...], "why": "<short>" }`,
      onStep, 'Trail Pick', stats
    );

    const picks = (result?.picks || [])
      .filter(n => typeof n === 'number' && n >= 1 && n <= candidates.length);
    if (picks.length === 0) {
      await onStep?.({ stage: 'planning_step', label: 'Trail Failed', message: 'No valid path selected' });
      return null;
    }

    let chosen = picks.map(n => candidates[n - 1]);

    // RC1 fix: If the top pick's class doesn't match the intent AND the chosen field's
    // subclasses also don't contain the intent, try next candidates.
    // This prevents substituting wrong tissues (e.g., thymus→adipose) when IHC has the right one.
    // BUT: if the chosen class is a PARENT whose subclasses contain the intent (e.g., Enzymes→Kinases),
    // that's correct — the subclass selection step will narrow it.
    const intentLower = lower(intent);
    const synLowerSet = new Set(synonyms.map(s => lower(s)));
    const isExactOrSynMatch = (c) => {
      const clsLower = lower(c.cls);
      if (clsLower === intentLower || synLowerSet.has(clsLower)) return true;
      if (tokenize(intent).some(t => tokenize(c.cls).includes(t))) return true;
      // Check if the class's subclasses contain the intent (parent class match)
      const subs = detailedSearchOptions[c.category]?.[c.field]?.[c.cls];
      const subNames = Array.isArray(subs) ? subs : Object.keys(subs || {});
      if (subNames.some(s => lower(s) === intentLower || synLowerSet.has(lower(s)) ||
          tokenize(intent).some(t => tokenize(s).includes(t)))) return true;
      return false;
    };
    if (chosen.length === 1 && !isExactOrSynMatch(chosen[0])) {
      const betterCandidate = candidates.find(c =>
        c !== chosen[0] && isExactOrSynMatch(c) &&
        detailedSearchOptions[c.category]?.[c.field]?.[c.cls]
      );
      if (betterCandidate) {
        console.log(`[NAV-TRAIL] RC1 fallback: "${chosen[0].cls}" doesn't match "${intent}", using "${betterCandidate.cls}" from ${betterCandidate.field}`);
        chosen = [betterCandidate];
      }
    }

    category = chosen[0].category;
    field = chosen[0].field;

    // Collect classes — array when multiple from same field + multi-select ok
    const sameField = chosen.every(c => c.category === category && c.field === field);
    if (sameField && chosen.length > 1) {
      cls = isMultiSelectLevel(field, 0) ? chosen.map(c => c.cls) : chosen[0].cls;
    } else {
      cls = chosen[0].cls;
    }

    // Validate against schema
    if (Array.isArray(cls)) {
      cls = cls.filter(c => detailedSearchOptions[category]?.[field]?.[c]);
      if (cls.length === 0) return null;
      if (cls.length === 1) cls = cls[0];
    } else if (!detailedSearchOptions[category]?.[field]?.[cls]) {
      return null;
    }

    // Partial-match note for the validator
    const primaryCls = Array.isArray(cls) ? cls[0] : cls;
    const clsToks = new Set(tokenize(primaryCls));
    const intToks = tokenize(intent);
    const overlap = intToks.filter(t =>
      clsToks.has(t) || [...clsToks].some(ct => ct.includes(t) || t.includes(ct)));
    const isExactMatch = lower(primaryCls) === lower(intent);
    if (!isExactMatch && !Array.isArray(cls)) {
      partialMatchNote = `No exact "${intent}" class exists in the HPA schema — "${primaryCls}" is the closest available match. This is the BEST option from the finite set of available classes.`;
    } else if (Array.isArray(cls)) {
      partialMatchNote = `Multiple classes selected to cover "${intent}": ${cls.join(', ')}`;
    }
  }

  // --- Emit Options → Selection pairs (frontend renders pills + highlight) ---
  // Category
  const topCats = [...new Set(scored.slice(0, 50).map(p => p.category))];
  await onStep?.({ stage: 'reasoning_step', label: 'Category Options', message: topCats.join(', ') });
  await onStep?.({ stage: 'selection_step', label: 'Category', message: category });
  // Field
  const topFields = [...new Set(scored.filter(p => p.category === category).slice(0, 30).map(p => p.field))];
  await onStep?.({ stage: 'reasoning_step', label: 'Field Options', message: topFields.join(', ') });
  await onStep?.({ stage: 'selection_step', label: 'Field', message: field });
  // Class
  const topClasses = scored.filter(p => p.category === category && p.field === field).map(p => p.cls);
  await onStep?.({ stage: 'reasoning_step', label: 'Class Options', message: topClasses.join(', ') });
  const clsDisplayMsg = Array.isArray(cls) ? cls.join(', ') : cls;
  await onStep?.({ stage: 'selection_step', label: 'Class', message: clsDisplayMsg });

  // --- 3. SUBCLASS SELECTION (qualifier-driven, same logic as original) ---
  let subclass = null;
  const classIsAny = typeof cls === 'string' && lower(cls) === 'any';

  // For multi-class arrays, use the first class to determine subclass options
  // (within a field, all classes share the same subclass schema)
  const clsForSubclass = Array.isArray(cls) ? cls[0] : cls;
  if (clsForSubclass) {
    const subclasses = detailedSearchOptions[category][field][clsForSubclass];
    const subList = Array.isArray(subclasses) ? subclasses : Object.keys(subclasses || {});
    const filteredSubs = subList.filter(s => lower(s) !== 'any');

    if (filteredSubs.length > 0) {
      const allQualTerms = [qualifier, ...qualifierSynonyms].filter(Boolean);
      const qualifierTokens = allQualTerms.flatMap(q => tokenize(q));
      const allTokens = [...tokens, ...qualifierTokens];
      const subScores = filteredSubs.map(s => {
        // Use exact token matching for subclasses (no prefix/stem matching)
        const subTokens = new Set(tokenize(s));
        let baseScore = 0;
        for (const t of allTokens) if (subTokens.has(t)) baseScore++;
        const isExact = lower(s) === lower(intent);
        return { name: s, score: baseScore + (isExact ? EXACT_MATCH_BONUS : 0), exactMatch: isExact };
      });
      subScores.sort((a, b) => b.score - a.score);

      console.log(`[NAV-TRAIL] Subclass scoring for "${clsForSubclass}": ${subScores.slice(0, 5).map(s => `${s.name}(${s.score})`).join(', ')}`);

      // Always let LLM pick subclass — no auto-select
      {
        // LLM call for subclass
        const isExclusion = componentType === 'exclusion';
        let qualifierNote = '';
        let nullOption = '';

        if (isExclusion && qualifier) {
          qualifierNote = `\nThis is for an EXCLUSION (NOT) query with qualifier "${qualifier}". The NOT operator will EXCLUDE genes matching this subclass. Pick the subclass that matches the qualifier — e.g. if qualifier is "enriched", pick "Tissue enriched" so NOT excludes enriched genes.`;
          nullOption = `You MUST pick a subclass matching "${qualifier}".`;
        } else if (isExclusion) {
          qualifierNote = `\nThis is for an EXCLUSION (NOT) query. Pick subclasses that indicate the gene IS expressed/detected (like "Detected in all", "Detected in many", "Detected in some"). The NOT operator will then exclude those.`;
          nullOption = 'You MUST pick a subclass. For exclusions, pick detection-related subclasses.';
        } else if (qualifier) {
          qualifierNote = `\nThe user specified qualifier "${qualifier}". Pick the subclass(es) that match. "enriched" = Cell type enriched or Tissue enriched (one subclass). "elevated" = Cell type enriched + Group enriched + Cell type enhanced (multiple). "group enriched" = Group enriched. Match the qualifier precisely.`;
          nullOption = `You MUST pick a subclass matching "${qualifier}".`;
        } else if (classIsAny) {
          nullOption = 'You MUST pick a subclass.';
        } else {
          nullOption = 'Or null if the class alone is sufficient.';
        }

        const subMultiSelect = isMultiSelectLevel(field, 1);
        const subMultiNote = subMultiSelect
          ? '\nThis level supports MULTI-SELECT — you can return an array of subclasses if multiple apply.'
          : '';
        const subResponseFormat = subMultiSelect
          ? `{ "subclass": "<name${classIsAny || isExclusion ? '' : ' or null'}>" OR "subclasses": ["<name>", ...], "why": "<short>" }`
          : `{ "subclass": "<subclass name${(classIsAny || qualifier || isExclusion) ? '' : ' or null'}>", "why": "<short>" }`;

        const subListFormatted = subScores.map((s, i) => `${i + 1}. ${s.name} (score: ${s.score})`).join('\n');
        const subResult = await invokeLLM(
          `Pick the subclass that matches "${intent}". ${nullOption}${qualifierNote}
Higher scores mean better token match. Use your knowledge if scores are 0.${subMultiNote}`,
          `Original goal: "${parsedGoal?.summary || intent}"\nTerm: "${intent}"${qualifier ? `\nQualifier: "${qualifier}"` : ''}${isExclusion ? '\nComponent: EXCLUSION (NOT query)' : ''}\nClass: ${clsForSubclass}${Array.isArray(cls) && cls.length > 1 ? `\nNote: Multiple classes selected: ${cls.join(', ')}. Picking a subclass will filter ALL classes — return null if the classes have different subclass schemas.` : ''}\n\nSubclasses:\n${subListFormatted}\n\nReturn JSON: ${subResponseFormat}`,
          onStep, 'Pick Subclass', stats
        );
        console.log(`[NAV-TRAIL] Subclass pick: ${JSON.stringify(subResult?.subclass || subResult?.subclasses)} — "${subResult?.why || ''}"`);

        subclass = subResult?.subclass || subResult?.subclasses;
        if (Array.isArray(subclass) && subclass.length === 1) subclass = subclass[0];

        if (subclass) {
          const subDisplay = Array.isArray(subclass) ? subclass.join(', ') : subclass;
          const topSubs = subScores.map(s => s.name);
          await onStep?.({ stage: 'reasoning_step', label: 'Subclass Options', message: topSubs.join(', ') });
          await onStep?.({ stage: 'selection_step', label: 'Subclass', message: subDisplay });
        }

          }
    }
  }

  // --- 4. Build return path ---
  const clsDisplay = Array.isArray(cls) ? cls.join(', ') : cls;
  const subDisplay = Array.isArray(subclass) ? subclass.join(', ') : subclass;
  const path = {
    category,
    field,
    class: cls,
    subclass: subclass || null,
    score: 0,
    display: `[${category}] ${field} → ${clsDisplay}${subDisplay ? ` → ${subDisplay}` : ''}`,
    note: partialMatchNote
  };

  if (partialMatchNote) {
    await onStep?.({ stage: 'reasoning_step', label: 'Note', message: partialMatchNote });
  }
  await onStep?.({ stage: 'execution_step', label: 'Path', message: path.display });
  return path;
}

// -----------------------------
// Step 3: Path-Based Axis Building
// -----------------------------

async function buildAxisForPlanItem(item, onStep, stats, parsedGoal = null, failedPaths = []) {
  const term = item?.intent || '';
  const qualifier = item?.qualifier || null; // e.g., "enriched", "enhanced", "not detected"
  // Only tokenize the term - qualifier is for expression level (enriched/enhanced), not path matching
  const tokens = tokenize(term).filter(Boolean);
  const operator = item?.operator || 'AND';
  const componentType = item?.component || null; // "subject", "location", or "exclusion"
  const synonyms = Array.isArray(item?.synonyms) ? item.synonyms.filter(Boolean) : [];
  const qualifierSynonyms = Array.isArray(item?.qualifier_synonyms) ? item.qualifier_synonyms.filter(Boolean) : [];

  // Skip generic subjects - they don't add meaningful filtering
  if (isGenericSubject(term, componentType)) {
    await onStep?.({ stage: 'reasoning_step', label: 'Skip Generic', message: `"${term}" is too generic - location alone is sufficient` });
    return null;
  }

  // RC2: subcellular componentType goes through normal trail navigation
  // The trail already has all SUBCELLULAR paths scored — no special routing needed

  if (!tokens.length) {
    await onStep?.({ stage: 'planning_step', label: 'No Tokens', message: `No searchable tokens for "${term}"` });
    return null;
  }

  await onStep?.({ stage: 'planning_step', label: 'Navigate', message: `Finding path for "${term}" (${componentType})${qualifier ? ` [qualifier: ${qualifier}]` : ''}` });

  // Trail-based navigation: score all paths up front, auto-select or LLM pick
  if (synonyms.length > 0) {
    await onStep?.({ stage: 'reasoning_step', label: 'Synonyms', message: synonyms.join(', ') });
  }
const chosen = await navigateTrail(tokens, term, componentType, onStep, stats, qualifier, parsedGoal, failedPaths, synonyms, qualifierSynonyms);

  if (!chosen) {
    await onStep?.({ stage: 'planning_step', label: 'No Path Found', message: `Could not find path for "${term}"` });
    return null;
  }

  const axis = {
    operator,
    category: chosen.category,
    field: chosen.field,
    class: chosen.class,
    subclass: chosen.subclass || 'Any',
    note: chosen.note || null // Pass through note for validator
  };

  await onStep?.({
    stage: 'planning_step',
    label: 'Axis Built',
    message: `${axis.operator} ${axis.field}: ${formatSubclass(axis.class)}${!isSubclassEmpty(axis.subclass) ? `;${formatSubclass(axis.subclass)}` : ''}`
  });

  return axis;
}

// -----------------------------
// Validation (Goal vs URL)
// -----------------------------
// Helper to format subclass value (string or array)
function formatSubclass(subclass) {
  if (!subclass) return null;
  if (Array.isArray(subclass)) return subclass.join(', ');
  return subclass;
}

// Helper to check if subclass is empty/any
function isSubclassEmpty(subclass) {
  if (!subclass) return true;
  if (Array.isArray(subclass)) return subclass.length === 0 || subclass.every(s => lower(s) === 'any');
  return lower(subclass) === 'any';
}

async function validatePlan(goal, parsedGoal, includeAxes, excludeAxes, searchUrl, onStep, stats) {
  const includeList = includeAxes.map(a => `${a.field}: ${formatSubclass(a.class)}${!isSubclassEmpty(a.subclass) ? `;${formatSubclass(a.subclass)}` : ''}`).join(' | ') || 'none';
  const excludeList = excludeAxes.map(a => `${a.field}: ${formatSubclass(a.class)}${!isSubclassEmpty(a.subclass) ? `;${formatSubclass(a.subclass)}` : ''}`).join(' | ') || 'none';

const sys = `Validate coverage of goal components against chosen constraints.
ONLY evaluate components that are non-null in parsed goal.
Do NOT invent missing components. Return only JSON. Keep all strings short.

Generic subjects like "proteins", "genes", "markers" do NOT need explicit coverage - return empty missing array for these.
RNA expression data (tissue_category_rna, brain_category_rna) IS how HPA represents protein expression - this counts as full coverage.
Qualifiers like "enriched" covered by subclass (Region enriched, Tissue enriched) are fully covered - do not add to missing.

HPA SEMANTIC CONVENTIONS — these qualifiers are FULLY COVERED by the subclass:
- "only found in X" / "specific to X" / "exclusively in X" → covered by "Tissue enriched" or "Cell type enriched". Do NOT add to missing.
- "detected in all tissues" → covered by "Detected in all" on any single tissue. Do NOT add extra tissue axes.
- "markers for X" → covered by "Cell type enriched" or "Tissue enriched". Do NOT add to missing.
If the qualifier is covered by the subclass selection, return empty missing array.`;
  const usr = `GOAL: "${goal}"
Parsed components:
- subject: ${parsedGoal?.subject || 'null'}
- location: ${parsedGoal?.location || 'null'}
- qualifier: ${parsedGoal?.qualifier || 'null'}
- exclusion: ${parsedGoal?.exclusion || 'null'}

INCLUDE: ${includeList}
EXCLUDE: ${excludeList}
URL: ${searchUrl || 'null'}

Return JSON:
{
  "status": "ok" | "issues",
  "coverage": [
    { "component": "subject|location|qualifier|exclusion", "covered_by": "<constraint or none>" }
  ],
  "issues": ["<short>"],
  "missing": [
    { "component": "subject|location|qualifier|exclusion", "intent": "<what's missing>", "operator": "AND|NOT", "qualifier": "<qualifier or null>" }
  ]
}`;

  await onStep?.({ stage: 'planning_step', label: 'Validation', message: 'Validating goal vs constraints' });
  return invokeLLM(sys, usr, onStep, 'Validation', stats);
}

// -----------------------------
// Final Semantic Validation
// -----------------------------
async function finalSemanticValidation(goal, parsedGoal, includeAxes, excludeAxes, searchUrl, previousAttempts, onStep, stats) {
  const formatAxis = a => {
    const clsStr = formatSubclass(a.class);
    const subStr = !isSubclassEmpty(a.subclass) ? ` → ${formatSubclass(a.subclass)}` : '';
    let str = `${a.field}: ${clsStr}${subStr}`;
    if (a.note) str += ` [NOTE: ${a.note}]`;
    return str;
  };
  const includeList = includeAxes.map(formatAxis).join('\n  - ') || 'none';
  const excludeList = excludeAxes.map(formatAxis).join('\n  - ') || 'none';

  // Collect all notes for explicit mention
  const allNotes = [...includeAxes, ...excludeAxes].filter(a => a.note).map(a => a.note);
const notesContext = allNotes.length > 0
  ? `\n\nNOTES FROM PATH SELECTION:\n${allNotes.map(n => `- ${n}`).join('\n')}\nThese notes indicate where exact matches weren't available. You MUST evaluate whether each approximation is semantically valid:
- ACCEPTABLE: same semantic category (e.g. "membrane receptors"→"Predicted membrane proteins" — both membrane protein concepts)
- NOT ACCEPTABLE: different semantic categories (e.g. "nuclear proteins"→"Nuclear receptors" — nuclear proteins means proteins IN the nucleus, nuclear receptors is a specific receptor family)
If the approximation changes the meaning of the query, REJECT.`
  : '';
  const previousContext = previousAttempts.length > 0
    ? `\n\nPREVIOUS FAILED ATTEMPTS:\n${previousAttempts.map((a, i) => `Attempt ${i + 1}: ${a.url}\nRejection: ${a.reason}`).join('\n\n')}`
    : '';

const sys = `You are the FINAL quality gate. Verify the URL matches the user's INTENT.

=== CRITICAL: SYNTAX IS ALREADY CORRECT ===
All field names in the URL are VALID - they were selected from the actual HPA schema.
Do NOT reject based on field names. These are all real fields:
- tissue_category_rna, brain_category_rna, cell_type_category_rna ✓
- mouse_brain_category_rna, pig_brain_category_rna ✓
- cancer_category_rna, prognostic_cancer ✓
Your ONLY job: Does the URL capture what the USER ASKED FOR?

=== CHECK SEMANTIC INTENT ===
1. LOCATION: Did user ask for "brain"? URL should have brain-related field. "liver"? liver field.
2. QUALIFIER: Did user ask for "enriched"? URL should have enriched. "not detected"? Not detected.
3. SUBJECT: Did user ask for "kinases"? URL should filter by kinases.
4. EXCLUSION: Did user say "not in X"? URL should exclude X appropriately.

=== ACCEPTABLE PATTERNS ===
- brain_category_rna:Any;Not+detected = "not detected in brain" ✓
- brain_category_rna:Not+detected = "not detected in brain" ✓
- tissue_category_rna:Liver;Tissue+enriched = "liver enriched" ✓
- tissue_category_rna:Brain;Not+detected = "not detected in brain" ✓
- Adding expression qualifiers (enriched, enhanced) when user just said location = ACCEPTABLE

=== "NOT ENRICHED" / "ABSENT FROM" PATTERNS ===
When user asks for genes "not enriched in X" or "absent from X" (without using NOT operator):
- tissue_category_rna:X;Not+detected as AND filter = VALID ✓
- This means "show genes where X tissue has 'Not detected' status"
- "Not detected" is a SUBSET of "not enriched" - if not detected, definitely not enriched
- Example: "liver enriched but not enriched in heart" can be:
  tissue_category_rna:Liver;Tissue+enriched+AND+tissue_category_rna:Heart+muscle;Not+detected ✓
- This is MORE restrictive than asked (excludes "detected but not enriched") but is VALID
- Do NOT reject this as contradictory - it correctly excludes genes that ARE expressed in the tissue

=== HPA SEMANTIC CONVENTIONS — DO NOT REJECT THESE ===
- "Tissue enriched" ALREADY means "specific to" / "only found in" / "exclusively expressed in" that tissue.
  A gene classified as "Tissue enriched" in placenta is >=4x higher in placenta vs ALL other tissues.
  So tissue_category_rna:Placenta;Tissue+enriched FULLY covers "genes only found in placenta". PASS it.
  Do NOT add extra exclusion axes for other tissues — Tissue enriched already encodes that.
- "Detected in all" on ANY single tissue means detected in ALL 37 tissues (it is a genome-wide classification).
  tissue_category_rna:Liver;Detected+in+all = "genes detected in all tissues". ONE axis is sufficient. PASS it.
- "Cell type enriched" = "specific to" / "markers for" that cell type. PASS it for "specific"/"markers"/"only" queries.

=== REJECT ONLY FOR WRONG INTENT ===
- User said "liver" but URL has "kidney" = REJECT (wrong location)
- User said "enriched in X" but URL has "Not detected in X" for SAME tissue = REJECT (wrong qualifier)
- User said "brain" but URL has "heart" = REJECT (wrong location)
- NOTE: "Not detected in Y" when user said "not enriched in Y" = VALID (see patterns above)

=== DO NOT REJECT FOR ===
- Field name choices (brain_category_rna vs tissue_category_rna:Brain - both valid for brain)
- Added expression qualifiers when user didn't specify one
- "Any" as class selection (means "all regions/types")

=== REJECT FOR OVER-BROAD EXCLUSIONS ===
- User said "not secreted to blood" but URL excludes ALL secreted proteins = REJECT (too broad)
- User said "not in liver" but URL excludes ALL tissues = REJECT (too broad)
- The exclusion must match the SPECIFIC thing the user wanted to exclude
- "Secreted to blood" is a specific class in Secretome annotation - don't substitute "Predicted secreted proteins"

=== CRITICAL: ALL FIELDS ARE VALID - NEVER QUESTION THEM ===
EVERY field, class, and subclass in the URL was selected from the real HPA schema by navigation.
You MUST NOT reject or question any field names. They are ALL valid. Examples:
- tissue_category_rna, brain_category_rna, cell_type_category_rna ✓
- mouse_brain_category_rna, pig_brain_category_rna ✓
- cancer_category_rna, prognostic_cancer ✓
- normal_expression, tissue_expression ✓
- sa_location:Secreted+to+blood = Secreted to blood ✓

=== CRITICAL: SEMICOLON NOTATION MEANS SUBCLASS SELECTION ===
In HPA URLs, the semicolon (;) selects a SUBCLASS within a class. This is NOT "all of the class"!
- protein_class:Enzymes;Kinases = ONLY KINASES (subclass), NOT all enzymes!
- protein_class:Enzymes;Peptidases = ONLY PEPTIDASES/PROTEASES, NOT all enzymes!
- tissue_category_rna:brain;Tissue+enriched = Brain-ENRICHED genes, NOT all brain genes!

WRONG interpretation: "Enzymes;Kinases filters for all enzymes" - NO! It filters for KINASES ONLY.
CORRECT interpretation: "Enzymes;Kinases" = Kinases subclass under Enzymes parent class.

If user asks for "kinases" and URL has "protein_class:Enzymes;Kinases" → this is CORRECT, PASS it!

NEVER say "field X is not valid" or "field X is not recognized" - ALL fields are valid.
Your ONLY job: Does the URL capture what the USER ASKED FOR semantically?
Do NOT question the technical validity of ANY field or class name.
Do NOT question if a class "exists in schema" - it does.

=== AUGMENT vs REJECT for EXCLUSIONS ===
- If exclusion TARGET is WRONG (e.g., "Predicted secreted proteins" instead of "Secreted to blood") = REJECT
- AUGMENT means "drop this constraint entirely" - only use when the constraint shouldn't exist at all
- User asked "not secreted to blood" → dropping the exclusion = WRONG answer
- User asked "not secreted to blood" → wrong class selected = REJECT and retry with correct path

For "not secreted to blood", the CORRECT path is:
- TISSUE → Secretome annotation → Secreted to blood (NOT operator)
- NOT: SUBCELLULAR → Predicted location → Predicted secreted proteins (this is ALL secreted, too broad)

=== ACCEPTABLE EXPRESSION QUALIFIERS ===
When user says "expressed in X" or "in X" without specifying a qualifier:
- "Is highest expressed" = ACCEPTABLE (X is where expression is highest)
- "Region enriched" / "Tissue enriched" = ACCEPTABLE
- "Detected in all/many/some" = ACCEPTABLE  
- "Low region specificity" = ACCEPTABLE
ALL of these satisfy "expressed in X" - do NOT reject for qualifier choice when user didn't specify one

Example: "kinases in brain" + brain_category_rna:Any;Is+highest+expressed = PASS
The user didn't say "enriched" or "detected" - any expression qualifier is acceptable.

=== WHEN NOTES INDICATE NO EXACT MATCH ===
If a NOTE says "No exact X class exists - Y is closest":
- This means HPA DOES NOT HAVE X. Retrying won't find it.
- If Y is a SUPERSET of X (broader): PASS - acceptable approximation
- If Y is a SUBSET of X (narrower): PASS - acceptable approximation
- If Y is UNRELATED to X: REJECT

=== CRITICAL: BROADER/SUPERSET CLASSES ARE ACCEPTABLE ===
When HPA doesn't have an exact class, a BROADER class that CONTAINS the user's intent is CORRECT:
- "Predicted membrane proteins" for "receptors" = PASS (receptors ARE membrane proteins)
- "Predicted membrane proteins" for "membrane receptors" = PASS (same reason)
- "Enzymes" for "kinases" = PASS (kinases ARE enzymes)
A broader class is NOT a "fundamental mismatch" - it's the best available approximation.
Do NOT reject these. Retrying will NOT find a more specific class - it doesn't exist in HPA.


=== CONTRADICTIONS - CRITICAL ===
If URL contains BOTH "AND field:X" and "NOT field:X" for the SAME field and class:
- This is a CONTRADICTION that returns 0 results
- Use AUGMENT to drop the contradictory exclusion constraint
- Example: "AND sa_location:Secreted+to+blood NOT sa_location:Secreted+to+blood" = CONTRADICTION
- Drop the exclusion (NOT) side via AUGMENT

=== WHEN NO VALID PATH EXISTS ===
If the user wants something HPA doesn't support (e.g., "not detected in blood" but HPA has no blood tissue):
- Do NOT keep REJECTing - retrying won't help
- Use AUGMENT to drop that constraint
- Better to return partial results than fail completely

REJECT only when:
- Location is fundamentally WRONG (user said "brain", URL has "liver")
- Subject is fundamentally WRONG (user said "kinases", URL has "transporters")
- Information is missing

AUGMENT when:
- Constraint can't be represented in HPA schema
- Contradiction exists
- Constraint is too restrictive for generic query


`



;

  const usr = `ORIGINAL QUERY: "${goal}"

Parsed as:
- subject: ${parsedGoal?.subject || 'null'}
- location: ${parsedGoal?.location || 'null'}
- qualifier: ${parsedGoal?.qualifier || 'null'}
- exclusion: ${parsedGoal?.exclusion || 'null'}

GENERATED URL: ${searchUrl}

INCLUDE constraints:
  - ${includeList}

EXCLUDE constraints:
  - ${excludeList}
${notesContext}${previousContext}

Verify EACH non-null component is correctly represented. Be strict, but accept approximations noted above.

IMPORTANT: If a constraint is TOO RESTRICTIVE (e.g., "Disease related genes" when user asked for generic "genes"), use AUGMENT to DROP that constraint. Never add new constraints.

Return JSON:
{
  "verdict": "PASS" | "AUGMENT" | "REJECT",
  "notes_evaluation": "<IF there are NOTES above, you MUST explain here whether each approximation is acceptable or not. If no notes, say 'no notes'>",
  "component_check": {
    "subject": { "expected": "<what user asked>", "got": "<what URL searches>", "ok": true|false },
    "location": { "expected": "<what user asked>", "got": "<what URL searches>", "ok": true|false },
    "qualifier": { "expected": "<what user asked>", "got": "<what URL searches>", "ok": true|false },
    "exclusion": { "expected": "<what user asked>", "got": "<what URL searches>", "ok": true|false }
  },
  "drop_constraints": ["<field name to drop>"],
  "reason": "<if AUGMENT/REJECT, explain what's wrong>"
}

CRITICAL: If NOTES FROM PATH SELECTION exist above, you MUST evaluate them in notes_evaluation. Do not ignore notes.

Use AUGMENT when:
- A constraint is too narrow/restrictive (should be dropped, not changed)
- Subject filter is too specific for a generic query
Use REJECT only when location/subject is fundamentally WRONG (not just overly specific).`;

  await onStep?.({ stage: 'planning_step', label: 'Validate', message: 'Checking URL matches query' });
  const result = await invokeLLM(sys, usr, onStep, 'Final Validation', stats);

  // DEBUG: Log validation details
  console.log(`[VALIDATE-DEBUG] Verdict: ${result?.verdict}`);
  console.log(`[VALIDATE-DEBUG] Notes evaluation: ${result?.notes_evaluation || 'NOT PROVIDED'}`);
  console.log(`[VALIDATE-DEBUG] Component check: ${JSON.stringify(result?.component_check, null, 2)}`);
  if (result?.reason) console.log(`[VALIDATE-DEBUG] Reason: ${result.reason}`);

  // RC6 fix: If all component checks pass but verdict is REJECT, override to PASS
  if (result?.verdict === 'REJECT' && result?.component_check) {
    const checks = Object.values(result.component_check).filter(c => c != null);
    if (checks.length > 0 && checks.every(c => c.ok === true)) {
      console.log(`[VALIDATE-FIX] Overriding REJECT→PASS: all component checks ok but verdict was REJECT`);
      result.verdict = 'PASS';
    }
  }

  if (result?.verdict === 'PASS') {
    await onStep?.({ stage: 'complete', label: 'Valid', message: 'URL matches query ✓' });
  } else if (result?.verdict === 'AUGMENT') {
    const dropList = result?.drop_constraints?.join(', ') || 'none';
    await onStep?.({ stage: 'fallback', label: 'Adjust', message: `Dropping: ${dropList}` });
  } else {
    await onStep?.({ stage: 'error', label: 'Mismatch', message: result?.reason || 'URL does not match query' });
  }

  return result;
}

// -----------------------------
// Search Execution
// -----------------------------
function buildSearchUrl(includeAxes, excludeAxes) {
  // RESOLVE CONTRADICTIONS: If same field+class appears in both include and exclude, remove from include
  // (exclude wins because user explicitly said "not X" or "absent from X")
  const excludeKeys = new Set(excludeAxes.map(a => `${lower(a.field)}::${lower(Array.isArray(a.class) ? a.class.join(',') : a.class)}`));
  const filteredInclude = includeAxes.filter(a => {
    const key = `${lower(a.field)}::${lower(Array.isArray(a.class) ? a.class.join(',') : a.class)}`;
    if (excludeKeys.has(key)) {
      console.log(`[URL-DEBUG] Removing contradictory include: ${a.field}:${a.class} (already in exclude)`);
      return false;
    }
    return true;
  });

  const includeSegments = filteredInclude
    .map(a => buildUrlSegment(a.field, a.class, a.subclass))
    .filter(Boolean);

  const excludeSegments = excludeAxes
    .map(a => buildUrlSegment(a.field, a.class, a.subclass))
    .filter(Boolean);

  if (!includeSegments.length && !excludeSegments.length) return null;

  let url = 'https://www.proteinatlas.org/search/';
  if (includeSegments.length) url += includeSegments.join('+AND+');
if (excludeSegments.length) {
  url += (includeSegments.length ? '+NOT+' : 'NOT+') + excludeSegments.join('+NOT+');
}
  return url;
}

async function tryFreeTextFallback(goal, onStep) {
  const url = `https://www.proteinatlas.org/search/all:${encodeURIComponent(goal).replace(/%20/g, '+')}`;
  await onStep?.({ stage: 'planning_step', label: 'Fallback', message: 'Using free-text search' });
  const rows = await httpGetJson(`${url}?format=json&download=yes`).catch(() => []);
  const list = Array.isArray(rows) ? rows : (rows?.rows || []);
  return { rows: list, searchUrl: url };
}

// -----------------------------
// Core Planning (can be retried)
// -----------------------------
async function buildSearchPlan(goal, parsedGoal, previousAttempts, onStep, stats) {
  // Pass rejection context to plan constraints if we have previous failures
  const rejectionContext = previousAttempts.length > 0
    ? previousAttempts.map(a => `REJECTED: ${a.reason}`).join('\n')
    : null;

  const plan = await planConstraints(goal, parsedGoal, onStep, stats, rejectionContext);


  const includeAxes = [];
  const excludeAxes = [];

// Extract failed paths from previous attempts
// Extract failed paths from previous attempts
const failedPaths = previousAttempts.map(a => ({
  paths: [...(a.includeAxes || []), ...(a.excludeAxes || [])],
  fields: a.fieldsUsed || [],
  reason: a.reason
}));
  // Resolve all axes in parallel — each gets its own trail LLM call
  const axisResults = await Promise.all(
    plan.map(item => buildAxisForPlanItem(item, onStep, stats, parsedGoal, failedPaths))
  );
  for (let i = 0; i < plan.length; i++) {
    const axis = axisResults[i];
    if (!axis) continue;
    if (upper(plan[i].operator) === 'NOT') excludeAxes.push(axis);
    else includeAxes.push(axis);
  }

  const finalInclude = dedupeAxes(includeAxes);
  let finalExclude = dedupeAxes(excludeAxes);

  // RC4 fix: When an include axis uses an enrichment subclass (Region enriched, Tissue enriched,
  // Cell type enriched), exclusions on the SAME field are redundant — enrichment already means
  // the gene is specific to that location vs all others. Drop contradictory same-field exclusions.
  const ENRICHMENT_SUBCLASSES = new Set(['region enriched', 'tissue enriched', 'cell type enriched', 'group enriched']);
  const enrichedFields = new Set();
  for (const inc of finalInclude) {
    const sub = Array.isArray(inc.subclass) ? inc.subclass[0] : inc.subclass;
    if (sub && ENRICHMENT_SUBCLASSES.has(lower(sub))) {
      enrichedFields.add(lower(inc.field));
    }
  }
  if (enrichedFields.size > 0) {
    const before = finalExclude.length;
    finalExclude = finalExclude.filter(exc => {
      if (enrichedFields.has(lower(exc.field))) {
        // Only drop if the exclude targets a DIFFERENT class than the include
        const incSameField = finalInclude.find(i => lower(i.field) === lower(exc.field));
        const excCls = Array.isArray(exc.class) ? exc.class.map(c => lower(c)).join(',') : lower(exc.class || '');
        const incCls = incSameField ? (Array.isArray(incSameField.class) ? incSameField.class.map(c => lower(c)).join(',') : lower(incSameField.class || '')) : '';
        if (excCls !== incCls) return true; // Different classes — keep the exclusion
        console.log(`[RC4-FIX] Dropping redundant exclusion on ${exc.field}:${exc.class} — include already has enrichment subclass`);
        return false;
      }
      return true;
    });
    if (finalExclude.length < before) {
      console.log(`[RC4-FIX] Dropped ${before - finalExclude.length} redundant exclusion(s)`);
    }
  }

  let searchUrl = buildSearchUrl(finalInclude, finalExclude);

  // Validate and attempt to add missing constraints
  const validation = await validatePlan(goal, parsedGoal, finalInclude, finalExclude, searchUrl, onStep, stats);
  if (validation?.issues?.length) {
    await onStep?.({ stage: 'reasoning_step', label: 'Validation Issues', message: validation.issues.join('; ') });
  }
  if (Array.isArray(validation?.missing) && validation.missing.length) {
    const nonNull = {
      subject: parsedGoal?.subject,
      location: parsedGoal?.location,
      qualifier: parsedGoal?.qualifier,
      exclusion: parsedGoal?.exclusion
    };
    const missing = validation.missing.filter(m => m?.component && nonNull[m.component]);
    for (const miss of missing) {
      const item = {
        component: miss.component,
        intent: miss.intent || miss.component,
        qualifier: miss.qualifier || parsedGoal?.qualifier || null,
        operator: miss.operator || 'AND'
      };
      const axis = await buildAxisForPlanItem(item, onStep, stats, parsedGoal);
      if (!axis) continue;
      // Skip if this concept is already covered by an existing axis (same field, or same tissue/location)
      const axisClass = Array.isArray(axis.class) ? axis.class[0] : axis.class;
      const alreadyCovered = [...finalInclude, ...finalExclude].some(a => {
        const existClass = Array.isArray(a.class) ? a.class[0] : a.class;
        return (a.field === axis.field && existClass === axisClass) ||
               (lower(existClass) === lower(axisClass));
      });
      if (alreadyCovered) continue;
      // Always add — alreadyCovered check above prevents true duplicates.
      // Don't replace same-field axes: two different classes on the same field
      // are valid intersections (e.g., protein_class:Enzymes AND protein_class:FDA approved drug targets).
      if (upper(item.operator) === 'NOT') {
        finalExclude.push(axis);
      } else {
        finalInclude.push(axis);
      }
    }
  }

  const resolvedInclude = dedupeAxes(finalInclude);
  const resolvedExclude = dedupeAxes(finalExclude);
  searchUrl = buildSearchUrl(resolvedInclude, resolvedExclude);

  return { searchUrl, includeAxes: resolvedInclude, excludeAxes: resolvedExclude };
}

// -----------------------------
// Main
// -----------------------------
const MAX_RETRIES = 2;

async function deepResearch({ goal }, { onStep } = {}) {
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, perStep: {} };
  let searchUrl = null;
  let finishedAt = null;

  await onStep?.({ stage: 'start', message: `Research agent activated. Goal: "${goal}"` });

  try {
    const parsedGoal = await parseGoalComponents(goal, onStep, stats);

    const previousAttempts = [];
    let finalInclude = [];
    let finalExclude = [];
    let validationPassed = false;
    let lastValidation = null; // Store last validation for detailed error reporting

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await onStep?.({ stage: 'planning_step', label: 'Retry', message: `Attempt ${attempt + 1}/${MAX_RETRIES + 1} - rebuilding plan with rejection context` });
      }

      const result = await buildSearchPlan(goal, parsedGoal, previousAttempts, onStep, stats);
      searchUrl = result.searchUrl;
      finalInclude = result.includeAxes;
      finalExclude = result.excludeAxes;

      if (searchUrl) {
        await onStep?.({ stage: 'execution_step', label: 'URL Ready', message: searchUrl });
      }

      // Final semantic validation
      const finalCheck = await finalSemanticValidation(
        goal, parsedGoal, finalInclude, finalExclude, searchUrl, previousAttempts, onStep, stats
      );
      lastValidation = finalCheck; // Store for detailed error reporting

      if (finalCheck?.verdict === 'PASS') {
        validationPassed = true;
        break;
      } else if (finalCheck?.verdict === 'AUGMENT' && Array.isArray(finalCheck?.drop_constraints) && finalCheck.drop_constraints.length > 0) {
        // AUGMENT: Drop specified constraints and rebuild URL (no full retry needed)
        const dropSet = new Set(finalCheck.drop_constraints.map(c => lower(c)));

        finalInclude = finalInclude.filter(a => !dropSet.has(lower(a.field)));
        finalExclude = finalExclude.filter(a => !dropSet.has(lower(a.field)));

        searchUrl = buildSearchUrl(finalInclude, finalExclude);

        if (searchUrl) {
          await onStep?.({ stage: 'planning_step', label: 'Augmented URL', message: searchUrl });
          validationPassed = true; // Accept the augmented result
        }
        break;
      } else {
        // REJECT: Record this failed attempt for full retry
        previousAttempts.push({
          url: searchUrl,
          reason: finalCheck?.reason || 'URL does not correctly represent the query',
          includeAxes: finalInclude.map(a => `${a.field}: ${a.class}`),
          excludeAxes: finalExclude.map(a => `${a.field}: ${a.class}`),
          // Track which fields were used so retries can try different ones
          fieldsUsed: [...finalInclude, ...finalExclude].map(a => `${a.category}:${a.field}`)
        });

        if (attempt < MAX_RETRIES) {
          await onStep?.({ stage: 'reasoning_step', label: 'Retrying', message: `Validation failed: ${finalCheck?.reason}` });
        } else {
          await onStep?.({ stage: 'reasoning_step', label: 'Max Retries', message: `Proceeding with best effort after ${MAX_RETRIES + 1} attempts` });
        }
      }
    }

    let rows = [];
    if (searchUrl) {
      await onStep?.({ stage: 'planning_step', label: 'Search', message: 'Executing compound query' });
      const raw = await httpGetJson(`${searchUrl}?format=json&download=yes`).catch(() => []);
      rows = Array.isArray(raw) ? raw : (raw?.rows || []);
    } else {
      const fallback = await tryFreeTextFallback(goal, onStep);
      rows = fallback.rows;
      searchUrl = fallback.searchUrl;
    }

    const summary = summarizeRows(rows);

    finishedAt = Date.now();

    // Build detailed validation note from component check
    let validationNote = '';
    if (!validationPassed && lastValidation?.component_check) {
      const mismatches = [];
      const cc = lastValidation.component_check;
      for (const [key, info] of Object.entries(cc)) {
        if (info && info.ok === false && info.expected && info.got) {
          mismatches.push(`- **${key}**: wanted "${info.expected}" → used "${info.got}"`);
        }
      }
      if (mismatches.length > 0) {
        validationNote = `\n\n⚠️ **Limitations** (HPA doesn't have exact filters for):\n${mismatches.join('\n')}`;
      }
    }
    const summary_md = `**Research Complete for "${goal}"**\n\nFound **${summary.count}** genes matching the criteria.\n\n**Search URLs:**\n- ${searchUrl}${validationNote}`;

    return {
      status: 'ok',
      summary_md,
      result: {
        rows_found: summary.count,
        preview: summary.top,
        search_urls: [searchUrl],
        validation_passed: validationPassed,
        validation_details: lastValidation?.component_check || null,
        attempts: previousAttempts.length + 1
      },
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt || Date.now()).toISOString()
    };
  } catch (err) {
    await onStep?.({ stage: 'error', label: 'Error', message: err.message });
    return { status: 'error', error: err.message };
  } finally {
    finishedAt = finishedAt || Date.now();
    const durationSec = ((finishedAt - startedAt) / 1000).toFixed(1);
    await onStep?.({ stage: 'planning_step', label: 'Timer', message: `Total runtime: ${durationSec}s` });

    const tokenReport = buildTokenReport(stats);
    if (tokenReport) {
      await onStep?.({ stage: 'planning_step', label: 'Token Usage', message: tokenReport });
    }
  }
}

function upper(v) { return String(v || '').toUpperCase(); }

module.exports = deepResearch;
