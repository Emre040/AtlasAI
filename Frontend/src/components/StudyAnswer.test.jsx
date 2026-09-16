import React from "react";
import { TextDecoder, TextEncoder } from "util";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import Chat from "./Chat";
import StudyAnswer from "./StudyAnswer";
import { studyRunsById } from "./studyCitations";
import { timelineToUiMessages } from "../api/timeline";
import { authenticatedFetch, initializeHPAAuth } from "../api/auth";
import {vi} from 'vitest';

// Match the backend run identity even when separate studies share node labels.
configure({ testIdAttribute: "data-study-run-id" });

vi.mock("../api/auth", () => ({
  authenticatedFetch: vi.fn(),
  authenticatedDownload: vi.fn(),
  initializeHPAAuth: vi.fn(),
  getVisitorId: () => "test-visitor",
}));
vi.mock("../api/config", () => ({
  getApiBaseUrl: () => "https://atlasai.test",
  getRuntimeConfig: () => ({ isLocal: false }),
  getUiConfig: () => ({ maxConversationTitleLength: 50 }),
  getApiEndpoint: (key) => {
    const paths = { listConversations: "/conversations", getMessages: "/conversations/messages", queryStream: "/query/stream", models: "/models" };
    if (!paths[key]) throw new Error(`Unexpected endpoint: ${key}`);
    return `https://atlasai.test${paths[key]}`;
  },
}));

function run(id, title, extraArtifact = false) {
  const progress = (stage, detail) => ({ kind: "progress", stage, detail });
  const events = [
    { kind: "started", stage: "start" },
    progress("start", { workspace_uuid: `workspace-${id}`, goal: `${title} study` }),
    progress("tool.start", { id: "t1", kind: "agent", tool: "investigator_hpa" }),
    progress("tool.done", {
      id: "t1", artifact: { id: "a15", kind: "data", title, rows: 1 },
    }),
    ...(extraArtifact ? [progress("tool.done", {
      id: "t1", artifact: { id: "a99", kind: "data", title: "Only in Beta", rows: 1 },
    })] : []),
    progress("finish", { outcome: "completed" }),
    { kind: "completed", stage: "complete" },
  ];
  return {
    type: "run", id, tool: "aso_hpa", events: events.map((event, seq) => ({
      ...event, seq, created_at: seq + 1,
    })),
  };
}
const answer = (id, text) => ({
  type: "message", id: `answer-${id}`, role: "assistant", run_id: id, text,
});
const alpha = run("run-alpha", "Alpha expression");
const beta = run("run-beta", "Beta expression", true);
const timeline = [
  alpha, answer(alpha.id, "Alpha findings [a15]. Unavailable here [a99]."),
  beta, answer(beta.id, "Beta findings [a15]."),
  answer(null, "An unbound answer [a15]."),
];

const originals = {
  resize: global.ResizeObserver,
  decoder: global.TextDecoder,
  media: window.matchMedia,
  scrollTo: HTMLElement.prototype.scrollTo,
  scrollIntoView: HTMLElement.prototype.scrollIntoView,
};
beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.TextDecoder = TextDecoder;
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes("reduce") || query.includes("min-width: 800px"),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  initializeHPAAuth.mockResolvedValue();
  authenticatedFetch.mockImplementation(async (url) => {
    const route = new URL(url).pathname;
    if (route === "/conversations")
      return { ok: true, json: async () => [{ id: "conversation", title: "Two studies" }] };
    if (route === "/conversations/messages")
      return { ok: true, json: async () => timeline };
    if (route === "/models")
      return { ok: true, json: async () => ({ models: [], providers: [], active: null }) };
    throw new Error(`Unexpected request: ${route}`);
  });
});
afterEach(() => {
  global.ResizeObserver = originals.resize;
  global.TextDecoder = originals.decoder;
  window.matchMedia = originals.media;
  HTMLElement.prototype.scrollTo = originals.scrollTo;
  HTMLElement.prototype.scrollIntoView = originals.scrollIntoView;
});

test("citations work in Markdown prose and groups while code and links keep their meaning", () => {
  const select = vi.fn();
  const study = studyRunsById(timelineToUiMessages([alpha])).get(alpha.id);
  render(
    <StudyAnswer
      study={study}
      onSelectArtifact={select}
      text={'Evidence **[a15]** and [a15, a15].\n\n- More [a15]\n\n`[a15]` and [a15](https://example.org).\n\n```text\n[a15]\n```'}
    />,
  );
  const citations = screen.getAllByRole("button", { name: "View artifact a15: Alpha expression" });
  expect(citations).toHaveLength(4);
  fireEvent.click(citations[0]);
  expect(select).toHaveBeenCalledWith("a15");
  expect(within(screen.getByRole("listitem")).getByRole("button")).toBe(citations[3]);
  expect(screen.getAllByText("[a15]", { selector: "code" })).toHaveLength(2);
  expect(screen.getByRole("link", { name: "a15" })).toHaveAttribute("href", "https://example.org");
});

