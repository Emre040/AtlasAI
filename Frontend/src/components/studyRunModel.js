const AGENTS = {
  deep_research_hpa: "Deep research",
  investigator_hpa: "Investigator",
  dictionary_expert_hpa: "Dictionary",
  clarify_hpa: "Clarification",
};
export function agentName(tool) {
  return AGENTS[tool] || tool;
}
export function nodeTitle(node) {
  if (node.type === "query") return "Research question";
  if (node.type === "finish") return node.label;
  return node.title || node.label;
}
function payload(message) {
  if (typeof message !== "string") return {};
  try {
    return JSON.parse(message);
  } catch {
    return {};
  }
}

// Stored and streamed events share a model. One call may produce several artifacts.
export function studyStateFromEvents(events) {
  const state = {
    phase: "starting",
    goal: "",
    workspaceUuid: null,
    mode: null,
    hpaVersion: null,
    model: null,
    plan: [],
    islands: [],
    byKey: new Map(),
    turns: [],
    trails: new Map(),
    activity: [],
    finish: null,
    error: null,
    complete: false,
    failed: false,
    artifactsById: new Map(),
  };
  const put = (node) => {
    const existing = state.byKey.get(node.key);
    if (existing) {
      Object.assign(existing, node);
      return existing;
    }
    node.order = state.islands.length;
    state.islands.push(node);
    state.byKey.set(node.key, node);
    return node;
  };
  put({
    key: "query",
    type: "query",
    label: "Research question",
    inputs: [],
    status: "done",
  });
  for (const event of events || []) {
    if (event?.status === "completed") {
      state.complete = true;
      if (event.failed) {
        state.failed = true;
        state.error = event.message;
      }
      continue;
    }
    if (event?.status === "started") continue;
    const stage = String(event?.stage || "").toLowerCase();
    const d = payload(event.message);
    if (stage !== "context" && stage !== "start")
      state.activity.push({ stage, data: d, key: state.activity.length });
    if (stage === "start") {
      state.workspaceUuid = d.workspace_uuid;
      state.mode = d.mode;
      state.hpaVersion = d.hpa_version;
      state.model = d.model;
      state.goal = d.goal || "";
      state.phase = "running";
    } else if (stage === "turn")
      state.turns.push({
        turn: d.turn,
        text: d.text || "",
        calls: d.calls || [],
      });
    else if (stage === "plan") {
      if (Array.isArray(d.items)) state.plan = d.items;
      put({
        key: "plan",
        type: "plan",
        label: "Study plan",
        inputs: ["query"],
        status: "done",
        items: state.plan,
      });
    } else if (stage === "note")
      put({
        key: `note${state.islands.length}`,
        type: "note",
        label: "Research note",
        inputs: ["query"],
        status: "done",
        text: d.text || "",
      });
    else if (stage === "skip")
      state.turns.push({ turn: null, skip: d.reason || "" });
    else if (stage === "finish.refused")
      state.turns.push({
        turn: null,
        refused: Array.isArray(d.issues)
          ? d.issues
          : [d.reason || "Report needs revision"],
      });
    else if (stage === "call.failed")
      state.turns.push({ turn: null, failed: `${d.tool}: ${d.error || ""}` });
    else if (stage === "tool.start") {
      const type = d.kind === "agent" ? "agent" : "tool";
      put({
        key: d.id,
        type,
        tool: d.tool,
        label: agentName(d.tool),
        title: d.label || "",
        args: d.args || {},
        inputs: d.inputs?.length ? d.inputs : ["query"],
        outputs: [],
        status: "running",
        startedAt: event.createdAt,
      });
    } else if (stage === "tool.done") {
      const call = state.byKey.get(d.id);
      if (call) {
        call.status = "done";
        call.ms = d.ms;
      }
      const a = d.artifact;
      if (a) {
        if (call && !call.outputs.includes(a.id)) call.outputs.push(a.id);
        const node = put({
          key: a.id,
          type: a.kind === "figure" ? "figure" : "data",
          kind: a.kind,
          label: a.label,
          title: a.title || a.label,
          description: a.description || "",
          size: a.size,
          inputs: [d.id],
          status: "done",
          rows: a.rows,
          columns: a.columns || [],
          sample: a.sample || [],
          sampleColumns: a.sample_columns || [],
          text: a.text,
          images: a.images || [],
          searchUrl: a.search_url,
          query: a.query,
          artifactUuid: a.artifact_uuid,
          from: call
            ? { tool: call.tool, args: call.args, inputs: call.inputs }
            : null,
        });
        state.artifactsById.set(a.id, node);
      }
    } else if (stage === "tool.failed") {
      const call = state.byKey.get(d.id);
      if (call) {
        call.status = "failed";
        call.error = d.error;
        call.ms = d.ms;
      }
    } else if (stage.startsWith("agent.") && d.id) {
      if (!state.trails.has(d.id)) state.trails.set(d.id, []);
      state.trails.get(d.id).push({
        stage: stage.slice(6),
        label: d.label || "",
        message: d.message || "",
      });
    } else if (stage === "finish") {
      state.finish = d;
      const incomplete =
        d.outcome === "incomplete" ||
        d.budget_exhausted === true ||
        d.unverified_numbers?.length > 0;
      put({
        key: "finish",
        type: "finish",
        label: incomplete ? "Study incomplete" : "Study complete",
        inputs: [],
        status: "done",
        summary: d.summary || "",
      });
      state.phase = incomplete ? "incomplete" : "done";
    } else if (stage === "error") {
      state.error = d.message || event.message || "The study failed.";
      state.failed = true;
      state.phase = "failed";
    }
  }
  if (state.failed) state.phase = "failed";
  else if (state.complete && state.phase !== "incomplete") state.phase = "done";
  return state;
}
export function studyStatusLine(events) {
  const s = studyStateFromEvents(events);
  if (s.phase === "failed") return "Study failed";
  if (s.phase === "incomplete") return "Study incomplete";
  if (s.phase === "done") return "Study complete";
  const running = s.islands.filter((i) => i.status === "running");
  if (running.length)
    return `${running
      .map((i) => i.label.toLowerCase())
      .slice(0, 3)
      .join(
        ", ",
      )}${running.length > 3 ? ` +${running.length - 3}` : ""} running · ${s.artifactsById.size} artifacts`;
  if (s.turns.length)
    return `turn ${s.turns.length} · ${s.artifactsById.size} artifacts`;
  return "Starting the study";
}

