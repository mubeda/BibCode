// @vitest-environment happy-dom
import { EnvironmentId, type PipelinesJobLog, type PipelinesJobLogInput } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { utf8Length } from "./jobLog.parse";
import { createMainThreadJobLogEngine } from "./jobLogEngine";

const h = vi.hoisted(() => ({
  answers: [] as unknown[],
  reads: [] as unknown[],
  listProps: null as Record<string, unknown> | null,
  scrollToEnd: vi.fn(),
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: { getJobLog: { label: "environment-data:pipelines:get-job-log" } },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: { input: PipelinesJobLogInput }) => {
    h.reads.push(value.input);
    const next = h.answers.shift();
    return next === undefined
      ? new Promise(() => {})
      : AsyncResult.success(next as PipelinesJobLog);
  },
}));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly number[];
    keyExtractor: (item: number) => string;
    renderItem: (p: { item: number; index: number }) => ReactNode;
    ref?: Ref<unknown>;
    role?: string;
    "aria-label"?: string;
  }) => {
    h.listProps = props as unknown as Record<string, unknown>;
    useImperativeHandle(props.ref, () => ({
      scrollToEnd: h.scrollToEnd,
      scrollToIndex: h.scrollToIndex,
      scrollToOffset: h.scrollToOffset,
    }));
    return (
      <div role={props.role} aria-label={props["aria-label"]}>
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
        ))}
      </div>
    );
  },
}));

import { JobLog, type JobLogSource } from "./JobLog";

const E = "\u001b";
const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
let container: HTMLDivElement;
let root: Root;
const onLineLink = vi.fn();

function chunk(
  text: string,
  offset: number,
  options: Partial<Extract<PipelinesJobLog, { _tag: "chunk" }>> = {},
): PipelinesJobLog {
  return {
    _tag: "chunk",
    text,
    offset,
    nextOffset: offset + utf8Length(text),
    totalBytes: null,
    complete: true,
    truncatedHead: false,
    firstLine: offset === 0 ? 0 : null,
    ...options,
  };
}

/** Flushes until `check` passes: spans and layouts arrive over several async turns. */
async function until(check: () => void, attempts = 50) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await flush();
    }
  }
}

async function flush(ms = 0) {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, ms));
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

async function render(
  options: { source?: JobLogSource; at?: number | null; answers?: PipelinesJobLog[] } = {},
) {
  h.answers.push(...(options.answers ?? []));
  await act(async () =>
    root.render(
      <JobLog.Provider
        source={options.source ?? { _tag: "complete", jobId: 998, attempt: null }}
        scope={scope}
        initialOffset={options.at ?? null}
        rawLogUrl="https://gitlab.com/acme/repo/-/jobs/998/raw"
        hostName="GitLab"
        onLineLink={onLineLink}
        createEngine={() => createMainThreadJobLogEngine(() => Promise.resolve())}
      >
        <JobLog.Toolbar>
          <JobLog.Search />
          <JobLog.TimestampsToggle />
          <JobLog.WrapToggle />
          <JobLog.SectionsToggle />
          <JobLog.ScrollButtons />
          <JobLog.RawLink />
        </JobLog.Toolbar>
        <JobLog.LoadEarlier />
        <JobLog.Lines />
        <JobLog.Status />
      </JobLog.Provider>,
    ),
  );
  await flush();
  await flush();
}

const lines = () =>
  [...container.querySelectorAll("[data-line]")].map((row) => ({
    number: row.getAttribute("data-line"),
    text: row.textContent?.replace(/^\d+/, ""),
  }));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name || element.getAttribute("aria-label") === name,
  ) as HTMLButtonElement | undefined;