test("unbound answers remain plain and missing IDs cannot resolve into another study", () => {
  const study = studyRunsById(timelineToUiMessages(timeline)).get(alpha.id);
  const { rerender } = render(<StudyAnswer text="Unbound [a15]." />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("Unbound [a15].")).toBeInTheDocument();
  rerender(<StudyAnswer text="Unknown [a99]." study={study} onSelectArtifact={vi.fn()} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByTitle("Artifact a99 is not available in this study")).toHaveTextContent("[a99]");
});

async function openChat() {
  render(<Chat />);
  fireEvent.click((await screen.findAllByRole("button", { name: /^Two studies/ }))[0]);
  await screen.findByRole("button", { name: "View artifact a15: Beta expression" });
}
const studyElement = (runId) => screen.getByTestId(runId);
const artifactButton = (element, title) => within(within(element).getByRole("region", { name: "Study flow. Scroll or drag to explore the map." })).getByRole("button", { name: `Inspect a15: ${title}` });

test("reloaded answers select only their own run, leave replay, and support repeated selection", async () => {
  await openChat();
  const first = studyElement(alpha.id);
  const second = studyElement(beta.id);
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Beta expression" }));
  expect(artifactButton(second, "Beta expression")).toHaveAttribute("aria-pressed", "true");
  expect(artifactButton(first, "Alpha expression")).toHaveAttribute("aria-pressed", "false");
  expect(artifactButton(second, "Beta expression")).toHaveFocus();

  fireEvent.click(within(first).getByRole("tab", { name: /Artifacts/ }));
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Alpha expression" }));
  expect(within(first).getByRole("tab", { name: "Flow" })).toHaveAttribute("aria-selected", "true");
  expect(artifactButton(first, "Alpha expression")).toHaveAttribute("aria-pressed", "true");
  expect(within(first).getByRole("complementary", { name: "Study inspector" })).toHaveTextContent("Alpha expression");

  fireEvent.click(within(first).getByRole("button", { name: "Close details" }));
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Alpha expression" }));
  expect(artifactButton(first, "Alpha expression")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(first).getByRole("button", { name: "Replay study" }));
  expect(within(first).getByRole("button", { name: "Pause replay" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Alpha expression" }));
  expect(within(first).queryByRole("button", { name: "Pause replay" })).not.toBeInTheDocument();
  expect(artifactButton(first, "Alpha expression")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("An unbound answer [a15].")).toBeInTheDocument();
}, 15000);

test("successive live requests retain their backend run IDs without changing earlier citations", async () => {
  await openChat();
  const previousFetch = authenticatedFetch.getMockImplementation();
  let request = 0;
  authenticatedFetch.mockImplementation(async (url, options) => {
    if (new URL(url).pathname !== "/query/stream") return previousFetch(url, options);
    request += 1;
    const liveRun = run(`live-${request}`, `Live ${request} expression`);
    const frames = liveRun.events.map(event => ({
      tool: {
        name: "aso_hpa", run_id: liveRun.id,
        status: event.kind === "progress" ? "progress" : event.kind,
        ...(event.detail ? { step: { stage: event.stage, message: JSON.stringify(event.detail) } } : {}),
      },
    }));
    frames.push({ token: `Live ${request} result [` }, { token: "a15]." }, { done: true });
    console.log(frames);
    let delivered = false;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => {
        if (delivered) return { done: true };
        delivered = true;
        return { done: false, value: new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")) };
      } }) },
    };
  });
  for (let index = 1; index <= 2; index += 1) {
    const input = screen.getByPlaceholderText("Ask your Human Protein Atlas Agent...");
    fireEvent.change(input, { target: { value: `Run study ${index}` } });
    fireEvent.keyPress(input, { key: "Enter", code: "Enter", charCode: 13 });
    const citation = await screen.findByRole("button", { name: `View artifact a15: Live ${index} expression` });
    fireEvent.click(citation);
    await waitFor(() => expect(artifactButton(studyElement(`live-${index}`), `Live ${index} expression`)).toHaveAttribute("aria-pressed", "true"));
    expect(artifactButton(studyElement(alpha.id), "Alpha expression")).toHaveAttribute("aria-pressed", "false");
  }
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Live 1 expression" }));
  expect(artifactButton(studyElement("live-1"), "Live 1 expression")).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "View artifact a15: Alpha expression" }));
  expect(artifactButton(studyElement(alpha.id), "Alpha expression")).toHaveFocus();
}, 15000);
