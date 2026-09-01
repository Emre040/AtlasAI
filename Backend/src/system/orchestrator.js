'use strict';

// Import the tool handlers
const investigationAgent = require('./agents/investigation');
const deepResearch = require('./agents/deepResearch');
const checkInclusion = require('./agents/checkInclusion');
const dictionaryExpert = require('./agents/dictionaryExpert');
const asoAgent = require('./agents/aso');

const defs = [
  {
    name: 'aso_hpa',
    description:
      'Autonomous Scientific Orchestrator (ASO). Use for multi-step research workflows that may require ' +
      'running multiple tools, cleaning results, and generating analysis/figures. ASO manages its own workspace ' +
      'and returns artifact pointers and summaries. It never streams raw datasets to the user.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The scientific goal or research request to orchestrate.'
        },
        top_x: {
          type: 'number',
          description: 'Top X items to keep after cleaning.',
          default: 20
        },
        allow_search: {
          type: 'boolean',
          description: 'Allow ASO to call deep_research_hpa for new searches. If false, ASO only uses existing datasets and investigator lookups.',
          default: true
        },
        chart_requests: {
          type: 'array',
          description: 'Optional explicit chart specifications to render.',
          items: { type: 'object' }
        },
        mode: {
          type: 'string',
          enum: ['online', 'offline'],
          description:
            'Data source. "offline" (the default when the local copy of the HPA release is ready) runs searches and ' +
            'batch measurements against the local HPA bulk data, which is much faster and cheaper. "online" uses ' +
            'proteinatlas.org live; pick it only when the request needs data outside the bulk export (protein structure, ' +
            'antibody validation, metabolic pathways, images).'
        }
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: asoAgent
  },
  {
    name: 'investigator_hpa',
    description:
      'In-depth gene investigation in the Human Protein Atlas. Use this when the user asks about a specific gene by name or ENSG ID. ' +
      'Can answer general questions ("Tell me about EGFR") or specific data queries ("What is the JURKAT nTPM for BRCA1?"). ' +
      'Examples: "Tell me about BRCA1", "What is ENSG00000073734?", "Look up TP53", "BioPlex interaction count for BRAT1". ' +
      'IMPORTANT: Present the full answer from the result directly to the user - do not summarize or paraphrase it.',
    parameters: {
      type: 'object',
      properties: {
        gene: {
          type: 'string',
          description: 'The gene identifier to look up (gene symbol like BRCA1, or ENSG ID like ENSG00000073734).'
        },
        question: {
          type: 'string',
          description: 'The question to answer about this gene (e.g., "What is the subcellular localization?", "Tell me about this gene").'
        },
        mode: {
          type: 'string',
          enum: ['online', 'offline'],
          description:
            'Data source. "offline" reads the gene\'s expression tables and annotations from the local copy of the HPA ' +
            'release (tissue, brain, single cell, immune cell, cell line RNA; subcellular location; cancer prognostics; ' +
            'interaction partners) with no network access, which is fast and ideal for expression values, locations and ' +
            'classifications. "online" (default) fetches the live gene pages and is required for protein structure, ' +
            'antibody validation, images and anything not in the bulk export.'
        }
      },
      required: ['gene'],
      additionalProperties: false
    },
    handler: investigationAgent
  },
  {
    name: 'deep_research_hpa',
    description:
      'Autonomous multi-step research over the Human Protein Atlas for broader requests. ' +
      'Use for: protein classes (e.g., "G-protein coupled receptors"), tissue/brain specificity, subcellular classes, ' +
      'single-cell patterns, cancer relevance, or combinations (e.g., "kidney-enriched transporters", "GPCRs excluding olfactory with tissue-enhanced expression"). ' +
      'Requires an explicit, unambiguous goal; if the user is vague (e.g., "secreted proteins" without a destination), ask a clarification question first.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The complex research goal or question to investigate.'
        },
        max_steps: {
          type: 'number',
          description: 'Maximum research loops (default 5).',
          default: 5
        },
        mode: {
          type: 'string',
          enum: ['online', 'offline'],
          description:
            'Data source. "offline" evaluates the search against the local copy of the HPA release with no network ' +
            'access: tissue, brain, single-cell, immune-cell, cancer and cell-line RNA categories, protein class, ' +
            'subcellular location, secretome, evidence, expression clusters, cancer prognostics and IHC tissue ' +
            'expression. "online" (default) queries proteinatlas.org live and supports every search field; use it when ' +
            'the request involves antibody validation, metabolic pathways, protein structure, interaction structure or ' +
            'any field the local data cannot answer. Offline automatically falls back to online for unsupported fields.'
        }
      },
      required: ['goal'],
      additionalProperties: false
    },
    handler: deepResearch
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

  const steps = [];
  const onStep = async (payload) => {
    steps.push(payload);
    await ctx.onStep?.(payload);
  };

  // The data-source switch is only meaningful as one of its two values.
  if (parsed?.mode !== undefined && parsed.mode !== 'online' && parsed.mode !== 'offline') {
    parsed = { ...parsed };
    delete parsed.mode;
  }


  // For investigator_hpa: Extract gene from rawQuery if not provided, and pass question
  if (name === 'investigator_hpa') {
    const rawQ = String(ctx.rawQuery || '').trim();

    // Extract gene if not provided
    if (!parsed?.gene) {
      const ensgMatch = rawQ.match(/\bENSG\d{9,}\b/i);
      if (ensgMatch) {
        parsed = { ...(parsed || {}), gene: ensgMatch[0].toUpperCase() };
      }
    }

    // Pass the full query as question if not provided
    if (!parsed?.question && rawQ) {
      parsed = { ...(parsed || {}), question: rawQ };
    }
  }

  // For deep_research_hpa: Trust the AI's goal if provided, only fallback to rawQuery if missing
  if (name === 'deep_research_hpa') {
    if (!parsed?.goal && ctx.rawQuery) {
      // AI didn't provide a goal, use raw user query as fallback
      parsed = { ...(parsed || {}), goal: String(ctx.rawQuery || '').trim() };
    }
    // Otherwise trust the AI's goal - it has context and can formulate better queries
  }

  const result = await handler(parsed || {}, { ...ctx, onStep });
  return { result, steps };
}

module.exports = { getToolSpecs, execute };
