import React, { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faBookOpen,
  faChartBar,
  faCheck,
  faCircleCheck,
  faCircleExclamation,
  faCircleNotch,
  faCirclePause,
  faCircleXmark,
  faClock,
  faCommentDots,
  faDatabase,
  faDownload,
  faExternalLinkAlt,
  faFlagCheckered,
  faHammer,
  faListCheck,
  faMagnifyingGlass,
  faMinus,
  faNoteSticky,
  faPlay,
  faRobot,
  faXmark,
  faChevronDown,
} from "@fortawesome/free-solid-svg-icons";
import { authenticatedDownload, authenticatedFetch } from "../api/auth";
import { agentName, nodeTitle } from "./studyRunModel";

const ICONS = {
  query: faCommentDots,
  agent: faRobot,
  tool: faHammer,
  data: faDatabase,
  figure: faChartBar,
  finish: faFlagCheckered,
  note: faNoteSticky,
  plan: faListCheck,
};
const STATUS_ICONS = {
  running: faCircleNotch,
  done: faCircleCheck,
  failed: faCircleXmark,
  incomplete: faCircleExclamation,
  stopped: faCirclePause,
};
export const number = (value) => Number(value).toLocaleString();
export const duration = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
export const iconFor = (node) => ICONS[node.type];
export const artifactSize = (node) =>
  Number.isFinite(node.rows)
    ? `${number(node.rows)} ${node.rows === 1 ? "row" : "rows"}`
    : node.size;
