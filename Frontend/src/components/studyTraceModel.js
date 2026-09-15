// Walk recorded dependency IDs, never titles, argument text, or all activity.
// A shared ancestor appears once and every input branch of a join is retained.
export function traceForNode(state, key) {
  const nodes = [],
    missing = new Set(),
    visiting = new Set(),
    visited = new Set(),
    cycles = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      cycles.add(id);
      return;
    }
    if (visited.has(id)) return;
    const node = state.byKey.get(id);
    if (!node) {
      missing.add(id);
      return;
    }
    visiting.add(id);
    // Artifact source IDs are also retained when a producer event is missing.
    for (const parent of new Set([
      ...(node.inputs || []),
      ...(node.sourceInputs || []),
    ]))
      visit(parent);
    visiting.delete(id);
    visited.add(id);
    nodes.push(node);
  }
  visit(key);
  const steps = nodes
    .filter((n) => n.type === "tool" || n.type === "agent")
    .sort((a, b) => a.order - b.order)
    .map((node) => ({
      node,
      outputs: nodes.filter(
        (n) =>
          (n.type === "data" || n.type === "figure") &&
          n.inputs.includes(node.key),
      ),
      events: state.activity.filter((e) => e.data.id === node.key),
      decision: state.turns.find((t) => t.turn === node.turn)?.text || "",
    }));
  return { nodes, steps, missing: [...missing], cycles: [...cycles] };
}
