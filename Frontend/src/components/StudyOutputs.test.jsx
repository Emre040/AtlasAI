import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { authenticatedDownload, authenticatedFetch } from "../api/auth";
import StudyOutputs from "./StudyOutputs";
import {vi} from 'vitest';

vi.mock("../api/auth", () => ({
  authenticatedDownload: vi.fn(),
  authenticatedFetch: vi.fn(),
}));
const api = "http://localhost:8012";
const workspace = "01a05ee1-978d-7038-92c0-a5caffb27a7a";
const event = (stage, data) => ({ stage, message: JSON.stringify(data) });
const start = event("start", {
  workspace_uuid: workspace,
  goal: "Compare measurements",
});
function figures(count) {
  return [
    start,
    ...Array.from({ length: count }, (_, index) => [
      event("tool.start", {
        id: `t${index}`,
        tool: "chart",
        kind: "tool",
        args: { artifact: "source", type: "bar", x: "gene", y: "nTPM" },
      }),
      event("tool.done", {
        id: `t${index}`,
        artifact: {
          id: `a${index}`,
          kind: "figure",
          images: [`figure-${index}.png`],
        },
      }),
    ]).flat(),
  ];
}
const imageResponse = () => ({
  ok: true,
  blob: async () => new Blob(["image"], { type: "image/png" }),
});
let resize;
let imageNumber;
const originalObserver = global.ResizeObserver;
const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
beforeEach(() => {
  vi.clearAllMocks();
  imageNumber = 0;
  URL.createObjectURL = vi.fn(() => `blob:figure-${imageNumber++}`);
  URL.revokeObjectURL = vi.fn();
  authenticatedFetch.mockImplementation(async () => imageResponse());
  authenticatedDownload.mockResolvedValue();
  global.ResizeObserver = class {
    constructor(callback) {
      resize = (width) => callback([{ contentRect: { width } }]);
    }
    observe() {
      resize(1000);
    }
    disconnect() {}
  };
});
afterAll(() => {
  global.ResizeObserver = originalObserver;
  URL.createObjectURL = originalCreateUrl;
  URL.revokeObjectURL = originalRevokeUrl;
});

test("three figures are shown below workspace download and chevrons page through the rest", async () => {
  const { unmount } = render(
    <StudyOutputs events={figures(5)} apiBaseUrl={api} />,
  );
  expect(
    screen.getByRole("button", { name: "Download Workspace" }),
  ).toBeVisible();
  expect(screen.getByText("1–3 of 5")).toBeVisible();
  expect(await screen.findAllByRole("img")).toHaveLength(3);
  expect(authenticatedFetch).toHaveBeenCalledTimes(3);
  expect(authenticatedFetch).toHaveBeenCalledWith(
    `${api}/workspaces/${workspace}/artifacts/figure-0.png`,
    expect.objectContaining({ signal: expect.anything() }),
  );
  expect(
    screen.getByRole("button", { name: "Previous figures" }),
  ).toBeDisabled();
  const firstLink = screen.getByRole("link", {
    name: "Open figure a0: Bar chart",
  });
  expect(firstLink).toHaveAttribute("target", "_blank");
  expect(firstLink).toHaveAttribute("href", "blob:figure-0");
  fireEvent.click(screen.getByRole("button", { name: "Next figures" }));
  expect(screen.getByText("4–5 of 5")).toBeVisible();
  expect(await screen.findAllByRole("img")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Next figures" })).toBeDisabled();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Previous figures" }));
  expect(screen.getByText("1–3 of 5")).toBeVisible();
  expect(await screen.findAllByRole("img")).toHaveLength(3);
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(8);
});

test("narrow screens show one or two figures and preserve working pagination", async () => {
  render(<StudyOutputs events={figures(5)} apiBaseUrl={api} />);
  await screen.findAllByRole("img");
  act(() => resize(390));
  expect(screen.getByText("1–1 of 5")).toBeVisible();
  expect(screen.getAllByRole("img")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Next figures" }));
  expect(
    await screen.findByRole("link", { name: "Open figure a1: Bar chart" }),
  ).toBeVisible();
  expect(screen.getByText("2–2 of 5")).toBeVisible();
  act(() => resize(700));
  expect(screen.getByText("1–2 of 5")).toBeVisible();
  await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
});

test("missing images and failed image requests stay explicit", async () => {
  authenticatedFetch.mockResolvedValueOnce({ ok: false, status: 404 });
  const events = [
    ...figures(1),
    event("tool.done", {
      id: "missing",
      artifact: { id: "a2", kind: "figure", images: [] },
    }),
  ];
  render(<StudyOutputs events={events} apiBaseUrl={api} />);
  expect(
    await screen.findByText("Figure unavailable (HTTP 404)."),
  ).toBeVisible();
  expect(
    screen.getByText("Figure image is unavailable for this run."),
  ).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

test("a late response from an unmounted gallery cannot create an object URL", async () => {
  let finish;
  authenticatedFetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(
    <StudyOutputs events={figures(1)} apiBaseUrl={api} />,
  );
  const signal = authenticatedFetch.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(imageResponse());
  });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test("a study without figures still downloads its recorded workspace and surfaces download errors", async () => {
  authenticatedDownload.mockRejectedValueOnce(
    new Error("Download failed with HTTP 404."),
  );
  render(<StudyOutputs events={[start]} apiBaseUrl={api} />);
  expect(
    screen.queryByRole("region", { name: "Study figures" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Download Workspace" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Download failed with HTTP 404.",
  );
  expect(authenticatedDownload).toHaveBeenCalledWith(
    `${api}/workspaces/${workspace}/download`,
    `workspace-${workspace}.tar.gz`,
  );
  expect(authenticatedFetch).not.toHaveBeenCalled();
});
