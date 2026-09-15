import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Inspector } from "./StudyRunDetails";
import { OperationDetails, OperationSummary } from "./StudyOperation";
import {
  CONDITION_NAMES,
  OPERATION_NAMES,
  operationDetails,
  operationResult,
  readableDescription,
  recordedValue,
} from "./studyOperations";
import { nodeTitle, studyStateFromEvents } from "./studyRunModel";
import { traceForNode } from "./studyTraceModel";

jest.mock("../api/auth", () => ({
  authenticatedDownload: jest.fn(),
  authenticatedFetch: jest.fn(),
}));

const event = (stage, data) => ({ stage, message: JSON.stringify(data) });
const start = (id, tool, args, inputs = [], kind = "tool") =>
  event("tool.start", { id, tool, args, inputs, kind });
const done = (id, artifact, extra = {}) =>
  event("tool.done", {
    id,
    ms: 15,
    artifact: {
      id: artifact,
      kind: "data",
      title: "Shared title",
      rows: 2,
      ...extra,
    },
  });
const correlationArgs = {
  artifact: "a9",
  x: "BRCA1_nTPM",
  y: "TP53_nTPM",
  method: "spearman",
};
const callText =
  "correlate(artifact=a9, x=BRCA1_nTPM, y=TP53_nTPM, method=spearman)";
const correlation = done("t6", "a12", {
  title: callText,
  description: callText,
  rows: 1,
  columns: ["x", "y", "method", "n", "r", "p_value"],
  sample_columns: ["x", "y", "method", "n", "r", "p_value"],
  sample: [["BRCA1_nTPM", "TP53_nTPM", "spearman", "51", "0", "—"]],
});
function recordedStudy() {
  return studyStateFromEvents([
    event("start", { goal: "Compare BRCA1 and TP53 expression." }),
    event("turn", { turn: 1, text: "Read both genes from the atlas." }),
    start(
      "t1",
      "investigator_hpa",
      { question: "BRCA1 and TP53 tissue RNA" },
      [],
      "agent",
    ),
    event("agent.execution_step", {
      id: "t1",
      label: "Reading measurements",
      message: "Read the consensus RNA table.",
    }),
    done("t1", "a1"),
    event("turn", {
      turn: 2,
      text: "Align the two genes by tissue before testing their association.",
    }),
    start(
      "t2",
      "filter",
      { artifact: "a1", where: [{ column: "gene", op: "=", value: "BRCA1" }] },
      ["a1"],
    ),
    done("t2", "a2"),
    start(
      "t3",
      "filter",
      { artifact: "a1", where: [{ column: "gene", op: "=", value: "TP53" }] },
      ["a1"],
    ),
    done("t3", "a3"),
    start("t4", "join", { a: "a2", b: "a3", on: "Tissue", how: "inner" }, [
      "a2",
      "a3",
    ]),
    done("t4", "a9"),
    start(
      "unrelated",
      "compute",
      { artifact: "a1", name: "elsewhere", expr: "1" },
      ["a1"],
    ),
    done("unrelated", "a99"),
    event("turn", {
      turn: 3,
      text: "Compare their ranks using Spearman correlation.",
    }),
    start("t6", "correlate", correlationArgs, ["a9"]),
    correlation,
    event("finish", { outcome: "completed" }),
  ]);
}

test("the artifact uses its producing operation, with variables and recorded statistics, instead of repeating a call string", () => {
  const state = recordedStudy(),
    node = state.byKey.get("a12");
  expect(nodeTitle(node)).toBe("Spearman correlation");
  expect(readableDescription(node)).toBe("");
  expect(operationDetails(node).relation).toEqual({
    left: "BRCA1_nTPM",
    symbol: "↔",
    right: "TP53_nTPM",
  });
  const stats = operationResult(node);
  expect(stats.map((s) => [s.label, recordedValue(s.value)])).toEqual([
    ["ρ", "0"],
    ["n", "51"],
    ["p", "Not available"],
  ]);
  expect(operationResult({ ...node, rows: 2 })).toEqual([]);
  expect(operationResult({ ...node, sample: [] })).toEqual([]);
  expect(
    operationResult({ ...node, sampleColumns: ["x"], sample: [["BRCA1"]] }),
  ).toEqual([]);
});