export const NODE_WIDTH = 218;
const OUTPUT_WIDTH = 164;
const GAP = 24,
  PAD = 30;
// Outputs are independent islands: step -> output -> consuming step.
// Each level wraps to the viewport while keeping every dependency below its source.
export function layoutStudy(state, availableWidth, nodeHeights) {
  const nodes = state.islands.filter((n) =>
    ["query", "agent", "tool", "data", "figure", "finish"].includes(n.type),
  );
  const nodeKeys = new Set(nodes.map((n) => n.key));
  const measured = nodes.every((node) => nodeHeights.has(node.key));
  const parents = new Map(),
    depth = new Map(),
    consumed = new Set();
  for (const node of nodes) {
    const inputs = [...new Set(node.inputs)].filter((key) => nodeKeys.has(key));
    parents.set(node.key, inputs);
    inputs.forEach((key) => consumed.add(key));
    depth.set(
      node.key,
      node.key === "query"
        ? 0
        : Math.max(0, ...inputs.map((key) => depth.get(key) || 0)) + 1,
    );
  }
  if (state.byKey.has("finish")) {
    parents.set(
      "finish",
      nodes
        .filter((n) => n.type !== "finish" && !consumed.has(n.key))
        .map((n) => n.key),
    );
    depth.set("finish", Math.max(...depth.values()) + 1);
  }
  const levels = new Map();
  nodes.forEach((n) => {
    const level = depth.get(n.key);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(n);
  });
  const width = Math.max(availableWidth, NODE_WIDTH + PAD * 2),
    positions = new Map();
  const nodeWidth = (node) =>
    state.artifactsById.has(node.key) ? OUTPUT_WIDTH : NODE_WIDTH;
  let y = PAD;
  for (const [, list] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    const rows = [];
    let row = [],
      rowWidth = 0;
    for (const node of list) {
      if (row.length && rowWidth + GAP + nodeWidth(node) > width - PAD * 2) {
        rows.push({ nodes: row, width: rowWidth });
        row = [];
        rowWidth = 0;
      }
      rowWidth += (row.length ? GAP : 0) + nodeWidth(node);
      row.push(node);
    }
    rows.push({ nodes: row, width: rowWidth });
    for (const row of rows) {
      let height = 0,
        x = (width - row.width) / 2;
      for (const node of row.nodes) {
        // Unmeasured nodes render hidden until their natural height is read.
        const h = nodeHeights.has(node.key) ? nodeHeights.get(node.key) : 0;
        positions.set(node.key, {
          x,
          y,
          width: nodeWidth(node),
          height: h,
        });
        x += nodeWidth(node) + GAP;
        height = Math.max(height, h);
      }
      y += height + 40;
    }
  }
  const edges = [];
  nodes.forEach((node) =>
    (parents.get(node.key) || []).forEach((parent) => {
      const a = positions.get(parent),
        b = positions.get(node.key);
      if (!a || !b) return;
      const x1 = a.x + a.width / 2,
        y1 = a.y + a.height,
        x2 = b.x + b.width / 2,
        y2 = b.y,
        bend = Math.max(24, (y2 - y1) * 0.48);
      edges.push({
        key: `${parent}:${node.key}`,
        from: parent,
        to: node.key,
        path: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`,
      });
    }),
  );
  return { nodes, positions, edges, width, height: y - 22, measured };
}