const searchBox = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Search log"]')!;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  h.answers = [];
  h.reads = [];
  h.listProps = null;
  h.scrollToEnd.mockClear();
  h.scrollToIndex.mockClear();
  onLineLink.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("JobLog", () => {
  it("renders colored lines with absolute numbers and opens a finished log at its end", async () => {
    await render({ answers: [chunk(`${E}[31mred${E}[0m text\nplain\n`, 0)] });
    await until(() =>
      expect(lines()).toEqual([
        { number: "1", text: "red text" },
        { number: "2", text: "plain" },
      ]),
    );
    const red = [...container.querySelectorAll("span")].find((span) => span.textContent === "red");
    expect(red?.getAttribute("style")).toContain("var(--log-ansi-1)");
    expect(h.listProps).toMatchObject({ initialScrollAtEnd: true, maintainScrollAtEnd: true });
    expect(
      container.querySelector('[role="log"]')?.closest("[style]")?.getAttribute("style"),
    ).toContain("--log-ansi-1");
  });

  it("numbers a tail window from its first loaded line, says so, and renumbers when earlier text loads", async () => {
    const head = "zero\none\n";
    const tail = "two\nthree\n";
    await render({ answers: [chunk(tail, utf8Length(head), { firstLine: null, complete: true })] });
    // The window may start mid-line: its first line waits for earlier text.
    await until(() => expect(lines()).toEqual([{ number: "1", text: "three" }]));
    expect(container.textContent).toContain("Line numbers start at the first loaded line.");
    h.answers.push(chunk(head, 0, { firstLine: 0, complete: false }));
    await act(async () => button("Load earlier")!.click());
    await flush();
    expect(h.reads.at(-1)).toMatchObject({ from: { _tag: "before", offset: utf8Length(head) } });
    await until(() => expect(lines().map((line) => line.number)).toEqual(["1", "2", "3", "4"]));
    expect(container.textContent).not.toContain("Line numbers start at the first loaded line.");
  });

  it("folds a section from its header", async () => {
    await render({
      answers: [
        chunk(
          `section_start:1:build\r${E}[0KBuild\ncompile\nsection_end:5:build\r${E}[0K\nafter\n`,
          0,
        ),
      ],
    });
    await until(() =>
      expect(lines().map((line) => line.text)).toEqual(["Build4s", "compile", "after"]),
    );
    const header = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await act(async () => header.click());
    await flush();
    await until(() => expect(lines().map((line) => line.text)).toEqual(["Build4s", "after"]));
    await act(async () => button("Expand all")!.click());
    await flush();
    await until(() => expect(lines()).toHaveLength(3));
  });

  it("searches, wraps next and previous, and opens a folded section to show a match", async () => {
    await render({
      answers: [
        chunk(
          `needle one\nsection_start:1:s[collapsed=true]\rStep\nneedle two\nsection_end:2:s\r\n`,
          0,
        ),
      ],
    });
    await act(async () => type(searchBox(), "NEEDLE"));
    await flush(200);
    expect(container.textContent).toContain("1 of 2");
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    await act(async () => button("Next match")!.click());
    await flush();
    expect(container.textContent).toContain("2 of 2");
    await until(() => expect(lines().map((line) => line.text)).toContain("needle two"));
    await act(async () => button("Next match")!.click());
    await flush();
    expect(container.textContent).toContain("1 of 2");
    await act(async () => button("Previous match")!.click());
    await flush();
    expect(container.textContent).toContain("2 of 2");
  });

  it("focuses search on Mod+F, handling one press once, and returns to the log on Escape", async () => {
    await render({ answers: [chunk("a\n", 0)] });
    const later = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", later);
    const event = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: navigator.platform.includes("Mac"),
      ctrlKey: !navigator.platform.includes("Mac"),
      bubbles: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(event));
    window.removeEventListener("keydown", later);
    expect(event.defaultPrevented).toBe(true);
    expect(later).toHaveLastReturnedWith(true);
    expect(document.activeElement).toBe(searchBox());
    await act(async () =>
      searchBox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.activeElement).toBe(container.querySelector('[role="log"]')?.parentElement);
  });

  it("links a line by its byte offset and highlights it", async () => {
    await render({ answers: [chunk("é first\nsecond\n", 0)] });
    await act(async () => button("Link to line 2")!.click());
    expect(onLineLink).toHaveBeenCalledWith(utf8Length("é first\n"));
    expect(container.querySelector('[data-line="2"]')?.getAttribute("aria-current")).toBe("true");
  });

  it("opens a line link on its window without reading the prefix", async () => {
    await render({
      at: 700_000,
      answers: [chunk("linked\nnext\n", 700_000, { firstLine: 41, complete: false })],
    });
    expect(h.reads).toEqual([
      {
        cwd: "/repo",
        jobId: 998,
        attempt: null,
        from: { _tag: "offset", offset: 700_000 },
        refresh: "user",
      },
    ]);
    await until(() =>
      expect(lines()).toEqual([
        { number: "42", text: "linked" },
        { number: "43", text: "next" },
      ]),
    );
    expect(container.querySelector('[data-line="42"]')?.getAttribute("aria-current")).toBe("true");
    // The rest of the finished log loads when its end is reached, not before.
    h.answers.push(chunk("last\n", 700_012, { firstLine: null, complete: true }));
    const onEndReached = h.listProps!.onEndReached as () => void;
    await act(async () => onEndReached());
    await flush();
    expect(h.reads.at(-1)).toMatchObject({
      from: { _tag: "offset", offset: 700_012 },
      refresh: "user",
    });
    await until(() => expect(lines().map((line) => line.number)).toEqual(["42", "43", "44"]));
    expect(h.listProps!.onEndReached).toBeUndefined();
  });

  it("shows Jump to latest after scrolling up a running log", async () => {
    await render({
      source: { _tag: "live", jobId: 998, attempt: null, started: true },
      answers: [chunk("running\n", 0, { complete: false })],
    });
    expect(button("Jump to latest")).toBeUndefined();
    const onScroll = h.listProps!.onScroll as (event: unknown) => void;
    await act(async () =>
      onScroll({
        nativeEvent: {
          contentOffset: { y: 0 },
          contentSize: { height: 2_000 },
          layoutMeasurement: { height: 400 },
        },
      }),
    );
    await act(async () => button("Jump to latest")!.click());
    expect(h.scrollToEnd).toHaveBeenCalled();
    expect(button("Jump to latest")).toBeUndefined();
  });

  it("shows the timestamp column only for a stamped log, when asked", async () => {
    await render({ answers: [chunk("2026-10-25T10:00:00.000000Z 00O hello\n", 0)] });
    await until(() => expect(lines()).toEqual([{ number: "1", text: "hello" }]));
    const toggle = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Timestamps",
    )!;
    await act(async () => toggle.click());
    expect(container.querySelector("[data-line] span[title]")?.getAttribute("title")).toBe(
      "2026-10-25T10:00:00.000Z",
    );
  });

  it("explains an unavailable log and offers the host for a too-large running one", async () => {
    await render({
      source: { _tag: "live", jobId: 998, attempt: null, started: true },
      answers: [
        {
          _tag: "unavailable",
          reason: "too_large_live",
          url: "https://gitlab.com/acme/repo/-/jobs/998",
        },
      ],
    });
    expect(container.textContent).toContain("This running log is over 2 MB.");
    const onScroll = h.listProps?.onScroll as ((event: unknown) => void) | undefined;
    if (onScroll)
      await act(async () =>
        onScroll({
          nativeEvent: {
            contentOffset: { y: 0 },
            contentSize: { height: 2_000 },
            layoutMeasurement: { height: 400 },
          },
        }),
      );
    // The paused log will not grow, so there is no latest to jump to.
    expect(button("Jump to latest")).toBeUndefined();
    expect(
      container.querySelector('a[href="https://gitlab.com/acme/repo/-/jobs/998"]')?.textContent,
    ).toBe("Open on GitLab");
  });

  it("says when the host keeps a running log, linking its page and reading nothing", async () => {
    await render({
      source: {
        _tag: "unavailable",
        reason: "live_on_host",
        url: "https://github.com/acme/repo/actions/runs/1/job/998",
      },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "shows live logs on its site.",
    );
    expect(
      container.querySelector('a[href="https://github.com/acme/repo/actions/runs/1/job/998"]'),
    ).not.toBeNull();
    expect(h.reads).toHaveLength(0);
  });

  it("explains a job without a log", async () => {
    await render({ answers: [{ _tag: "unavailable", reason: "no_output", url: null }] });
    expect(container.textContent).toContain("This job didn't produce a log.");
  });
});