export function Icon({ icon, ...props }) {
  return <FontAwesomeIcon icon={icon} {...props} />;
}
export function StatusIcon({ status, live = true }) {
  const value = status === "running" && !live ? "stopped" : status;
  return (
    <Icon
      icon={STATUS_ICONS[value]}
      className={`HPAG-aso-status-icon is-${value}`}
    />
  );
}
export function AgentActivity({ tool }) {
  const research = tool === "deep_research_hpa";
  if (!research && tool !== "investigator_hpa") return null;
  return (
    <span
      className={`HPAG-aso-agent-activity ${research ? "is-research" : "is-investigator"}`}
      aria-hidden="true"
    >
      <Icon icon={research ? faBookOpen : faMagnifyingGlass} />
      <span />
      <span />
      <span />
    </span>
  );
}
function Status({ status, live }) {
  const value = status === "running" && !live ? "stopped" : status;
  return (
    <span className={`HPAG-aso-status is-${value}`}>
      <StatusIcon status={value} />
      {value === "done"
        ? "Complete"
        : value === "running"
          ? "Running"
          : value === "failed"
            ? "Failed"
            : value === "incomplete"
              ? "Incomplete"
              : "Stopped"}
    </span>
  );
}
export function Empty({ icon, title, children }) {
  return (
    <div className="HPAG-aso-empty">
      <Icon icon={icon} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
export function ArtifactLink({ node, onSelect }) {
  return (
    <button
      type="button"
      className={`HPAG-aso-artifact-link type-${node.type}`}
      onClick={() => onSelect(node.key)}
      aria-label={`Inspect ${node.key}: ${nodeTitle(node)}`}
    >
      <Icon icon={iconFor(node)} />
      <code>{node.key}</code>
      <span>{nodeTitle(node)}</span>
      <Icon icon={faArrowRight} />
    </button>
  );
}

function FigurePreview({ node, apiBaseUrl, workspaceUuid }) {
  const [preview, setPreview] = useState({ url: null, error: null });
  const filename = node.images[0];
  useEffect(() => {
    if (!filename || !apiBaseUrl || !workspaceUuid) return;
    const controller = new AbortController();
    let active = true,
      objectUrl;
    setPreview({ url: null, error: null });
    (async () => {
      try {
        const response = await authenticatedFetch(
          `${apiBaseUrl}/workspaces/${workspaceUuid}/artifacts/${encodeURIComponent(filename)}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(`Figure unavailable (HTTP ${response.status}).`);
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ url: objectUrl, error: null });
      } catch (error) {
        if (active && error.name !== "AbortError")
          setPreview({ url: null, error: error.message });
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filename, apiBaseUrl, workspaceUuid]);
  if (!filename || !apiBaseUrl || !workspaceUuid)
    return (
      <p className="HPAG-aso-muted">
        Figure preview is unavailable for this run.
      </p>
    );
  if (preview.error)
    return (
      <p className="HPAG-aso-error" role="status">
        {preview.error}
      </p>
    );
  return (
    <div className={`HPAG-aso-figure ${preview.url ? "is-loaded" : ""}`}>
      {preview.url ? (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open figure: ${nodeTitle(node)}`}
        >
          <img src={preview.url} alt={nodeTitle(node)} />
          <span>
            Open figure <Icon icon={faExternalLinkAlt} />
          </span>
        </a>
      ) : (
        <span className="HPAG-aso-muted">Loading figure…</span>
      )}
    </div>
  );
}

export function Inspector({ node, state, onSelect, live, apiBaseUrl, pinned }) {
  const [download, setDownload] = useState({ busy: false, error: null });
  const isArtifact = node.type === "data" || node.type === "figure";
  const trail = state.trails.get(node.key) || [];
  const args = Object.entries(node.args || {}).filter(
    ([key, value]) =>
      !["title", "description"].includes(key) &&
      value !== undefined &&
      value !== null &&
      value !== "",
  );
  const save = async () => {
    const filename =
      node.type === "figure" ? node.images[0] : `${node.artifactUuid}.json`;
    if (!filename) return;
    setDownload({ busy: true, error: null });
    try {
      await authenticatedDownload(
        `${apiBaseUrl}/workspaces/${state.workspaceUuid}/artifacts/${encodeURIComponent(filename)}`,
        filename,
      );
      setDownload({ busy: false, error: null });
    } catch (error) {
      setDownload({ busy: false, error: error.message });
    }
  };
  return (
    <div className="HPAG-aso-detail">
      <div className={`HPAG-aso-detail-icon type-${node.type}`}>
        <Icon icon={iconFor(node)} />
      </div>
      <div className="HPAG-aso-eyebrow">
        {node.type === "agent"
          ? `Agent step · ${agentName(node.tool)}`
          : node.type === "tool"
            ? `Operation · ${node.tool}`
            : node.type === "data"
              ? "Data artifact"
              : node.type === "figure"
                ? "Figure"
                : "ASO"}{" "}
        <code>{node.key}</code>
      </div>
      <h3>{nodeTitle(node)}</h3>
      <div className="HPAG-aso-detail-meta">
        <Status
          status={node.type === "finish" ? state.phase : node.status}
          live={live}
        />
        {node.ms !== undefined && (
          <span>
            <Icon icon={faClock} /> {duration(node.ms)}
          </span>
        )}
        {isArtifact && <span>{artifactSize(node)}</span>}
      </div>
      {node.type === "query" && (
        <p>{state.goal || "ASO is receiving the research question."}</p>
      )}
      {(node.description || node.args?.description) && (
        <p>{node.description || node.args.description}</p>
      )}
      {node.type === "note" && <p>{node.text}</p>}
      {node.type === "finish" && (
        <p>
          {state.phase === "incomplete"
            ? "Review the report for unfinished work and limitations."
            : "The study has finished. Explore its artifacts and read the report below."}
        </p>
      )}
      {node.error && <div className="HPAG-aso-error">{node.error}</div>}
      {node.inputs.length > 0 && (
        <section>
          <h4>{isArtifact ? "Created by" : "Inputs"}</h4>
          <div className="HPAG-aso-links">
            {node.inputs.map((key) => {
              const input = state.byKey.get(key);
              return input ? (
                <ArtifactLink key={key} node={input} onSelect={onSelect} />
              ) : (
                <span key={key} className="HPAG-aso-muted">
                  {key} · details unavailable
                </span>
              );
            })}
          </div>
        </section>
      )}
      {node.outputs?.length > 0 && (
        <section>
          <h4>
            Outputs <span>{node.outputs.length}</span>
          </h4>
          <div className="HPAG-aso-links">
            {node.outputs.map((key) => (
              <ArtifactLink
                key={key}
                node={state.artifactsById.get(key)}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}
      {node.type === "figure" && pinned && (
        <FigurePreview
          node={node}
          apiBaseUrl={apiBaseUrl}
          workspaceUuid={state.workspaceUuid}
        />
      )}
      {node.type === "figure" && !pinned && (
        <p className="HPAG-aso-muted">Pin this figure to load its preview.</p>
      )}
      {isArtifact && node.sample.length > 0 && (
        <section>
          <h4>
            Data preview <span>{node.sample.length} rows</span>
          </h4>
          <div
            className="HPAG-aso-sample"
            tabIndex={0}
            role="region"
            aria-label="Artifact sample"
          >
            <table>
              <thead>
                <tr>
                  {node.sampleColumns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.sample.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>
                        {typeof cell === "object" && cell !== null
                          ? JSON.stringify(cell)
                          : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {isArtifact && node.columns.length > 0 && (
        <details className="HPAG-aso-disclosure">
          <summary>
            Reported columns <span>{node.columns.length}</span>
            <Icon icon={faChevronDown} />
          </summary>
          <div className="HPAG-aso-columns">
            {node.columns.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
        </details>
      )}
      {node.text && isArtifact && <p>{node.text}</p>}
      {node.searchUrl && (
        <a
          className="HPAG-aso-text-link"
          href={node.searchUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Protein Atlas <Icon icon={faExternalLinkAlt} />
        </a>
      )}
      {trail.length > 0 && (
        <section>
          <h4>
            Agent activity <span>{trail.length}</span>
          </h4>
          <ol className="HPAG-aso-trail">
            {trail.map((event, i) => (
              <li key={i}>
                <strong>{event.label || event.stage}</strong>
                {event.message && <span>{event.message}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {args.length > 0 && (
        <details className="HPAG-aso-disclosure">
          <summary>
            Operation details <Icon icon={faChevronDown} />
          </summary>
          <dl className="HPAG-aso-args">
            {args.map(([key, value]) => (
              <React.Fragment key={key}>
                <dt>{key.replace(/_/g, " ")}</dt>
                <dd>
                  {typeof value === "string"
                    ? value
                    : JSON.stringify(value, null, 2)}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      )}
      {isArtifact &&
        pinned &&
        apiBaseUrl &&
        state.workspaceUuid &&
        (node.type === "data"
          ? Boolean(node.artifactUuid)
          : node.images.length > 0) && (
          <button
            type="button"
            className="HPAG-aso-download"
            onClick={save}
            disabled={download.busy}
          >
            <Icon icon={faDownload} />
            {download.busy
              ? "Downloading…"
              : node.type === "figure"
                ? "Download figure"
                : "Download data"}
          </button>
        )}
      {download.error && (
        <p className="HPAG-aso-error" role="alert">
          {download.error}
        </p>
      )}
    </div>
  );
}

export function Overview({ state, live, onSelect }) {
  const done = state.plan.filter((p) => p.status === "done").length;
  const running = state.islands.filter((n) => n.status === "running");
  return (
    <div className="HPAG-aso-overview">
      <div className="HPAG-aso-eyebrow">
        {live ? "In progress" : "Study overview"}
      </div>
      <h3>
        {live
          ? "Following the evidence"
          : state.phase === "failed"
            ? "The study stopped"
            : state.phase === "incomplete"
              ? "More work remains"
              : "From question to evidence"}
      </h3>
      <p className="HPAG-aso-overview-hint">
        Hover to explore. Click any step or artifact to keep its details open.
      </p>
      {state.plan.length > 0 && (
        <section className="HPAG-aso-plan">
          <div className="HPAG-aso-section-title">
            <h4>Research plan</h4>
            <span>
              {done} / {state.plan.length}
            </span>
          </div>
          <div
            className="HPAG-aso-plan-progress"
            role="progressbar"
            aria-label="Research plan"
            aria-valuemin={0}
            aria-valuemax={state.plan.length}
            aria-valuenow={done}
          >
            <span style={{ width: `${(done / state.plan.length) * 100}%` }} />
          </div>
          <ol>
            {state.plan.map((p, i) => (
              <li key={i} className={`is-${p.status}`}>
                <span className="HPAG-aso-plan-check">
                  {p.status === "done" ? (
                    <Icon icon={faCheck} />
                  ) : p.status === "dropped" ? (
                    <Icon icon={faMinus} />
                  ) : (
                    i + 1
                  )}
                </span>
                <span>
                  {p.text?.includes(" ") ? p.text : p.text?.replace(/_/g, " ")}
                  {p.description ? (
                    <small className="HPAG-aso-plan-description">
                      {p.description}
                    </small>
                  ) : null}
                  <small>
                    {p.kind?.replace(/_/g, " ")}
                    {p.status === "dropped" ? " · dropped" : ""}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {live && (
        <section>
          <h4>Working now</h4>
          {running.length ? (
            running.map((n) => (
              <ArtifactLink key={n.key} node={n} onSelect={onSelect} />
            ))
          ) : (
            <div className="HPAG-aso-thinking">
              <span />
              <span />
              <span />
              <span>ASO is planning its next step</span>
            </div>
          )}
        </section>
      )}
      {state.islands.some((n) => n.type === "note") && (
        <section>
          <h4>Research notes</h4>
          {state.islands
            .filter((n) => n.type === "note")
            .map((n) => (
              <ArtifactLink key={n.key} node={n} onSelect={onSelect} />
            ))}
        </section>
      )}
      {(state.model || state.hpaVersion) && (
        <div className="HPAG-aso-run-meta">
          {state.model && <span>{state.model}</span>}
          {state.hpaVersion && (
            <span>
              HPA {state.hpaVersion}
              {state.mode ? ` · ${state.mode}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function Activity({ state, onSelect }) {
  const items = state.activity.filter((e) =>
    [
      "tool.start",
      "tool.done",
      "tool.failed",
      "call.failed",
      "note",
      "finish.refused",
      "finish",
      "plan",
    ].includes(e.stage),
  );
  return (
    <div className="HPAG-aso-activity">
      {items.length ? (
        items.map(({ key, stage, data }) => {
          const node = state.byKey.get(data.artifact?.id || data.id);
          const failed = stage.includes("failed") || stage === "finish.refused";
          const label =
            stage === "tool.start"
              ? "Started"
              : stage === "tool.done"
                ? "Created"
                : stage === "plan"
                  ? "Plan updated"
                  : stage === "finish.refused"
                    ? "Report needs revision"
                    : stage === "finish"
                      ? "Study finished"
                      : stage === "note"
                        ? "Research note"
                        : "Needs attention";
          const text = node
            ? nodeTitle(node)
            : data.text ||
              data.error ||
              data.issues?.join(" · ") ||
              (stage === "plan" ? `${data.items.length} deliverables` : label);
          return (
            <div
              key={key}
              className={`HPAG-aso-activity-item ${failed ? "is-failed" : ""}`}
            >
              <span className="HPAG-aso-activity-dot">
                <Icon
                  icon={
                    failed
                      ? faXmark
                      : stage === "tool.start"
                        ? faPlay
                        : stage === "tool.done"
                          ? faCheck
                          : faListCheck
                  }
                />
              </span>
              <div>
                <div className="HPAG-aso-eyebrow">
                  {label}
                  {data.ms !== undefined && <span>{duration(data.ms)}</span>}
                </div>
                {node ? (
                  <button type="button" onClick={() => onSelect(node.key)}>
                    {text}
                    <Icon icon={faArrowRight} />
                  </button>
                ) : (
                  <p>{text}</p>
                )}
              </div>
            </div>
          );
        })
      ) : (
        <Empty icon={faListCheck} title="The study is getting started">
          Its steps will appear here as they happen.
        </Empty>
      )}
    </div>
  );
}
