import {
  layoutStudy,
  studyStateFromEvents,
  studyStatusLine,
} from "./studyRunModel";

const finish = (data) => ({ stage: "finish", message: JSON.stringify(data) });

test("a completed request does not overwrite an incomplete study outcome", () => {
  const events = [
    finish({
      outcome: "incomplete",
      incomplete_reason: "turn_budget_exhausted",
    }),
    { status: "completed" },
  ];
  expect(studyStateFromEvents(events).phase).toBe("incomplete");
  expect(studyStatusLine(events)).toBe("Study incomplete");
});

test("saved budget-exhausted runs are also shown as incomplete", () => {
  expect(studyStateFromEvents([finish({ budget_exhausted: true })]).phase).toBe(
    "incomplete",
  );
  expect(
    studyStateFromEvents([finish({ unverified_numbers: ["17.3"] })]).phase,
  ).toBe("incomplete");
  expect(studyStatusLine([finish({ outcome: "completed" })])).toBe(
    "Study complete",
  );
});

test("a request failure takes precedence over an incomplete finish", () => {
  expect(
    studyStatusLine([
      finish({ outcome: "incomplete" }),
      { status: "completed", failed: true, message: "Storage failed" },
    ]),
  ).toBe("Study failed");
});

const event = (stage, data) => ({ stage, message: JSON.stringify(data) });
const agent = event("tool.start", {
  id: "t1",
  kind: "agent",
  tool: "investigator_hpa",
  label: "Compare measurements",
  inputs: [],
});
const output = (id) =>
  event("tool.done", {
    id: "t1",
    artifact: { id, kind: "data", title: `Measurements ${id}`, rows: 0 },
  });

test("a single agent retains every output, including empty tables and repeated delivery", () => {
  const state = studyStateFromEvents([
    agent,
    output("a1"),
    output("a2"),
    output("a3"),
    output("a1"),
  ]);
  expect(state.byKey.get("t1").outputs).toEqual(["a1", "a2", "a3"]);
  expect(state.artifactsById.size).toBe(3);
  expect(state.islands.filter((n) => n.key === "a1")).toHaveLength(1);
  expect(state.artifactsById.get("a1").rows).toBe(0);
});

test("output islands connect their producer and consumers through a join without overlapping", () => {
  const state = studyStateFromEvents([
    agent,
    output("a1"),
    output("a2"),
    event("tool.start", {
      id: "t2",
      kind: "tool",
      tool: "select",
      inputs: ["a1"],
    }),
    event("tool.done", {
      id: "t2",
      artifact: { id: "a3", kind: "data", rows: 2 },
    }),
    event("tool.start", {
      id: "t3",
      kind: "tool",
      tool: "join",
      inputs: ["a2", "a3"],
    }),
    finish({ outcome: "completed" }),
  ]);
  const heights = new Map(
    state.islands.map((node, index) => [node.key, 65 + index * 19]),
  );
  for (const width of [300, 580, 1100]) {
    const layout = layoutStudy(state, width, heights);
    expect(layout.measured).toBe(true);
    layout.nodes.forEach((node) => {
      expect(layout.positions.get(node.key).height).toBe(heights.get(node.key));
    });
    expect(
      layout.nodes.filter((n) => n.type === "data").map((n) => n.key),
    ).toEqual(["a1", "a2", "a3"]);
    expect(layout.edges.map((e) => `${e.from}:${e.to}`)).toEqual(
      expect.arrayContaining([
        "t1:a1",
        "t1:a2",
        "a1:t2",
        "t2:a3",
        "a2:t3",
        "a3:t3",
        "t3:finish",
      ]),
    );
    for (const edge of layout.edges) {
      const source = layout.positions.get(edge.from),
        target = layout.positions.get(edge.to);
      expect(target.y).toBeGreaterThan(source.y + source.height);
    }
    const boxes = [...layout.positions.values()];
    boxes.forEach((a, index) => {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
      boxes.slice(index + 1).forEach((b) => {
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true);
      });
    });
  }
});

test("the layout waits for measurement and moves outputs when their producer changes height", () => {
  const state = studyStateFromEvents([agent, output("a1")]);
  const heights = new Map([
    ["query", 74],
    ["t1", 99],
  ]);
  expect(layoutStudy(state, 580, heights).measured).toBe(false);
  heights.set("a1", 82);
  const before = layoutStudy(state, 580, heights);
  heights.set("t1", 147);
  const after = layoutStudy(state, 580, heights);
  expect(after.measured).toBe(true);
  expect(after.positions.get("a1").y - before.positions.get("a1").y).toBe(48);
  expect(after.height - before.height).toBe(48);
  expect(after.edges.find((edge) => edge.from === "t1").path).not.toBe(
    before.edges.find((edge) => edge.from === "t1").path,
  );
});

test("plan updates preserve one plan and do not erase a failed call", () => {
  const state = studyStateFromEvents([
    agent,
    event("plan", { items: [{ text: "Compare", status: "todo" }] }),
    event("tool.failed", { id: "t1", error: "No matching data", ms: 12 }),
    event("plan", { items: [{ text: "Compare", status: "dropped" }] }),
  ]);
  expect(state.islands.filter((n) => n.type === "plan")).toHaveLength(1);
  expect(state.plan[0].status).toBe("dropped");
  expect(state.byKey.get("t1").error).toBe("No matching data");
  expect(state.byKey.get("t1").status).toBe("failed");
});
