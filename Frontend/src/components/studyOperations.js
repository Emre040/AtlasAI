// Presentation of the recorded ASO operation contract. Labels are never parsed
// into arguments: tool.start is the source for both live and restored studies.
export const OPERATION_NAMES = {
  combine: "Combine tables",
  join: "Join tables",
  filter: "Filter rows",
  select: "Choose columns",
  rank: "Rank rows",
  aggregate: "Summarize measurements",
  classify: "Classify rows",
  compute: "Calculate a column",
  pivot: "Build a matrix",
  chart: "Draw a chart",
  correlate: "Correlation",
  overlap: "Test overlap",
  explode: "Expand list values",
};

export const CHART_NAMES = {
  bar: "Bar chart",
  lollipop: "Lollipop chart",
  dot_plot: "Dot plot",
  diverging_bar: "Diverging bar chart",
  grouped_bar: "Grouped bar chart",
  scatter: "Scatter plot",
  bubble: "Bubble chart",
  heatmap: "Heatmap",
  radar: "Radar chart",
  line: "Line chart",
  volcano: "Volcano plot",
};

const METRICS = {
  count: "Row count",
  recorded: "Recorded values",
  numeric_count: "Numeric values",
  missing: "Missing values",
  zero: "Zeros",
  distinct: "Distinct values",
  sum: "Sum",
  mean: "Mean",
  median: "Median",
  min: "Minimum",
  max: "Maximum",
  sd: "Standard deviation",
  q1: "First quartile",
  q3: "Third quartile",
};
export const CONDITION_NAMES = {
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  "=": "=",
  "!=": "≠",
  contains: "contains",
  in: "is one of",
  is_missing: "is missing",
  is_present: "is present",
  is_numeric: "is numeric",
  is_non_numeric: "is not numeric",
};
export const words = (value) => String(value).replace(/_/g, " ");
const list = (value) =>
  Array.isArray(value) ? value : value == null ? [] : [value];
const direction = (value) => (value === "asc" ? "Ascending" : "Descending");

export function operationOf(node) {
  if (node.type === "tool") return { tool: node.tool, args: node.args || {} };
  if (node.from && OPERATION_NAMES[node.from.tool]) return node.from;
  return null;
}

