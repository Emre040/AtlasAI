import React, { useEffect, useMemo, useRef } from "react";
import { nodeTitle } from "./studyRunModel";
import { traceForNode } from "./studyTraceModel";
import { operationOf, words } from "./studyOperations";
import {
  OperationDetails,
  OperationSummary,
  SourceButton,
} from "./StudyOperation";

const EVENT_NAMES = {
  "tool.start": "Started",
  "tool.done": "Output saved",
  "tool.failed": "Failed",
};

function EventTime({ value }) {
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}

export default function StudyTrace({ node, state, live, onBack, onSelect }) {
  const trace = useMemo(() => traceForNode(state, node.key), [state, node.key]);
  const heading = useRef(null);
  useEffect(() => {
    heading.current
      ?.closest(".HPAG-aso-inspector-scroll")
      ?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, []);
  const sources = trace.steps.filter(
    (step) => step.node.type === "agent",
  ).length;
  return (
    <div className="HPAG-aso-node-trace">
      <button type="button" className="HPAG-aso-trace-back" onClick={onBack}>
        <span aria-hidden="true">←</span> Back to details
      </button>
      <div className="HPAG-aso-eyebrow">
        {node.type === "data" || node.type === "figure"
          ? "Artifact trace"
          : "Step trace"}{" "}
        <code>{node.key}</code>
      </div>
      <h3 ref={heading} tabIndex={-1}>
        {nodeTitle(node)}
      </h3>
      <p className="HPAG-aso-trace-intro">
        Follow the sources and recorded steps behind this{" "}
        {node.type === "tool" || node.type === "agent" ? "step" : "result"}.
      </p>
      <div className="HPAG-aso-trace-counts">
        <span>
          <b>{sources}</b> source {sources === 1 ? "lookup" : "lookups"}
        </span>
        <span>
          <b>{trace.steps.length}</b>{" "}
          {trace.steps.length === 1 ? "step" : "steps"}
        </span>
      </div>
      {trace.missing.length > 0 && (
        <p className="HPAG-aso-error" role="status">
          The saved events do not include {trace.missing.join(", ")}. This trace
          is incomplete.
        </p>
      )}
      {trace.cycles.length > 0 && (
        <p className="HPAG-aso-error" role="status">
          Circular dependency recorded at {trace.cycles.join(", ")}. Check the
          saved run.
        </p>
      )}
      {trace.nodes.some((n) => n.type === "query") && (
        <details className="HPAG-aso-trace-question">
          <summary>Research question</summary>
          <p>{state.goal || "The question was not recorded."}</p>
        </details>
      )}
      {!trace.steps.length && (
        <p className="HPAG-aso-muted">
          No producing steps are recorded for this node.
        </p>
      )}
      <ol className="HPAG-aso-trace-steps">
        {trace.steps.map((step, index) => (
          <li key={step.node.key}>
            <span
              className={`HPAG-aso-trace-marker type-${step.node.type}`}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <details
              className={`HPAG-aso-trace-step type-${step.node.type}`}
              aria-label={`Step ${index + 1}: ${nodeTitle(step.node)}`}
              open={index === trace.steps.length - 1}
            >
              <summary>
                <span className="HPAG-aso-eyebrow">
                  {step.node.type === "agent" ? "Source lookup" : "Operation"}
                  <code>{step.node.key}</code>
                  {step.node.turn && <span>Turn {step.node.turn}</span>}
                </span>
                <strong>{nodeTitle(step.node)}</strong>
                <OperationSummary node={step.node} />
                <span className="HPAG-aso-trace-step-state">
                  {step.node.status === "done"
                    ? "Complete"
                    : step.node.status === "running" && !live
                      ? "Stopped"
                      : words(step.node.status)}
                  {step.node.ms !== undefined &&
                    ` · ${(step.node.ms / 1000).toFixed(1)}s`}
                  <span aria-hidden="true">⌄</span>
                </span>
              </summary>
              <div className="HPAG-aso-trace-step-body">
                {operationOf(step.node) ? (
                  <OperationDetails
                    node={step.node}
                    state={state}
                    onSelect={onSelect}
                  />
                ) : (
                  <>
                    <p>
                      {step.node.args.question ||
                        step.node.args.goal ||
                        "No lookup question was recorded."}
                    </p>
                    {step.node.args.points?.length > 0 && (
                      <details>
                        <summary>
                          {step.node.args.points.length} requested points
                        </summary>
                        <div className="HPAG-aso-value-list">
                          {step.node.args.points.map((point, i) => (
                            <code key={i}>{point}</code>
                          ))}
                        </div>
                      </details>
                    )}
                    {step.node.inputs
                      .filter((id) => id !== "query")
                      .map((id) => (
                        <SourceButton
                          key={id}
                          id={id}
                          state={state}
                          onSelect={onSelect}
                        />
                      ))}
                  </>
                )}
                {step.node.error && (
                  <p className="HPAG-aso-error">{step.node.error}</p>
                )}
                {step.outputs.length > 0 && (
                  <div className="HPAG-aso-trace-outputs">
                    <h4>Produced in this trace</h4>
                    {step.outputs.map((output) => (
                      <SourceButton
                        key={output.key}
                        id={output.key}
                        state={state}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )}
                {step.decision && (
                  <details className="HPAG-aso-trace-decision">
                    <summary>ASO decision</summary>
                    <p>{step.decision}</p>
                  </details>
                )}
                <details className="HPAG-aso-trace-history">
                  <summary>
                    Recorded history <span>{step.events.length}</span>
                  </summary>
                  <ol>
                    {step.events.map((event) => (
                      <li
                        key={event.key}
                        className={
                          event.stage.includes("failed") ||
                          event.stage.includes("error")
                            ? "is-failed"
                            : ""
                        }
                      >
                        <strong>
                          {EVENT_NAMES[event.stage] ||
                            event.data.label ||
                            words(event.stage.replace(/^agent\./, ""))}
                        </strong>
                        <EventTime value={event.createdAt} />
                        {event.data.message && <p>{event.data.message}</p>}
                        {event.data.error && <p>{event.data.error}</p>}
                        {event.data.artifact && (
                          <SourceButton
                            id={event.data.artifact.id}
                            state={state}
                            onSelect={onSelect}
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div className="HPAG-aso-trace-end">
        <span aria-hidden="true">●</span>
        <span>
          {node.type === "data" || node.type === "figure"
            ? "Selected result"
            : "Selected step"}{" "}
          <code>{node.key}</code>
        </span>
      </div>
    </div>
  );
}
