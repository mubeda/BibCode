// @vitest-environment happy-dom
import { EnvironmentId, type PipelinesJobLog, type ThemeFile } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { utf8Length } from "./jobLog.parse";
import { createMainThreadJobLogEngine } from "./jobLogEngine";

vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: { getJobLog: { label: "environment-data:pipelines:get-job-log" } },
}));
const text = "\u001b[31mred\u001b[0m\n";
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async () =>
    AsyncResult.success({
      _tag: "chunk",
      text,
      offset: 0,
      nextOffset: utf8Length(text),
      totalBytes: null,
      complete: true,
      truncatedHead: false,
      firstLine: 0,
    } satisfies PipelinesJobLog),
}));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly number[];
    keyExtractor: (item: number) => string;
    renderItem: (p: { item: number; index: number }) => ReactNode;
  }) => (
    <div>
      {props.data.map((item, index) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

import { saveCustomTheme, setSlot } from "../../../themes/customThemes";
import { JobLog } from "./JobLog";

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("a mounted job log repaints after a saved edit to a theme with the same id", async () => {
  const theme: ThemeFile = {
    version: 1,
    id: "mine",
    name: "Mine",
    base: "light",
    terminal: { red: "#aa0000" },
  };
  expect(saveCustomTheme(theme)).toEqual({ ok: true });
  expect(setSlot("light", "mine")).toEqual({ ok: true });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <JobLog.Provider
        source={{ _tag: "complete", jobId: 1, attempt: null }}
        scope={{ environmentId: EnvironmentId.make("env"), cwd: "/repo" }}
        initialOffset={null}
        rawLogUrl="https://gitlab.example.test/example-group/sample-project/-/jobs/1/raw"
        hostName="GitLab"
        onLineLink={vi.fn()}
        createEngine={() => createMainThreadJobLogEngine(() => Promise.resolve())}
      >
        <JobLog.Lines />
      </JobLog.Provider>,
    ),
  );
  await flush();
  await flush();
  const logRoot = () => container.querySelector<HTMLElement>('[style*="--log-ansi-1"]');
  expect(logRoot()?.style.getPropertyValue("--log-ansi-1")).toBe("#aa0000");

  const element = logRoot();
  await act(async () => {
    saveCustomTheme({ ...theme, terminal: { red: "#ff5555" } });
  });
  expect(logRoot()).toBe(element);
  expect(logRoot()?.style.getPropertyValue("--log-ansi-1")).toBe("#ff5555");

  await act(async () => root.unmount());
  container.remove();
});