export function operationDetails(node) {
  const operation = operationOf(node);
  if (!operation) return null;
  const { tool, args: a } = operation;
  const info = {
    tool,
    title: OPERATION_NAMES[tool] || "Unrecognized operation",
    facts: [],
    inputs: [],
    relation: null,
  };
  const fact = (label, value, kind = "text") =>
    info.facts.push({ label, value, kind });
  const optional = (label, value, kind) => {
    if (value !== undefined && value !== null && value !== "")
      fact(label, value, kind);
  };
  const relation = (left, symbol, right) => {
    info.relation = { left, symbol, right };
  };
  for (const [key, label] of [
    ["artifact", "Source table"],
    ["a", "Left table"],
    ["b", "Right table"],
    ["universe", "Universe"],
  ]) {
    if (a[key]) info.inputs.push({ id: a[key], label });
  }
  switch (tool) {
    case "correlate":
      info.title = `${a.method === "spearman" ? "Spearman" : "Pearson"} correlation`;
      relation(a.x, "↔", a.y);
      fact(
        "Method",
        a.method === "spearman"
          ? "Spearman · ranked values"
          : "Pearson · linear relationship",
      );
      optional("Within each", a.group_by, "column");
      break;
    case "rank": {
      const top = a.group_by && a.top === undefined ? 1 : a.top;
      info.title =
        top > 0
          ? `Top ${top} by ${words(a.by)}`
          : `Rank by ${words(a.by || "column")}`;
      relation(a.by, "→", top > 0 ? `Top ${top}` : "All rows");
      fact("Order", direction(a.order));
      fact(
        "Boundary ties",
        a.ties === "truncate" ? "Stop at the limit" : "Include tied rows",
      );
      optional("Within each", a.group_by, "column");
      if (a.then_by?.length)
        fact(
          "Break ties by",
          a.then_by.map((r) => ({
            label: r.column,
            value: `${direction(r.order || "asc")}${r.type ? ` · ${r.type}` : ""}`,
          })),
          "pairs",
        );
      break;
    }
    case "chart":
      info.title = CHART_NAMES[a.type] || "Unrecognized chart";
      if (a.x || a.y) relation(a.x, "×", a.y || (a.series || []).join(" · "));
      optional("X axis", a.x_label);
      optional("Y axis", a.y_label);
      optional("Series", a.series, "columns");
      optional("Group / colour", a.group, "column");
      optional("Point size", a.size, "column");
      optional("Point labels", a.label, "column");
      optional("X scale", a.x_scale);
      optional("Y scale", a.y_scale);
      optional("Colour scale", a.scale);
      fact(
        "Missing values",
        a.missing === "omit"
          ? "Omit rows without numeric values"
          : "Require numeric values",
      );
      break;
    case "join":
      info.title =
        {
          inner: "Join matching rows",
          left: "Join · keep all left rows",
          right: "Join · keep all right rows",
          full: "Join · keep all rows",
          cross: "Pair every row",
        }[a.how || "inner"] || "Join tables";
      relation(a.a, a.how === "cross" ? "×" : "⋈", a.b);
      fact(
        "Match on",
        a.how === "cross"
          ? "Every combination"
          : a.on_columns?.length
            ? a.on_columns
            : a.on || "Entity identity",
        a.on_columns?.length ? "columns" : "text",
      );
      if (a.on_columns?.length && a.on) fact("Other key", a.on, "column");
      break;
    case "combine":
      info.title =
        {
          concat: "Stack tables",
          intersect: "Keep matching rows",
          difference: "Keep left-only rows",
        }[a.how] || "Combine tables";
      relation(
        a.a,
        { concat: "+", intersect: "∩", difference: "−" }[a.how] || "→",
        a.b,
      );
      fact("Match on", a.on || "Entity identity");
      optional("Source label column", a.label, "column");
      break;
    case "filter": {
      info.conditions = [
        { label: "All of these", clauses: a.where || [] },
        { label: "At least one of these", clauses: a.any || [] },
      ].filter((g) => g.clauses.length);
      const count = (a.where || []).length + (a.any || []).length;
      fact(
        "Keep rows matching",
        `${count} ${count === 1 ? "condition" : "conditions"}`,
      );
      break;
    }
    case "select":
      if (a.rename && Object.keys(a.rename).length && !a.columns?.length)
        info.title = "Rename columns";
      fact(
        "Keep",
        a.columns?.length ? a.columns : "All columns",
        a.columns?.length ? "columns" : "text",
      );
      if (a.rename && Object.keys(a.rename).length)
        fact(
          "Rename",
          Object.entries(a.rename).map(([label, value]) => ({ label, value })),
          "renames",
        );
      if (a.add && Object.keys(a.add).length)
        fact(
          "Add labels",
          Object.entries(a.add).map(([label, value]) => ({ label, value })),
          "pairs",
        );
      break;
    case "aggregate":
      fact(
        "Statistics",
        list(a.metrics).map((m) => METRICS[m] || words(m)),
        "columns",
      );
      optional("Measure", a.column, "column");
      fact(
        "Group by",
        a.group_by_columns?.length
          ? a.group_by_columns
          : a.group_by || "Whole table",
        a.group_by_columns?.length ? "columns" : "text",
      );
      if (a.group_domains?.length)
        fact(
          "Include empty groups",
          a.group_domains.map((d) => ({ label: d.column, value: d.values })),
          "pairs",
        );
      break;
    case "classify":
      info.title = a.name ? `Classify ${words(a.name)}` : "Classify rows";
      info.rules = a.rules || [];
      fact("New column", a.name, "column");
      fact("Otherwise", a.otherwise);
      break;
    case "compute":
      info.title = a.name ? `Calculate ${words(a.name)}` : "Calculate a column";
      info.formula = a.expr;
      fact("New column", a.name, "column");
      break;
    case "pivot":
      relation(a.row || "gene", "×", a.column);
      fact("Cell values", a.value, "column");
      break;
    case "overlap":
      relation(a.a, "∩", a.b);
      fact("Test", "Hypergeometric · over-representation");
      fact("Match on", a.on || "Entity identity");
      if (!a.universe) fact("Universe", "All entities in the atlas");
      optional("Within each", a.group_by, "column");
      break;
    case "explode":
      relation(a.column, "→", "One row per item");
      fact("Column prefix", a.as || a.column, "column");
      fact("Output", "One row per list item");
      break;
    default:
      fact("Recorded operation", tool);
  }
  return info;
}

export function isCallLabel(text) {
  return /^\s*[a-z_]+\s*\(/i.test(text || "");
}

export function readableDescription(node) {
  if (operationOf(node)) return "";
  const description = node.description || node.args?.description || "";
  return isCallLabel(description) || description === node.title
    ? ""
    : description;
}

// Only show a statistic if its column and a single result row were actually
// recorded. Missing samples never become zeros or inferred measurements.
export function operationResult(node) {
  const operation = operationOf(node);
  if (!operation || node.rows !== 1 || node.sample?.length !== 1) return [];
  const columns = node.sampleColumns || [];
  const cell = (column) => node.sample[0][columns.indexOf(column)];
  const keys =
    operation.tool === "correlate"
      ? [
          [
            "r",
            operation.args.method === "spearman" ? "ρ" : "r",
            "Correlation",
          ],
          ["n", "n", "Complete pairs"],
          ["p_value", "p", "p-value"],
        ]
      : operation.tool === "overlap"
        ? [
            ["shared", "Shared", "Entities in both sets"],
            ["expected", "Expected", "Under the null model"],
            ["p_value", "p", "p-value"],
          ]
        : [];
  return keys
    .filter(([column]) => columns.includes(column))
    .map(([column, label, caption]) => ({
      column,
      label,
      caption,
      value: cell(column),
    }));
}

export function recordedValue(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "NA" ||
    value === "—"
  )
    return "Not available";
  return String(value);
}
