import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  faArrowDown,
  faArrowRight,
  faArrowsToCircle,
  faChevronDown,
  faClock,
  faCompress,
  faDatabase,
  faExpand,
  faListCheck,
  faMagnifyingGlass,
  faMinus,
  faNetworkWired,
  faNoteSticky,
  faPause,
  faPlay,
  faPlus,
  faRotateLeft,
  faThumbtack,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import {
  agentName,
  layoutStudy,
  nodeTitle,
  studyStateFromEvents,
} from "./studyRunModel";
import {
  Activity,
  AgentActivity,
  artifactSize,
  duration,
  Empty,
  Icon,
  iconFor,
  Inspector,
  number,
  Overview,
  StatusIcon,
} from "./StudyRunDetails";
import "./StudyRun.css";

export { studyStateFromEvents, studyStatusLine } from "./studyRunModel";
const TABS = [
  { key: "flow", label: "Flow", icon: faNetworkWired },
  { key: "artifacts", label: "Artifacts", icon: faDatabase },
  { key: "activity", label: "Activity", icon: faListCheck },
];
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function StudyRun({ events, isComplete, apiBaseUrl }) {
  const [replay, setReplay] = useState(null),
    [playing, setPlaying] = useState(false);
  const replayFrames = useMemo(
    () =>
      events
        .map((event, index) => ({ event, end: index + 1 }))
        .filter(
          ({ event }) =>
            event.stage !== "context" && event.status !== "started",
        )
        .map(({ end }) => end),
    [events],
  );
  const replaying = replay !== null;
  const replayDone = replaying && replay === replayFrames.length - 1;
  const state = useMemo(
    () =>
      studyStateFromEvents(
        replay === null ? events : events.slice(0, replayFrames[replay]),
      ),
    [events, replay, replayFrames],
  );
  const [tab, setTab] = useState("flow");
  const [hovered, setHovered] = useState(null),
    [pinned, setPinned] = useState(null);
  const [expanded, setExpanded] = useState(false),
    [reportOpen, setReportOpen] = useState(false);
  const [following, setFollowing] = useState(true),
    [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(580);
  const [filter, setFilter] = useState(""),
    [artifactType, setArtifactType] = useState("all");
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [nodeHeights, setNodeHeights] = useState(() => new Map());
  const rootRef = useRef(null),
    scrollRef = useRef(null),
    dialogRef = useRef(null),
    inspectorRef = useRef(null);
  const hoverTimer = useRef(null),
    leaveTimer = useRef(null),
    drag = useRef(null),
    nodeRefs = useRef(new Map());
  const expandButtonRef = useRef(null),
    wasExpanded = useRef(false),
    wasLive = useRef(false),
    initialScroll = useRef(true);
  const id = useId();
  const live =
    !(replaying ? replayDone : isComplete) &&
    !["done", "failed", "incomplete"].includes(state.phase);
  const phase = live
    ? "running"
    : ["starting", "running"].includes(state.phase)
      ? "done"
      : state.phase;
  const layout = useMemo(
    () => layoutStudy(state, width, nodeHeights),
    [state, width, nodeHeights],
  );
  const focus = pinned || hovered,
    focusNode = state.byKey.get(focus);
  const artifacts = [...state.artifactsById.values()],
    figures = artifacts.filter((n) => n.type === "figure");
  const visibleArtifacts = artifacts.filter(
    (n) =>
      (artifactType === "all" || n.type === artifactType) &&
      `${n.key} ${nodeTitle(n)} ${n.description}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const counts = {
    agents: state.islands.filter((n) => n.type === "agent").length,
    turns: state.turns.filter((t) => t.turn).length,
  };
  const edgeSelected = (edge) => edge.from === focus || edge.to === focus;
  const linked = new Set([focus]);
  layout.edges.forEach((e) => {
    if (edgeSelected(e)) {
      linked.add(e.from);
      linked.add(e.to);
    }
  });

  const readViewport = useCallback(() => {
    const el = scrollRef.current;
    if (el)
      setViewport({
        x: el.scrollLeft,
        y: el.scrollTop,
        width: el.clientWidth,
        height: el.clientHeight,
      });
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      readViewport();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, tab, readViewport]);
  useLayoutEffect(() => {
    if (tab !== "flow") return;
    const measure = () => {
      const next = new Map(
        [...nodeRefs.current].map(([key, el]) => [key, el.offsetHeight]),
      );
      setNodeHeights((previous) =>
        previous.size === next.size &&
        [...next].every(([key, height]) => previous.get(key) === height)
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    nodeRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [state, expanded, tab]);
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (expanded) dialogRef.current.showModal();
    else if (wasExpanded.current)
      expandButtonRef.current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);
  useEffect(() => {
    if (!playing || replay === null || replayDone) return;
    const timer = setTimeout(() => setReplay((index) => index + 1), 650);
    return () => clearTimeout(timer);
  }, [playing, replay, replayDone]);
  const scrollToNode = useCallback(
    (key, smooth = true) => {
      const pos = layout.positions.get(key),
        el = scrollRef.current;
      if (pos && el)
        el.scrollTo({
          left: (pos.x + pos.width / 2) * zoom - el.clientWidth / 2,
          top: (pos.y + pos.height / 2) * zoom - el.clientHeight / 2,
          behavior: smooth && !reducedMotion() ? "smooth" : "instant",
        });
    },
    [layout, zoom],
  );
  const newestNode = layout.nodes[layout.nodes.length - 1]?.key;
  useEffect(() => {
    if (tab !== "flow" || !layout.measured) return;
    const followArrival = live || replaying || wasLive.current;
    wasLive.current = live;
    if (initialScroll.current) {
      initialScroll.current = false;
      scrollToNode(live || replaying ? newestNode : "query", false);
    } else if (followArrival && following && !pinned && newestNode) {
      scrollToNode(newestNode);
    }
  }, [
    newestNode,
    following,
    live,
    replaying,
    pinned,
    scrollToNode,
    tab,
    layout.measured,
  ]);
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [focus]);

  const clearHoverTimers = () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
  };
  const enter = (key, event) => {
    if (event?.pointerType === "touch" || pinned) return;
    clearHoverTimers();
    hoverTimer.current = setTimeout(() => setHovered(key), 110);
  };
  const leave = () => {
    clearTimeout(hoverTimer.current);
    leaveTimer.current = setTimeout(() => setHovered(null), 360);
  };
  const select = (key) => {
    clearHoverTimers();
    setHovered(null);
    setPinned(key);
    setFollowing(false);
    if (rootRef.current?.clientWidth <= 560)
      requestAnimationFrame(() =>
        rootRef.current?.querySelector(".HPAG-aso-inspector").scrollIntoView({
          block: "nearest",
          behavior: reducedMotion() ? "instant" : "smooth",
        }),
      );
  };
  const closeInspector = () => {
    clearHoverTimers();
    const key = focus;
    setPinned(null);
    setHovered(null);
    nodeRefs.current
      .get(key)
      ?.querySelector("button")
      .focus({ preventScroll: true });
  };
  const changeZoom = (value) => {
    const el = scrollRef.current,
      next = Math.min(1.4, Math.max(0.1, Number(value.toFixed(2))));
    const center = el
      ? {
          x: (el.scrollLeft + el.clientWidth / 2) / zoom,
          y: (el.scrollTop + el.clientHeight / 2) / zoom,
        }
      : null;
    setFollowing(false);
    setZoom(next);
    requestAnimationFrame(() => {
      if (el && center) {
        el.scrollLeft = center.x * next - el.clientWidth / 2;
        el.scrollTop = center.y * next - el.clientHeight / 2;
        readViewport();
      }
    });
  };
  const fit = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollowing(false);
    setZoom(
      Math.min(
        1,
        el.clientWidth / layout.width,
        (el.clientHeight - 2) / layout.height,
      ),
    );
    requestAnimationFrame(() => el.scrollTo({ top: 0, left: 0 }));
  };
  const startDrag = (event) => {
    if (
      event.button !== 0 ||
      event.target.closest("button") ||
      event.pointerType === "touch"
    )
      return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
    setFollowing(false);
    clearHoverTimers();
    setHovered(null);
  };
  const moveDrag = (event) => {
    if (!drag.current) return;
    event.currentTarget.scrollLeft =
      drag.current.left + drag.current.x - event.clientX;
    event.currentTarget.scrollTop =
      drag.current.top + drag.current.y - event.clientY;
  };
  const endDrag = (event) => {
    drag.current = null;
    event.currentTarget.classList.remove("is-dragging");
  };
  const toggleExpanded = () => setExpanded(!expanded);
  const startReplay = () => {
    clearHoverTimers();
    setReplay(0);
    setPlaying(true);
    setPinned(null);
    setHovered(null);
    setTab("flow");
    setReportOpen(false);
    setFollowing(true);
    initialScroll.current = true;
  };
  const stopReplay = () => {
    setReplay(null);
    setPlaying(false);
    setPinned(null);
    setHovered(null);
  };
  const tabKeyDown = (event) => {
    const current = TABS.findIndex((t) => t.key === tab);
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % 3
        : event.key === "ArrowLeft"
          ? (current + 2) % 3
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 2
              : null;
    if (next === null) return;
    event.preventDefault();
    setTab(TABS[next].key);
    rootRef.current.querySelectorAll('[role="tab"]')[next].focus();
  };

  const content = (
    <div
      ref={rootRef}
      className={`HPAG-aso ${expanded ? "is-expanded" : ""} ${live ? "is-live" : ""} ${replaying && !playing ? "is-motion-paused" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && focus) {
          event.preventDefault();
          event.stopPropagation();
          closeInspector();
        }
      }}
    >
      <header className="HPAG-aso-header">
        <div className="HPAG-aso-identity">
          <div>
            <div className="HPAG-aso-title">
              ASO <span>Research studio</span>
            </div>
            <div className="HPAG-aso-subtitle">
              Autonomous scientific orchestrator
            </div>
          </div>
        </div>
        <div className="HPAG-aso-header-right">
          <span className={`HPAG-aso-phase is-${phase}`} role="status">
            <StatusIcon status={phase} />
            {replaying
              ? replayDone
                ? "Replay complete"
                : "Study replay"
              : phase === "running"
                ? "Study in motion"
                : phase === "failed"
                  ? "Study failed"
                  : phase === "incomplete"
                    ? "Study incomplete"
                    : "Study complete"}
          </span>
          <button
            type="button"
            ref={expandButtonRef}
            className="HPAG-aso-icon-button"
            onClick={toggleExpanded}
            aria-label={expanded ? "Exit fullscreen" : "Expand study"}
            title={expanded ? "Exit fullscreen" : "Expand study"}
          >
            <Icon icon={expanded ? faCompress : faExpand} />
          </button>
        </div>
      </header>
      <div className="HPAG-aso-metrics">
        <span>
          <b key={`turns-${counts.turns}`}>{counts.turns}</b>{" "}
          {counts.turns === 1 ? "turn" : "turns"}
        </span>
        <span>
          <b key={`agents-${counts.agents}`}>{counts.agents}</b>{" "}
          {counts.agents === 1 ? "agent" : "agents"}
        </span>
        <span>
          <b key={`artifacts-${artifacts.length}`}>{artifacts.length}</b>{" "}
          {artifacts.length === 1 ? "artifact" : "artifacts"}
        </span>
        <span>
          <b key={`figures-${figures.length}`}>{figures.length}</b>{" "}
          {figures.length === 1 ? "figure" : "figures"}
        </span>
        <span className="HPAG-aso-metrics-end">
          {state.finish?.seconds !== undefined && (
            <span>
              <Icon icon={faClock} /> {duration(state.finish.seconds * 1000)}
            </span>
          )}
          {state.finish?.tokens?.total !== undefined && (
            <span>{number(state.finish.tokens.total)} tokens</span>
          )}
        </span>
      </div>
      {state.error && (
        <div className="HPAG-aso-error HPAG-aso-run-error" role="alert">
          {state.error}
        </div>
      )}
      <div className="HPAG-aso-toolbar">
        <div
          className="HPAG-aso-tabs"
          role="tablist"
          aria-label="Study views"
          onKeyDown={tabKeyDown}
        >
          <span
            className="HPAG-aso-tab-indicator"
            style={{
              transform: `translateX(${TABS.findIndex((t) => t.key === tab) * 100}%)`,
            }}
          />
          {TABS.map((t) => (
            <button
              type="button"
              key={t.key}
              role="tab"
              id={`${id}-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${id}-view`}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
            >
              <Icon icon={t.icon} />
              <span>{t.label}</span>
              {t.key === "artifacts" && <small>{artifacts.length}</small>}
            </button>
          ))}
        </div>
        {live && (
          <button
            type="button"
            className={`HPAG-aso-follow ${following ? "is-on" : ""}`}
            aria-pressed={following}
            onClick={() => {
              setFollowing(!following);
              setPinned(null);
              setHovered(null);
              setTab("flow");
            }}
          >
            <Icon icon={faArrowDown} />
            {following
              ? replaying
                ? "Following replay"
                : "Following live"
              : replaying
                ? "Follow replay"
                : "Follow live"}
          </button>
        )}
        {isComplete && !replaying && replayFrames.length > 1 && (
          <button
            type="button"
            className="HPAG-aso-replay-button"
            onClick={startReplay}
          >
            <Icon icon={faRotateLeft} />
            Replay study
          </button>
        )}
      </div>
      {replaying && (
        <div className="HPAG-aso-playback">
          <button
            type="button"
            onClick={() => (replayDone ? startReplay() : setPlaying(!playing))}
            aria-label={
              replayDone
                ? "Restart replay"
                : playing
                  ? "Pause replay"
                  : "Resume replay"
            }
          >
            <Icon
              icon={replayDone ? faRotateLeft : playing ? faPause : faPlay}
            />
          </button>
          <input
            type="range"
            min={0}
            max={replayFrames.length - 1}
            value={replay}
            aria-label="Replay position"
            aria-valuetext={`Event ${replay + 1} of ${replayFrames.length}`}
            onChange={(event) => {
              setPlaying(false);
              setPinned(null);
              setHovered(null);
              setReplay(Number(event.target.value));
            }}
          />
          <span>
            {replay + 1} / {replayFrames.length}
          </span>
          <button type="button" onClick={stopReplay}>
            Back to results <Icon icon={faXmark} />
          </button>
        </div>
      )}
      <div className="HPAG-aso-workspace">
        <div
          className="HPAG-aso-main"
          role="tabpanel"
          id={`${id}-view`}
          aria-labelledby={`${id}-${tab}`}
        >
          {tab === "flow" && (
            <div className="HPAG-aso-map-wrap">
              <div
                className="HPAG-aso-map-scroll"
                ref={scrollRef}
                onScroll={readViewport}
                onWheel={() => setFollowing(false)}
                onTouchStart={() => setFollowing(false)}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                tabIndex={0}
                role="region"
                aria-label="Study flow. Scroll or drag to explore the map."
                onKeyDown={(event) => {
                  if (
                    [
                      "ArrowDown",
                      "ArrowUp",
                      "PageDown",
                      "PageUp",
                      "Home",
                      "End",
                    ].includes(event.key)
                  )
                    setFollowing(false);
                }}
              >
                <div
                  className="HPAG-aso-map-space"
                  style={{
                    width: Math.max(width, layout.width * zoom),
                    height: layout.height * zoom,
                  }}
                >
                  <div
                    className="HPAG-aso-map"
                    style={{
                      width: layout.width,
                      height: layout.height,
                      visibility: layout.measured ? "visible" : "hidden",
                      transform: `scale(${zoom})`,
                      left: Math.max(0, (width - layout.width * zoom) / 2),
                    }}
                  >
                    <svg
                      className="HPAG-aso-edges"
                      width={layout.width}
                      height={layout.height}
                      aria-hidden="true"
                    >
                      {layout.edges.map((edge) => {
                        const active = edgeSelected(edge),
                          moving =
                            live &&
                            state.byKey.get(edge.to)?.status === "running";
                        return (
                          <g
                            key={edge.key}
                            className={`${focus && !active ? "is-dim" : ""} ${active ? "is-selected" : ""} ${moving ? "is-moving" : ""}`}
                          >
                            <path className="HPAG-aso-edge" d={edge.path} />
                            <path
                              className="HPAG-aso-edge-flow"
                              d={edge.path}
                            />
                          </g>
                        );
                      })}
                    </svg>
                    {layout.nodes.map((node, index) => {
                      const pos = layout.positions.get(node.key),
                        active = focus === node.key,
                        isArtifact = state.artifactsById.has(node.key);
                      return (
                        <div
                          key={node.key}
                          ref={(el) => {
                            if (el) nodeRefs.current.set(node.key, el);
                            else nodeRefs.current.delete(node.key);
                          }}
                          className={`HPAG-aso-node type-${node.type} status-${node.status} ${isArtifact ? "is-artifact" : ""} ${active ? "is-selected" : ""} ${focus && !linked.has(node.key) ? "is-dim" : ""}`}
                          style={{
                            transform: `translate(${pos.x}px, ${pos.y}px)`,
                            width: pos.width,
                            "--enter-delay": `${Math.min(index * 35, 280)}ms`,
                          }}
                          onPointerEnter={(event) => enter(node.key, event)}
                          onPointerLeave={leave}
                        >
                          <div className="HPAG-aso-node-surface">
                            <button
                              type="button"
                              className="HPAG-aso-node-button"
                              onClick={() =>
                                pinned === node.key
                                  ? closeInspector()
                                  : select(node.key)
                              }
                              aria-label={`Inspect ${node.key}: ${nodeTitle(node)}`}
                              aria-pressed={pinned === node.key}
                              aria-controls={`${id}-inspector`}
                            >
                              {isArtifact ? (
                                <span className="HPAG-aso-output-emblem">
                                  <Icon icon={iconFor(node)} />
                                  <code>{node.key}</code>
                                </span>
                              ) : (
                                <span className="HPAG-aso-node-top">
                                  <span className="HPAG-aso-node-icon">
                                    <Icon icon={iconFor(node)} />
                                  </span>
                                  <span className="HPAG-aso-node-identity">
                                    <span>
                                      {node.type === "agent"
                                        ? "Agent step"
                                        : node.type === "tool"
                                          ? "Operation"
                                          : node.type === "query"
                                            ? "The question"
                                            : "The outcome"}
                                    </span>
                                    {(node.type === "agent" ||
                                      node.type === "tool") && (
                                      <b>
                                        {node.type === "agent"
                                          ? agentName(node.tool)
                                          : node.tool}
                                      </b>
                                    )}
                                  </span>
                                  <span className="HPAG-aso-node-state">
                                    <StatusIcon
                                      status={
                                        node.type === "finish"
                                          ? phase
                                          : node.status
                                      }
                                      live={live}
                                    />
                                  </span>
                                </span>
                              )}
                              <strong>
                                {node.type === "query"
                                  ? state.goal || "Preparing your study…"
                                  : nodeTitle(node)}
                              </strong>
                              {isArtifact ? (
                                <span className="HPAG-aso-output-meta">
                                  {node.type === "figure" ? "Figure" : "Data"}
                                  {artifactSize(node) && (
                                    <> · {artifactSize(node)}</>
                                  )}
                                </span>
                              ) : (
                                node.outputs && (
                                  <span className="HPAG-aso-node-footer">
                                    <span
                                      className={
                                        live && node.status === "running"
                                          ? "HPAG-aso-node-wait"
                                          : ""
                                      }
                                    >
                                      {node.status === "failed"
                                        ? "Review error"
                                        : live && node.status === "running"
                                          ? node.type === "agent"
                                            ? "Agent working…"
                                            : "Running operation…"
                                          : `${node.outputs.length} ${node.outputs.length === 1 ? "output" : "outputs"}`}
                                    </span>
                                    {node.ms !== undefined && (
                                      <span>
                                        <Icon icon={faClock} />{" "}
                                        {duration(node.ms)}
                                      </span>
                                    )}
                                  </span>
                                )
                              )}
                            </button>
                          </div>
                          {node.type === "agent" &&
                            node.status === "running" &&
                            live && <AgentActivity tool={node.tool} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="HPAG-aso-map-controls" aria-label="Map controls">
                <button
                  type="button"
                  onClick={() => changeZoom(zoom - 0.15)}
                  disabled={zoom <= 0.1}
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  <Icon icon={faMinus} />
                </button>
                <button
                  type="button"
                  onClick={() => changeZoom(1)}
                  aria-label="Reset zoom"
                  title="Reset zoom"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => changeZoom(zoom + 0.15)}
                  disabled={zoom >= 1.4}
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  <Icon icon={faPlus} />
                </button>
                <span />
                <button
                  type="button"
                  onClick={fit}
                  aria-label="Fit map"
                  title="Fit map"
                >
                  <Icon icon={faArrowsToCircle} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    scrollToNode(focus || (live && newestNode) || "query")
                  }
                  aria-label="Center selected step"
                  title="Center selected step"
                >
                  <Icon icon={faMagnifyingGlass} />
                </button>
              </div>
              <button
                type="button"
                className="HPAG-aso-minimap"
                aria-label="Jump to the end of the flow"
                title="Jump to the end of the flow"
                onClick={() => {
                  setFollowing(false);
                  scrollToNode(layout.nodes[layout.nodes.length - 1].key);
                }}
              >
                <svg
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden="true"
                >
                  {layout.edges.map((e) => (
                    <path
                      key={e.key}
                      d={e.path}
                      fill="none"
                      stroke="#cbd5e1"
                      strokeWidth={8}
                    />
                  ))}
                  {layout.nodes.map((n) => {
                    const p = layout.positions.get(n.key);
                    return (
                      <rect
                        key={n.key}
                        x={p.x}
                        y={p.y}
                        width={p.width}
                        height={p.height}
                        rx={14}
                        fill={
                          n.status === "running" && live
                            ? "#0d9488"
                            : focus === n.key
                              ? "#111827"
                              : n.type === "agent"
                                ? "#8593c7"
                                : n.type === "data"
                                  ? "#79c3b6"
                                  : n.type === "figure"
                                    ? "#d3aa69"
                                    : "#cbd5e1"
                        }
                      />
                    );
                  })}
                  <rect
                    x={viewport.x / zoom}
                    y={viewport.y / zoom}
                    width={Math.min(layout.width, viewport.width / zoom)}
                    height={Math.min(layout.height, viewport.height / zoom)}
                    fill="#0d94881a"
                    stroke="#0d9488"
                    strokeWidth={12}
                    rx={12}
                  />
                </svg>
                <Icon icon={faArrowDown} />
              </button>
            </div>
          )}
          {tab === "artifacts" && (
            <div className="HPAG-aso-artifacts-view">
              <div className="HPAG-aso-artifact-filters">
                <label className="HPAG-aso-search">
                  <Icon icon={faMagnifyingGlass} />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Find an artifact…"
                    aria-label="Search artifacts"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => setFilter("")}
                      aria-label="Clear search"
                    >
                      <Icon icon={faXmark} />
                    </button>
                  )}
                </label>
                <div className="HPAG-aso-filter-chips">
                  {[
                    ["all", "All"],
                    ["data", "Data"],
                    ["figure", "Figures"],
                  ].map(([key, label]) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={artifactType === key}
                      onClick={() => setArtifactType(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="HPAG-aso-artifact-list">
                {visibleArtifacts.map((n) => (
                  <button
                    type="button"
                    key={n.key}
                    className={`HPAG-aso-artifact-card type-${n.type} ${focus === n.key ? "is-selected" : ""}`}
                    onClick={() => select(n.key)}
                    onPointerEnter={(event) => enter(n.key, event)}
                    onPointerLeave={leave}
                  >
                    <span className="HPAG-aso-artifact-card-icon">
                      <Icon icon={iconFor(n)} />
                    </span>
                    <span>
                      <span className="HPAG-aso-eyebrow">
                        <code>{n.key}</code>
                        {artifactSize(n)}
                      </span>
                      <strong>{nodeTitle(n)}</strong>
                      <small>{n.description}</small>
                    </span>
                    <Icon icon={faArrowRight} />
                  </button>
                ))}
                {!artifacts.length ? (
                  <Empty icon={faDatabase} title="Artifacts will land here">
                    Tables and figures appear as each step completes.
                  </Empty>
                ) : (
                  !visibleArtifacts.length && (
                    <Empty
                      icon={faMagnifyingGlass}
                      title="No matching artifacts"
                    >
                      Try a title, artifact ID, or a different filter.
                    </Empty>
                  )
                )}
              </div>
            </div>
          )}
          {tab === "activity" && <Activity state={state} onSelect={select} />}
        </div>
        <aside
          id={`${id}-inspector`}
          className={`HPAG-aso-inspector ${focusNode ? "has-focus" : ""}`}
          aria-label="Study inspector"
          onPointerEnter={clearHoverTimers}
          onPointerLeave={leave}
        >
          <div className="HPAG-aso-inspector-bar">
            <span>
              {focusNode
                ? pinned
                  ? "Pinned details"
                  : "Quick look"
                : "Study guide"}
            </span>
            {focusNode && (
              <div>
                {!pinned && (
                  <button
                    type="button"
                    className="HPAG-aso-icon-button"
                    onClick={() => select(focus)}
                    aria-label="Pin details"
                    title="Pin details"
                  >
                    <Icon icon={faThumbtack} />
                  </button>
                )}
                <button
                  type="button"
                  className="HPAG-aso-icon-button"
                  onClick={closeInspector}
                  aria-label="Close details"
                  title="Close details (Esc)"
                >
                  <Icon icon={faXmark} />
                </button>
              </div>
            )}
          </div>
          <div className="HPAG-aso-inspector-scroll" ref={inspectorRef}>
            {focusNode ? (
              <Inspector
                key={focusNode.key}
                node={focusNode}
                state={state}
                live={live}
                onSelect={select}
                apiBaseUrl={apiBaseUrl}
                pinned={Boolean(pinned)}
              />
            ) : (
              <Overview state={state} live={live} onSelect={select} />
            )}
          </div>
        </aside>
      </div>
      <footer className="HPAG-aso-footer">
        <div className="HPAG-aso-legend">
          <span className="type-agent">
            <i />
            Agent
          </span>
          <span className="type-tool">
            <i />
            Operation
          </span>
          <span className="type-data">
            <i />
            Data
          </span>
          <span className="type-figure">
            <i />
            Figure
          </span>
        </div>
        <span>
          {tab === "flow"
            ? "Drag to explore · click to inspect"
            : tab === "artifacts"
              ? "Every output, connected to its source"
              : "The study, step by step"}
        </span>
      </footer>
      {state.finish?.summary && (
        <section className={`HPAG-aso-report ${reportOpen ? "is-open" : ""}`}>
          <button
            type="button"
            className="HPAG-aso-report-toggle"
            onClick={() => setReportOpen(!reportOpen)}
            aria-expanded={reportOpen}
            aria-controls={`${id}-report`}
          >
            <span className="HPAG-aso-report-icon">
              <Icon icon={faNoteSticky} />
            </span>
            <span>
              <strong>Study report</strong>
              <small>Findings, evidence, and limitations</small>
            </span>
            <span>
              {reportOpen ? "Close report" : "Read report"}
              <Icon icon={faChevronDown} />
            </span>
          </button>
          <div
            id={`${id}-report`}
            className="HPAG-aso-report-reveal"
            inert={!reportOpen ? true : undefined}
          >
            <div>
              <div className="HPAG-aso-report-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {state.finish.summary}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
  return expanded ? (
    <dialog
      className="HPAG-aso-dialog"
      aria-label="ASO research studio"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (focus) closeInspector();
        else setExpanded(false);
      }}
    >
      {content}
    </dialog>
  ) : (
    content
  );
}