test("every ASO table operation has a structured presentation, independent of a freeform title", () => {
  const cases = {
    combine: { a: "a1", b: "a2", how: "intersect" },
    join: { a: "a1", b: "a2", on_columns: ["gene", "Tissue"] },
    filter: { artifact: "a1", where: [{ column: "nTPM", op: ">=", value: 0 }] },
    select: { artifact: "a1", columns: ["gene"], rename: { gene: "symbol" } },
    rank: {
      artifact: "a1",
      by: "nTPM",
      top: 10,
      then_by: [{ column: "ensembl", order: "asc" }],
    },
    aggregate: {
      artifact: "a1",
      metrics: ["mean", "numeric_count"],
      column: "nTPM",
      group_by_columns: ["gene", "Tissue"],
    },
    classify: { artifact: "a1", name: "category", rules: [], otherwise: 0 },
    compute: { artifact: "a1", name: "ratio", expr: "a / b" },
    pivot: { artifact: "a1", row: "gene", column: "Tissue", value: "nTPM" },
    chart: { artifact: "a1", type: "scatter", x: "BRCA1", y: "TP53" },
    correlate: correlationArgs,
    overlap: { a: "a1", b: "a2", universe: "a3" },
    explode: { artifact: "a1", column: "Protein class", as: "class" },
  };
  expect(Object.keys(cases).sort()).toEqual(
    Object.keys(OPERATION_NAMES).sort(),
  );
  for (const [tool, args] of Object.entries(cases)) {
    const info = operationDetails({
      type: "tool",
      tool,
      args,
      title: `${tool}(freeform)`,
    });
    expect(info.title).not.toMatch(/\(|Unrecognized/);
    expect(info.facts.length + (info.relation ? 1 : 0)).toBeGreaterThan(0);
  }
  expect(CONDITION_NAMES.is_non_numeric).toBe("is not numeric");
  expect(
    operationDetails({
      type: "tool",
      tool: "rank",
      args: { by: "nTPM", group_by: "gene" },
    }).title,
  ).toBe("Top 1 by nTPM");
  expect(
    operationDetails({
      type: "tool",
      tool: "rank",
      args: { by: "nTPM", top: 0 },
    }).title,
  ).toBe("Rank by nTPM");
  expect(
    operationDetails({ type: "tool", tool: "future_operation", args: {} })
      .title,
  ).toBe("Unrecognized operation");
});

test.each([
  ["asc", "Ascending"],
  ["desc", "Descending"],
])(
  "ranking %s uses a horizontal arrow and keeps its ordering explicit",
  (order, label) => {
    const node = {
      type: "tool",
      tool: "rank",
      args: { by: "nTPM", order, top: 10 },
    };
    expect(operationDetails(node).relation.symbol).toBe("→");
    render(<OperationSummary node={node} />);
    expect(screen.getByText(`Order: ${label}`)).toBeVisible();
  },
);

test("trace retains both join inputs, shared ancestors once, original agent activity and decisions, excluding unrelated work", () => {
  const state = recordedStudy(),
    trace = traceForNode(state, "a12");
  expect(trace.steps.map((s) => s.node.key)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
    "t6",
  ]);
  expect(trace.nodes.map((n) => n.key)).toEqual([
    "query",
    "t1",
    "a1",
    "t2",
    "a2",
    "t3",
    "a3",
    "t4",
    "a9",
    "t6",
    "a12",
  ]);
  expect(trace.steps[0].events.map((e) => e.stage)).toEqual([
    "tool.start",
    "agent.execution_step",
    "tool.done",
  ]);
  expect(trace.steps[4].decision).toMatch(/Spearman/);
  expect(trace.steps[3].outputs.map((n) => n.key)).toEqual(["a9"]);
  expect(trace.missing).toEqual([]);
  expect(trace.cycles).toEqual([]);
  expect(traceForNode(state, "t4").steps.map((s) => s.node.key)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
  ]);
  state.byKey.get("t4").inputs.reverse();
  expect(traceForNode(state, "a12").steps.map((s) => s.node.key)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
    "t6",
  ]);
});

