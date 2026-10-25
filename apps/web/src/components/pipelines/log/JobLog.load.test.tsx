// @vitest-environment happy-dom
/**
 * The design's load case on the real virtualized list: a 100,000-line log mounts only
 * the rows on screen, and a search over it finds every match. The parse and search time
 * bound is in `jobLog.parse.test.ts`; the long-task check needs a real browser.
 */
import { EnvironmentId, type PipelinesJobLog } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { utf8Length } from "./jobLog.parse";
import { createMainThreadJobLogEngine } from "./jobLogEngine";

const h = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: { getJobLog: { label: "environment-data:pipelines:get-job-log" } },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => AsyncResult.success(h.answer as PipelinesJobLog),
}));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));

import { JobLog } from "./JobLog";

const E = "\u001b";
let container: HTMLDivElement;
let root: Root;

function bigLog(): string {
  const lines: string[] = [];
  for (let index = 0; index < 100_000; index += 1)
    lines.push(
      index % 500 === 0
        ? `${E}[0Ksection_start:${1_700_000_000 + index}:step_${index}\r${E}[0KStep ${index}`
        : index % 500 === 499
          ? `${E}[0Ksection_end:${1_700_000_000 + index}:step_${index - 499}\r${E}[0K`
          : `${E}[32m${index}${E}[0m ${"compiling module ".repeat(4)}(${index % 20 === 0 ? "needle" : "ok"})`,
    );
  return `${lines.join("\n")}\n`;
}

async function settle(ms = 0) {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, ms));
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
}

// happy-dom lays nothing out: give every element a 600 px viewport so the list has a
// window to fill, as a browser would.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    toJSON: () => rect,
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  container = document.createElement("div");
  container.style.height = "600px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("JobLog under load", () => {
  it("mounts fewer than 200 rows for a 100,000-line log and searches 5,000 matches", async () => {
    const text = bigLog();
    h.answer = {
      _tag: "chunk",
      text,
      offset: 0,
      nextOffset: utf8Length(text),
      totalBytes: utf8Length(text),
      complete: true,
      truncatedHead: false,
      firstLine: 0,
    };
    await act(async () =>
      root.render(
        <JobLog.Provider
          source={{ _tag: "complete", jobId: 1, attempt: null }}
          scope={{ environmentId: EnvironmentId.make("env"), cwd: "/repo" }}
          initialOffset={null}
          rawLogUrl={null}
          hostName="GitLab"
          onLineLink={vi.fn()}
          createEngine={() => createMainThreadJobLogEngine(() => Promise.resolve())}
        >
          <JobLog.Search />
          <JobLog.Lines />
        </JobLog.Provider>,
      ),
    );
    await settle(50);
    expect(container.querySelector('[role="log"]')).not.toBeNull();
    const mounted = container.querySelectorAll("[data-line]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search log"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(200);
    expect(container.textContent).toContain("of 4,800");
    expect(container.querySelectorAll("[data-line]").length).toBeLessThan(200);
  });
});
