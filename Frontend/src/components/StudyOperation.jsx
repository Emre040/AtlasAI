import React from "react";
import { nodeTitle } from "./studyRunModel";
import {
  CONDITION_NAMES,
  operationDetails,
  operationResult,
  recordedValue,
  words,
} from "./studyOperations";
import "./StudyOperation.css";

function Relation({ relation }) {
  return (
    <span className="HPAG-aso-relation">
      <span title={relation.left}>
        {relation.left == null ? "Not recorded" : words(relation.left)}
      </span>
      <b aria-hidden="true">{relation.symbol}</b>
      <span title={relation.right}>
        {relation.right == null ? "Not recorded" : words(relation.right)}
      </span>
    </span>
  );
}

export function OperationSummary({ node }) {
  const info = operationDetails(node);
  if (!info) return null;
  const result = operationResult(node);
  const first =
    info.facts.find((fact) => fact.kind === "renames") || info.facts[0];
  const clauses = info.conditions?.flatMap((group) => group.clauses) || [];
  const clause = clauses[0];
  return (
    <span className="HPAG-aso-operation-summary">
      {info.relation ? (
        <Relation relation={info.relation} />
      ) : clause ? (
        <span className="HPAG-aso-operation-caption">
          <span title={clause.column}>{words(clause.column)}</span>{" "}
          {CONDITION_NAMES[clause.op] || words(clause.op)}{" "}
          {clause.column_b !== undefined
            ? words(clause.column_b)
            : Object.hasOwn(clause, "value") &&
              (Array.isArray(clause.value)
                ? clause.value.join(" · ")
                : recordedValue(clause.value))}
          {clauses.length > 1 && <small> +{clauses.length - 1} more</small>}
        </span>
      ) : info.formula ? (
        <code className="HPAG-aso-operation-caption">{info.formula}</code>
      ) : (
        first && (
          <span className="HPAG-aso-operation-caption">
            {first.label}:{" "}
            {first.kind === "renames"
              ? first.value
                  .map((pair) => `${words(pair.label)} → ${words(pair.value)}`)
                  .join(" · ")
              : Array.isArray(first.value)
                ? first.value.map(words).join(" · ")
                : first.kind === "column"
                  ? words(first.value)
                  : recordedValue(first.value)}
          </span>
        )
      )}
      {info.tool === "rank" && (
        <span className="HPAG-aso-operation-caption">Order: {first.value}</span>
      )}
      {result.length > 0 && (
        <span className="HPAG-aso-result-inline">
          {result.slice(0, 2).map((stat) => (
            <span key={stat.column}>
              <b>{stat.label}</b> {recordedValue(stat.value)}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

// Recursive layout for recorded values, including rules, groups and renamed
// columns. No stringified object blobs and no interpretation of expressions.
export function RecordedValue({ value, column = false }) {
  if (Array.isArray(value))
    return (
      <div className="HPAG-aso-value-list">
        {value.map((item, index) => (
          <div key={index}>
            <RecordedValue value={item} column={column} />
          </div>
        ))}
      </div>
    );
  if (value && typeof value === "object")
    return (
      <dl className="HPAG-aso-value-object">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{words(key)}</dt>
            <dd>
              <RecordedValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return column && value != null ? (
    <span className="HPAG-aso-column-chip" title={String(value)}>
      {words(value)}
    </span>
  ) : (
    <span>{recordedValue(value)}</span>
  );
}

function Conditions({ clauses }) {
  return (
    <ul className="HPAG-aso-conditions">
      {clauses.map((clause, index) => (
        <li key={index}>
          <RecordedValue value={clause.column} column />
          <span className="HPAG-aso-condition-op">
            {CONDITION_NAMES[clause.op] || words(clause.op)}
          </span>
          {clause.column_b !== undefined ? (
            <RecordedValue value={clause.column_b} column />
          ) : (
            Object.hasOwn(clause, "value") && (
              <RecordedValue value={clause.value} />
            )
          )}
        </li>
      ))}
    </ul>
  );
}

export function SourceButton({ id, state, onSelect, label }) {
  const source = state.byKey.get(id);
  if (!source)
    return (
      <span className="HPAG-aso-source-missing">
        {id} · source details unavailable
      </span>
    );
  return (
    <button
      type="button"
      className="HPAG-aso-source-button"
      onClick={() => onSelect(id)}
      aria-label={`Inspect source ${id}: ${nodeTitle(source)}`}
    >
      <code>{id}</code>
      <span>{label || nodeTitle(source)}</span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}

export function OperationDetails({ node, state, onSelect }) {
  const info = operationDetails(node);
  if (!info) return null;
  const stats = operationResult(node);
  return (
    <div className="HPAG-aso-operation-details">
      {info.relation && <Relation relation={info.relation} />}
      {stats.length > 0 && (
        <dl className="HPAG-aso-result-stats" aria-label="Recorded result">
          {stats.map((stat) => (
            <div key={stat.column}>
              <dt title={stat.caption}>
                {stat.label}
                <span>{stat.caption}</span>
              </dt>
              <dd>{recordedValue(stat.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {info.formula && (
        <div className="HPAG-aso-formula">
          <span>Formula</span>
          <code>{info.formula}</code>
        </div>
      )}
      {info.facts.length > 0 && (
        <dl className="HPAG-aso-operation-facts">
          {info.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.kind === "pairs" || fact.kind === "renames" ? (
                  <ul className="HPAG-aso-pairs">
                    {fact.value.map((pair, index) => (
                      <li key={index}>
                        <RecordedValue value={pair.label} column />
                        <span aria-hidden="true">→</span>
                        <RecordedValue
                          value={pair.value}
                          column={fact.kind === "renames"}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <RecordedValue
                    value={fact.value}
                    column={fact.kind === "column" || fact.kind === "columns"}
                  />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {info.conditions?.map((group) => (
        <div className="HPAG-aso-condition-group" key={group.label}>
          <h4>{group.label}</h4>
          <Conditions clauses={group.clauses} />
        </div>
      ))}
      {info.rules && (
        <details
          className="HPAG-aso-operation-rules"
          open={info.rules.length <= 3}
        >
          <summary>
            {info.rules.length} classification{" "}
            {info.rules.length === 1 ? "rule" : "rules"} · first match wins
          </summary>
          <ol>
            {info.rules.map((rule, index) => (
              <li key={index}>
                <Conditions clauses={rule.where || []} />
                <div className="HPAG-aso-rule-result">
                  Then <RecordedValue value={rule.value} />
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
      {info.inputs.length > 0 && (
        <div className="HPAG-aso-operation-inputs">
          {info.inputs.map((input) => (
            <div key={input.label}>
              <span>{input.label}</span>
              <SourceButton id={input.id} state={state} onSelect={onSelect} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