test("compact filters distinguish the gene branches and renames remain readable", () => {
  const state = recordedStudy();
  const { rerender } = render(
    <OperationSummary node={state.byKey.get("a2")} />,
  );
  expect(screen.getByText(/= BRCA1/)).toBeVisible();
  rerender(<OperationSummary node={state.byKey.get("a3")} />);
  expect(screen.getByText(/= TP53/)).toBeVisible();
  expect(screen.queryByText(/BRCA1/)).not.toBeInTheDocument();
  rerender(
    <OperationSummary
      node={{
        type: "tool",
        tool: "select",
        args: { rename: { nTPM: "TP53_nTPM" } },
      }}
    />,
  );
  expect(screen.getByText("Rename: nTPM → TP53 nTPM")).toBeVisible();
});

test("classification renders its ordered rules and zero default as structured values", () => {
  render(
    <OperationDetails
      node={{
        type: "tool",
        tool: "classify",
        args: {
          artifact: "a1",
          name: "detected",
          otherwise: 0,
          rules: [
            { where: [{ column: "nTPM", op: ">=", value: 1 }], value: 1 },
          ],
        },
      }}
      state={recordedStudy()}
      onSelect={jest.fn()}
    />,
  );
  expect(
    screen.getByText("1 classification rule · first match wins"),
  ).toBeVisible();
  expect(screen.getByText("≥")).toBeVisible();
  expect(screen.getByText("Otherwise")).toBeVisible();
  expect(screen.getByText("0")).toBeVisible();
  expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
});

test("trace diagnoses missing producers and cycles and still follows the artifact's recorded source IDs", () => {
  const state = recordedStudy();
  state.byKey.delete("t6");
  state.byKey.get("a12").sourceInputs = ["a9"];
  expect(traceForNode(state, "a12").missing).toEqual(["t6"]);
  expect(traceForNode(state, "a12").steps.map((s) => s.node.key)).toEqual([
    "t1",
    "t2",
    "t3",
    "t4",
  ]);
  state.byKey.get("a1").sourceInputs = ["a12"];
  expect(traceForNode(state, "a12").cycles).toEqual(["a12"]);
});

test("restoring and extending a run preserves node lineage and does not invent future steps", () => {
  const state = recordedStudy();
  const events = [
    event("start", { goal: "Live study" }),
    start("t6", "correlate", correlationArgs, ["a9"]),
  ];
  const running = studyStateFromEvents(events);
  expect(running.byKey.get("t6").status).toBe("running");
  expect(traceForNode(running, "t6").missing).toEqual(["a9"]);
  const complete = studyStateFromEvents([...events, correlation]);
  expect(nodeTitle(complete.byKey.get("a12"))).toBe(
    nodeTitle(state.byKey.get("a12")),
  );
  expect(traceForNode(complete, "a12").steps[0].outputs[0].key).toBe("a12");
});

test("the inspector exposes readable results and a navigable trace, with expandable source history", () => {
  const state = recordedStudy(),
    onSelect = jest.fn();
  const original = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = jest.fn();
  try {
    render(
      <Inspector
        node={state.byKey.get("a12")}
        state={state}
        onSelect={onSelect}
        pinned
        live={false}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Spearman correlation" }),
    ).toBeVisible();
    expect(screen.getByText("BRCA1 nTPM")).toBeVisible();
    expect(screen.getByText("TP53 nTPM")).toBeVisible();
    expect(screen.queryByText(callText)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View trace" }));
    expect(screen.getByText("Artifact trace")).toBeVisible();
    expect(screen.getByText("1", { selector: "b" })).toBeVisible();
    const lookup = screen.getByRole("group", { name: "Step 1: Investigator" });
    fireEvent.click(
      within(lookup).getByText("Investigator", { selector: "strong" }),
    );
    fireEvent.click(within(lookup).getByText("Recorded history"));
    expect(
      within(lookup).getByText("Read the consensus RNA table."),
    ).toBeVisible();
    fireEvent.click(
      within(lookup).getAllByRole("button", {
        name: "Inspect source a1: Shared title",
      })[0],
    );
    expect(onSelect).toHaveBeenCalledWith("a1");
    fireEvent.click(screen.getByRole("button", { name: "Back to details" }));
    expect(screen.getByRole("button", { name: "View trace" })).toBeVisible();
  } finally {
    HTMLElement.prototype.scrollTo = original;
  }
});
