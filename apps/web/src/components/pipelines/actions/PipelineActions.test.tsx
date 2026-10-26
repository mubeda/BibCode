// @vitest-environment happy-dom
import {
  EnvironmentId,
  PullRequestsOperationError,
  type PipelinesActionResult,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ command: vi.fn(), toast: vi.fn() }));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => h.command }));
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: { runAction: { label: "environment-data:pipelines:run-action" } },
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: h.toast } }));

import { PipelineActions, type PipelineActionOutcome } from "./PipelineActions";

const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
const allowed = { allowed: true, reason: null };
const retryJob = { target: { _tag: "job", id: 998 }, action: "retry" } as const;
let root: Root;
let node: HTMLDivElement;
let settled: PipelineActionOutcome[];

function Status() {
  const status = PipelineActions.useShownStatus({ id: 31, status: "running", terminal: false });
  return <output>{status}</output>;
}

function render(revision: number, provider: "gitlab" | "github" = "gitlab") {
  act(() =>
    root.render(
      <PipelineActions.Provider
        scope={scope}
        provider={provider}
        revision={revision}
        onSettled={(outcome) => settled.push(outcome)}
      >
        <PipelineActions.Button
          aria-label="Retry test"
          request={retryJob}
          permission={allowed}
          icon={<svg data-icon="retry" />}
        />
        <PipelineActions.Button
          aria-label="Cancel run"
          request={{ target: { _tag: "pipeline", id: 31 }, action: "cancel" }}
          permission={allowed}
          from="running"
        />
        <PipelineActions.Button
          aria-label="Run deploy"
          request={{ target: { _tag: "job", id: 7 }, action: "play" }}
          permission={{ allowed: false, reason: "You don't have permission to run this job." }}
        />
        <Status />
      </PipelineActions.Provider>,
    ),
  );
}

function button(label: string) {
  return node.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  settled = [];
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

describe("PipelineActions", () => {
  it("sends one action for a double click and spins until the page's next copy lands", async () => {
    const answer = deferred<{ _tag: "Success"; value: PipelinesActionResult }>();
    h.command.mockReturnValue(answer.promise);
    render(1);
    act(() => {
      button("Retry test").click();
      button("Retry test").click();
    });
    expect(h.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { cwd: "/repo", target: { _tag: "job", id: 998 }, action: "retry" },
    });
    // Still focusable, so the keyboard keeps its place, but it takes no click.
    expect(button("Retry test").getAttribute("aria-busy")).toBe("true");
    expect(button("Retry test").getAttribute("aria-disabled")).toBe("true");
    expect(button("Retry test").disabled).toBe(false);
    expect(node.querySelector('[data-icon="retry"]')).toBeNull();

    await act(async () =>
      answer.resolve({ _tag: "Success", value: { pipelineId: 4821, jobId: 1001 } }),
    );
    expect(settled).toEqual([{ request: retryJob, result: { pipelineId: 4821, jobId: 1001 } }]);
    // The answer is in; the re-read it asked for is not yet, and a click still sends nothing.
    expect(button("Retry test").getAttribute("aria-busy")).toBe("true");
    act(() => button("Retry test").click());
    expect(h.command).toHaveBeenCalledOnce();
    render(2);
    expect(button("Retry test").getAttribute("aria-busy")).toBeNull();
    expect(button("Retry test").getAttribute("aria-disabled")).toBeNull();
    expect(node.querySelector('[data-icon="retry"]')).not.toBeNull();
  });

  it("shows the host's copy on a failure and still re-reads, so a refusal reaches the button", async () => {
    const refusal = new PullRequestsOperationError({
      operation: "pipelines.runAction",
      code: "forbidden",
      message:
        "GitHub refused: this sign-in can't run Actions for this repository. A fine-grained token needs Actions write.",
      hostDetail: "gh: Resource not accessible by personal access token (HTTP 403)",
      retryable: false,
    });
    h.command.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(refusal) });
    render(1, "github");
    await act(async () => button("Retry test").click());
    expect(h.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: refusal.message,
      description: "gh: Resource not accessible by personal access token (HTTP 403)",
    });
    expect(settled).toEqual([{ request: retryJob, result: null }]);
    expect(button("Retry test").disabled).toBe(false);
  });

  it("keeps a disabled action's reason and sends nothing for it", () => {
    render(1);
    expect(button("Run deploy").disabled).toBe(true);
    expect(button("Run deploy").title).toBe("You don't have permission to run this job.");
    act(() => button("Run deploy").click());
    expect(h.command).not.toHaveBeenCalled();
  });

  it("shows a GitHub cancel as canceling until the run moves on", async () => {
    h.command.mockResolvedValue({ _tag: "Success", value: { pipelineId: 31, jobId: null } });
    render(1, "github");
    expect(node.querySelector("output")!.textContent).toBe("running");
    await act(async () => button("Cancel run").click());
    expect(node.querySelector("output")!.textContent).toBe("canceling");
  });
});
