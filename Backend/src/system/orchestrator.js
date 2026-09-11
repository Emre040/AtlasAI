'use strict';

// The tools the chat model can call. Each handler is an agent; the orchestrator only validates
// arguments, fills in what the model left out, and forwards progress steps.
const { inference } = require('../inference/gateway');
const investigatorBulk = require('./agents/investigatorBulk');
const deepResearchTrail = require('./agents/deepResearchTrail');
const dictionaryExpert = require('./agents/dictionaryExpert');
const asoStudy = require('./agents/asoStudy');
const clarify = require('./agents/clarify');

const MODE_PARAMETER = {
  type: 'string',
  enum: ['online', 'offline'],
  description:
    'Data source. "offline" evaluates against the imported HPA release and prohibits online HPA access. ' +
    'Unavailable files or unsupported filters produce an explicit error. "online" queries proteinatlas.org live.'
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
        }
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: asoStudy
  },
  {
    name: 'investigator_hpa',
    description:
      'Investigates a question about one gene or a supplied list using Human Protein Atlas source tables (expression per tissue, cell ' +
      'type, brain region, immune cell, cell line and cancer; subcellular location; secretome; prognostics; interaction ' +
      'partners; antibodies; classes). Pass gene for the existing single-gene investigation, or genes for bulk lookups. ' +
      'Bulk Investigator locates the right sources and returns complete measurement tables, source references and missing values. ' +
      'Examples: "What is the liver nTPM of ALB?", "Which cell type expresses INS most?", "Tell me about BRCA1". ' +
      'The answer cites the table row it rests on; present it directly.',
    parameters: {
      type: 'object',
      properties: {
        gene: {
          type: 'string',
          description: 'The gene identifier to look up (gene symbol like BRCA1, or ENSG id like ENSG00000073734).'
        },
        genes: {
          type: 'array', items: { type: 'string' },
          description: 'Optional supplied list. Investigator chooses source tables and applies lookups across the whole list; do not also supply gene.'
        },
        question: {
          type: 'string',
          description: 'The complete question, including requested measurements, tissues, source cohorts, statistics and limitations.'
        },
        mode: MODE_PARAMETER
      },
      required: [],
      additionalProperties: false
    },
    handler: investigatorBulk
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
        study: {
          type: 'string',
          description: 'The whole study this goal is one part of, when a study loop asks; it settles the assay a requirement means.'
        },
        mode: MODE_PARAMETER
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: deepResearchTrail
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
  },
  {
    name: 'clarify_hpa',
    description:
      'Ask the user what an ambiguous request means, with up to three multiple-choice questions shown as cards. ' +
      'ONLY when the request can be read in ways that change what would be done (which tissue or cell type, RNA or protein, ' +
      'tissue enriched vs enhanced vs detected, which cancer cohort, a list vs a count vs a figure) AND no reasonable default exists. ' +
      'Never for a request that names its tissue, level and output, and never when the user is answering a questionnaire.',
    parameters: {
      type: 'object',
      properties: {
        ambiguity: {
          type: 'string',
          description: 'One sentence: what in the request is open and why it changes the work.'
        }
      },
      required: ['ambiguity'],
      additionalProperties: false
    },
    handler: clarify
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
    // One Investigator: a single point is a list of one.
    if (parsed.points === undefined && parsed.genes === undefined) {
      const single = parsed.gene || (rawQuery.match(/\bENSG\d{9,}\b/i) || [])[0];
      if (single) parsed.points = [String(single).toUpperCase() === String(single).toUpperCase() && /^ENSG/i.test(single) ? String(single).toUpperCase() : String(single)];
    }
    delete parsed.gene;
    if (!parsed.question && rawQuery) parsed.question = rawQuery;
  }
  if ((name === 'deep_research_hpa' || name === 'aso_hpa') && !parsed.goal && rawQuery) parsed.goal = rawQuery;
  if (name === 'clarify_hpa') { parsed.query = rawQuery; parsed.context = ctx.history || null; }

  const result = await inference.withContext({ agentKey: name, ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}) }, () => handler(parsed, { ...ctx, onStep }));
  return { result, steps };
}

module.exports = { getToolSpecs, execute };
