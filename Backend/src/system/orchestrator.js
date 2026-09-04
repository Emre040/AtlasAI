'use strict';

// The tools the chat model can call. Each handler is an agent; the orchestrator only validates
// arguments, fills in what the model left out, and forwards progress steps.
const investigatorTrail = require('./agents/investigatorTrail');
const deepResearchTrail = require('./agents/deepResearchTrail');
const checkInclusion = require('./agents/checkInclusion');
const dictionaryExpert = require('./agents/dictionaryExpert');
const asoStudy = require('./agents/asoStudy');

const MODE_PARAMETER = {
  type: 'string',
  enum: ['online', 'offline'],
  description:
    'Data source. "offline" (the default) evaluates against the local copy of the HPA release: fast, free of ' +
    'network access, and the same data as the website for every bulk-exported field. "online" queries ' +
    'proteinatlas.org live; searches fall back to it by themselves for fields the local data cannot express.'
};

const defs = [
  {
    name: 'aso_hpa',
    description:
      'Autonomous study over the Human Protein Atlas. Use for any request that needs several steps: several gene ' +
      'sets combined, values measured for many genes, comparisons, rankings, counts, charts or figures, or a written ' +
      'analysis with conclusions. It works in turns: it keeps a plan, summons the search and gene-reading agents in ' +
      'parallel, applies table operations to their results, keeps every result as an artifact, and finishes with a ' +
      'summary that cites the artifacts.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The complete research goal, with every requirement the user stated (sets, measurements, charts, conclusions).'
        },
        allow_search: {
          type: 'boolean',
          description: 'Whether the study may search for gene sets. Set false only when the user supplies the genes.',
          default: true
        },
        mode: MODE_PARAMETER
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: asoStudy
  },
  {
    name: 'investigator_hpa',
    description:
      'Answers one question about one gene from the Human Protein Atlas per-gene tables (expression per tissue, cell ' +
      'type, brain region, immune cell, cell line and cancer; subcellular location; secretome; prognostics; interaction ' +
      'partners; antibodies; classes). Use when the user names a gene or ENSG id. ' +
      'Examples: "What is the liver nTPM of ALB?", "Which cell type expresses INS most?", "Tell me about BRCA1". ' +
      'The answer cites the table row it rests on; present it directly.',
    parameters: {
      type: 'object',
      properties: {
        gene: {
          type: 'string',
          description: 'The gene identifier to look up (gene symbol like BRCA1, or ENSG id like ENSG00000073734).'
        },
        question: {
          type: 'string',
          description: 'The question to answer about this gene.'
        },
        mode: MODE_PARAMETER
      },
      required: ['gene'],
      additionalProperties: false
    },
    handler: investigatorTrail
  },
  {
    name: 'deep_research_hpa',
    description:
      'Finds the set of genes matching a description by building and running a Human Protein Atlas search: protein ' +
      'classes, tissue, brain, single-cell, immune, cancer and cell-line specificity, subcellular location, secretome, ' +
      'evidence, expression clusters, prognostics, IHC expression, and combinations with exclusions ' +
      '(e.g. "kidney-enriched transporters", "GPCRs excluding olfactory with tissue-enhanced expression"). ' +
      'Requires an explicit goal; if the user is vague, ask a clarification question first.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The description of the genes to find, with every stated requirement.'
        },
        mode: MODE_PARAMETER
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: deepResearchTrail
  },
  {
    name: 'check_inclusion_hpa',
    description:
      'Check if a specific gene is included in a PREVIOUS search result. ' +
      'ONLY use this when: (1) a search was already completed (indicated by [SEARCH COMPLETED...] in history), AND (2) user asks if a specific gene is in those results. ' +
      'Examples: "Is BRCA1 in that list?", "Does that search include TP53?", "Check if EGFR is in the liver-enriched results". ' +
      'DO NOT use this for new searches - use deep_research_hpa instead. ' +
      'Requires the search_url from a previous search and the gene to check.',
    parameters: {
      type: 'object',
      properties: {
        search_url: {
          type: 'string',
          description: 'The HPA search URL from a previous search (from [SEARCH COMPLETED...] in conversation history).'
        },
        gene: {
          type: 'string',
          description: 'The gene symbol (e.g., BRCA1, TP53) or ENSG ID to check for in the results.'
        }
      },
      required: ['search_url', 'gene'],
      additionalProperties: false
    },
    handler: checkInclusion
  },
  {
    name: 'dictionary_expert_hpa',
    description:
      'Look up histology/pathology topics in the HPA Dictionary, OR answer general questions about the Human Protein Atlas itself. ' +
      'Use this for: ' +
      '(A) Histology/pathology: tissue histology, cancer pathology, cell structures ' +
      '(e.g., "show me liver histology", "neuroendocrine tumors", "mitochondria"). ' +
      '(B) About HPA: questions about the project, its history, team, publications, downloads, releases, funding, data licensing ' +
      '(e.g., "what is HPA?", "who runs the Human Protein Atlas?", "how do I download data?", "what changed in the latest release?", "how do I cite HPA?").',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The histology/pathology topic to look up (e.g., "neuroendocrine tumors", "liver", "mitochondria"). Use for dictionary mode.'
        },
        question: {
          type: 'string',
          description: 'A general question about the Human Protein Atlas itself (e.g., "who leads HPA?", "how to download bulk data", "what version is current?"). Use for about/receptionist mode.'
        }
      },
      additionalProperties: false
    },
    handler: dictionaryExpert
  }
];

const nameToHandler = new Map(defs.map(d => [d.name, d.handler]));

function getToolSpecs() {
  return defs.map(d => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters }
  }));
}

async function execute(name, args, ctx = {}) {
  const handler = nameToHandler.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);

  let parsed = args;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch (e) { throw new Error(`Invalid JSON for ${name}: ${e.message}`); }
  }
  parsed = parsed && typeof parsed === 'object' ? { ...parsed } : {};

  const steps = [];
  const onStep = async (payload) => {
    steps.push(payload);
    await ctx.onStep?.(payload);
  };

  // The data-source switch is only meaningful as one of its two values.
  if (parsed.mode !== undefined && parsed.mode !== 'online' && parsed.mode !== 'offline') delete parsed.mode;

  const rawQuery = String(ctx.rawQuery || '').trim();
  if (name === 'investigator_hpa') {
    if (!parsed.gene) {
      const ensgMatch = rawQuery.match(/\bENSG\d{9,}\b/i);
      if (ensgMatch) parsed.gene = ensgMatch[0].toUpperCase();
    }
    if (!parsed.question && rawQuery) parsed.question = rawQuery;
  }
  if ((name === 'deep_research_hpa' || name === 'aso_hpa') && !parsed.goal && rawQuery) parsed.goal = rawQuery;

  const result = await handler(parsed, { ...ctx, onStep });
  return { result, steps };
}

module.exports = { getToolSpecs, execute };
