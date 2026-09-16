import { studyStateFromEvents } from "./studyRunModel";

// Artifact IDs are local to a run. Never search neighboring answers or another
// study for an ID that is absent from the answer's recorded run.
export function studyRunsById(messages) {
  const runs = new Map();
  for (const message of messages) {
    const event = message.type === "tool" ? message.toolEvent : null;
    if (event?.toolName !== "aso_hpa" || !event.runId) continue;
    if (!runs.has(event.runId)) runs.set(event.runId, { events: [] });
    runs.get(event.runId).events.push(event);
  }
  for (const run of runs.values()) {
    run.artifacts = studyStateFromEvents(run.events).artifactsById;
  }
  return runs;
}

// Work on Markdown text nodes so code, image labels, and existing links keep
// their original meaning. Generated citation nodes contain no model-supplied URL.
export function remarkStudyCitations() {
  const excluded = new Set([
    "link", "linkReference", "image", "imageReference", "definition",
    "code", "inlineCode", "html",
  ]);
  const split = (text) => {
    const parts = [];
    let end = 0;
    for (const match of text.matchAll(/\[(a\d+(?:\s*[,;]\s*a\d+)*)\]/g)) {
      if (match.index > end)
        parts.push({ type: "text", value: text.slice(end, match.index) });
      match[1].split(/\s*[,;]\s*/).forEach((artifactId, index) => {
        if (index > 0) parts.push({ type: "text", value: " " });
        parts.push({
          type: "studyCitation",
          data: {
            hName: "study-citation",
            hProperties: { "data-artifact-id": artifactId },
          },
          children: [{ type: "text", value: `[${artifactId}]` }],
        });
      });
      end = match.index + match[0].length;
    }
    if (end < text.length) parts.push({ type: "text", value: text.slice(end) });
    return parts;
  };
  const visit = (node) => {
    if (excluded.has(node.type) || !node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child.value);
      visit(child);
      return [child];
    });
  };
  return visit;
}
