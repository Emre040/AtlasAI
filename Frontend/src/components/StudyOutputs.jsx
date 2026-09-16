import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronLeft,
  faChevronRight,
  faDownload,
  faExternalLinkAlt,
} from "@fortawesome/free-solid-svg-icons";
import { authenticatedDownload } from "../api/auth";
import { nodeTitle, studyStateFromEvents } from "./studyRunModel";
import useArtifactImage from "./useArtifactImage";
import "./StudyOutputs.css";

function FigureCard({ node, filename, apiBaseUrl, workspaceUuid }) {
  const image = useArtifactImage(apiBaseUrl, workspaceUuid, filename);
  const title = nodeTitle(node);
  return (
    <figure className="HPAG-study-figure-card">
      {image.url ? (
        <a
          className="HPAG-study-figure-image"
          href={image.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open figure ${node.key}: ${title}`}
        >
          <img src={image.url} alt={title} />
        </a>
      ) : (
        <div
          className={`HPAG-study-figure-image ${image.error ? "has-error" : "is-loading"}`}
          role="status"
        >
          {image.error || "Loading figure…"}
        </div>
      )}
      <figcaption>
        <code>{node.key}</code>
        <strong>{title}</strong>
        {image.url && (
          <a
            className="HPAG-study-figure-open"
            href={image.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open full-size figure ${node.key}`}
          >
            <FontAwesomeIcon icon={faExternalLinkAlt} /> Full size
          </a>
        )}
      </figcaption>
    </figure>
  );
}

function FigureCarousel({ figures, apiBaseUrl, workspaceUuid }) {
  const grid = useRef(null);
  const gridId = useId();
  const [navigation, setNavigation] = useState({ columns: 3, page: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const columns = width < 520 ? 1 : width < 820 ? 2 : 3;
      setNavigation((current) =>
        current.columns === columns ? current : { columns, page: 0 },
      );
    });
    observer.observe(grid.current);
    return () => observer.disconnect();
  }, []);
  const { columns } = navigation;
  const lastPage = Math.ceil(figures.length / columns) - 1;
  const page = Math.min(navigation.page, lastPage);
  const start = page * columns;
  const end = Math.min(start + columns, figures.length);
  const move = (offset) =>
    setNavigation((current) => ({ ...current, page: page + offset }));
  return (
    <section
      className="HPAG-study-figures"
      aria-label="Study figures"
      aria-roledescription="carousel"
    >
      <div className="HPAG-study-figures-heading">
        <h3>
          Figures <span>{figures.length}</span>
        </h3>
        <div className="HPAG-study-figures-navigation">
          <span role="status" aria-live="polite" aria-atomic="true">
            {start + 1}–{end} of {figures.length}
          </span>
          <button
            type="button"
            onClick={() => move(-1)}
            disabled={page === 0}
            aria-label="Previous figures"
            aria-controls={gridId}
          >
            <FontAwesomeIcon icon={faChevronLeft} />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            disabled={page === lastPage}
            aria-label="Next figures"
            aria-controls={gridId}
          >
            <FontAwesomeIcon icon={faChevronRight} />
          </button>
        </div>
      </div>
      <div
        className="HPAG-study-figures-grid"
        ref={grid}
        id={gridId}
        style={{ "--figure-columns": columns }}
      >
        {figures.slice(start, end).map(({ node, filename }) => (
          <FigureCard
            key={`${workspaceUuid}:${node.key}:${filename}`}
            node={node}
            filename={filename}
            apiBaseUrl={apiBaseUrl}
            workspaceUuid={workspaceUuid}
          />
        ))}
      </div>
    </section>
  );
}

export default function StudyOutputs({ events, apiBaseUrl }) {
  const state = useMemo(() => studyStateFromEvents(events), [events]);
  const [download, setDownload] = useState({ busy: false, error: null });
  const figures = useMemo(
    () =>
      [...state.artifactsById.values()]
        .filter((node) => node.type === "figure")
        .flatMap((node) =>
          node.images.length
            ? node.images.map((filename) => ({ node, filename }))
            : [{ node, filename: null }],
        ),
    [state],
  );
  if (!state.workspaceUuid) return null;
  const saveWorkspace = async () => {
    setDownload({ busy: true, error: null });
    try {
      await authenticatedDownload(
        `${apiBaseUrl}/workspaces/${state.workspaceUuid}/download`,
        `workspace-${state.workspaceUuid}.tar.gz`,
      );
      setDownload({ busy: false, error: null });
    } catch (error) {
      setDownload({ busy: false, error: error.message });
    }
  };
  return (
    <div className="HPAG-study-outputs">
      <button
        type="button"
        onClick={saveWorkspace}
        disabled={download.busy}
        className="HPAG-study-workspace-download"
      >
        <FontAwesomeIcon icon={faDownload} />{" "}
        {download.busy ? "Downloading workspace…" : "Download Workspace"}
      </button>
      {download.error && (
        <p className="HPAG-study-outputs-error" role="alert">
          {download.error}
        </p>
      )}
      {figures.length > 0 && (
        <FigureCarousel
          key={state.workspaceUuid}
          figures={figures}
          apiBaseUrl={apiBaseUrl}
          workspaceUuid={state.workspaceUuid}
        />
      )}
    </div>
  );
}
