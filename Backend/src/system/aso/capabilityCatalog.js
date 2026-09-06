'use strict';

const LOAD_TOOLS = {
  type: 'function',
  function: {
    name: 'load_tools',
    description: 'Make additional registered tools available on the next turn. Choose exact names from the capability directory. Load independent operations together; already loaded tools remain available.',
    parameters: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, description: 'Exact registered tool names.' } },
      required: ['names'],
      additionalProperties: false
    }
  }
};

// The registry is authoritative. Loading changes only which native schemas are sent,
// never the registered capabilities or their arguments. No task text is inspected.
class CapabilityCatalog {
  constructor({ tools, coreNames = [] }) {
    if (!Array.isArray(tools)) throw new Error('Capability tools must be an array');
    this.registry = new Map();
    for (const tool of tools) {
      const name = tool?.function?.name;
      if (typeof name !== 'string' || !name || name === LOAD_TOOLS.function.name || this.registry.has(name)) throw new Error(`Invalid or duplicate capability ${JSON.stringify(name)}`);
      this.registry.set(name, tool);
    }
    this.loaded = new Set();
    this.load(coreNames);
    this.core = new Set(this.loaded);
  }

  load(names) {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('load_tools.names must be an array of exact tool names');
    const unknown = names.filter(name => !this.registry.has(name));
    if (unknown.length) throw new Error(`Unknown tools: ${[...new Set(unknown)].join(', ')}. Choose exact names from the capability directory.`);
    const added = [...new Set(names)].filter(name => !this.loaded.has(name));
    added.forEach(name => this.loaded.add(name));
    return { loaded: added };
  }

  offered() {
    return [...this.registry].filter(([name]) => this.loaded.has(name)).map(([, tool]) => tool).concat(LOAD_TOOLS);
  }

  directory() {
    return [...this.registry].filter(([name]) => !this.core.has(name)).map(([name, tool]) => {
      // Descriptions are authored with the tool, so additions automatically appear here.
      // The opening sentence identifies the capability; exact argument help loads with it.
      const description = String(tool.function.description || '').replace(/\s+/g, ' ').trim();
      const sentence = description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() || description;
      return `${name}: ${sentence || 'Load its native schema for arguments.'}`;
    }).join('\n');
  }
}

module.exports = { CapabilityCatalog, LOAD_TOOLS };
