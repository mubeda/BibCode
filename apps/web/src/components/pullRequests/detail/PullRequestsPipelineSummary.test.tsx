// @vitest-environment happy-dom
import type { PullRequestsPipeline, PullRequestsPipelineStatus } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("../../../localApi", () => ({ readLocalApi: () => null }));
import { PullRequestsPipelineSummary } from "./PullRequestsPipelineSummary";

type Present = Extract<PullRequestsPipeline, { _tag: "present" }>;
const running: Present = {
  _tag: "present",
  id: 4821,
  status: "running",
  warnings: false,
  kind: "merge_request",
  ref: "refs/merge-requests/42/head",
  sha: "abc1234def5678",
  isForHead: true,
  url: "https://gitlab.example/team/repo/-/pipelines/4821",
  updatedAt: "2026-10-24T10:00:00Z",
  startedAt: "2026-10-24T09:58:00Z",
  finishedAt: null,
  durationSeconds: null,
  stages: [
    { name: "build", status: "success", warnings: false },
    { name: "test", status: "running", warnings: false },
    { name: "lint", status: "success", warnings: true },
  ],
};

function text(pipeline: PullRequestsPipeline): string {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <PullRequestsPipelineSummary pipeline={pipeline} branch="feature/login" settled />,
  );
  return container.textContent ?? "";
}

describe("PullRequestsPipelineSummary", () => {
  it("names the kind, number, status, commit and branch, and links the number", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <PullRequestsPipelineSummary pipeline={running} branch="feature/login" settled />,
    );
    expect(container.textContent).toContain(
      "Merge request pipeline #4821 running· abc1234 on feature/login",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(running.url);
    expect(container.querySelector("a")?.textContent).toBe("#4821");
    const stages = [...container.querySelectorAll('[aria-label="Pipeline stages"] li')];
    expect(stages.map((stage) => stage.getAttribute("aria-label"))).toEqual([
      "build: passed",
      "test: running",
      "lint: passed with warnings",
    ]);
    // A running stage spins only when motion is welcome.
    expect(stages[1]!.querySelector(".motion-safe\\:animate-spin svg")).not.toBeNull();
    expect(stages[0]!.querySelector(".motion-safe\\:animate-spin")).toBeNull();
  });

  it.each([
    ["merge_request", "Merge request pipeline #4821", true],
    ["merged_results", "Merged results pipeline #4821", false],
    ["merge_train", "Merge train pipeline #4821", false],
    ["branch", "Branch pipeline #4821", true],
    ["other", "Pipeline #4821", false],
  ] as const)("labels a %s pipeline and shows a pushed commit only", (kind, label, sha) => {
    const copy = text({ ...running, kind });
    expect(copy).toContain(label);
    expect(copy.includes("abc1234")).toBe(sha);
    expect(copy).toContain("on feature/login");
  });

  it.each<[PullRequestsPipelineStatus, boolean, string]>([
    ["created", false, "created"],
    ["queued", false, "queued"],
    ["running", false, "running"],
    ["waiting", false, "waiting"],
    ["manual", false, "waiting for a manual job"],
    ["scheduled", false, "scheduled"],
    ["canceling", false, "canceling"],
    ["success", false, "passed"],
    ["success", true, "passed with warnings"],
    ["failed", false, "failed"],
    ["canceled", false, "canceled"],
    ["skipped", false, "skipped"],
    ["unknown", false, "status unknown"],
  ])("words %s (warnings %s) as %s", (status, warnings, words) => {
    expect(text({ ...running, status, warnings })).toContain(`#4821 ${words}`);
  });

  it("marks a pipeline for an older commit and keeps an unknown head unmarked", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <PullRequestsPipelineSummary
        pipeline={{ ...running, isForHead: false }}
        branch="feature/login"
        settled
      />,
    );
    const badge = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "Older commit",
    );
    expect(badge?.getAttribute("title")).toBe("This pipeline ran before the latest push.");
    expect(text({ ...running, isForHead: null })).not.toContain("Older commit");
  });

  it("says when the account cannot view pipelines and shows nothing for none", () => {
    expect(text({ _tag: "hidden" })).toBe("You can't view pipelines in this project.");
    expect(text({ _tag: "none" })).toBe("");
    expect(text({ ...running, stages: null })).not.toContain("test");
  });

  describe("announcements", () => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement("div");
      root = createRoot(container);
    });
    afterEach(async () => {
      await act(async () => root.unmount());
    });
    const render = (pipeline: PullRequestsPipeline, settled = true) =>
      act(async () =>
        root.render(
          <PullRequestsPipelineSummary
            pipeline={pipeline}
            branch="feature/login"
            settled={settled}
          />,
        ),
      );
    const region = () => container.querySelector('[aria-live="polite"]')!;

    it("announces a finish seen while shown once, and never the first paint", async () => {
      await render({ ...running, status: "success" });
      expect(region().textContent).toBe("");
      await render(running);
      await render({ ...running, status: "success", warnings: true });
      expect(region().textContent).toBe("Pipeline #4821 passed with warnings.");
      await render({ ...running, status: "success", warnings: true });
      expect(region().textContent).toBe("Pipeline #4821 passed with warnings.");
    });

    it("does not announce a stored copy replaced by this mount's first live read", async () => {
      await render(running, false);
      await render({ ...running, status: "failed" }, true);
      expect(region().textContent).toBe("");
      await render({ ...running, id: 4822, status: "running" });
      await render({ ...running, id: 4822, status: "failed" });
      expect(region().textContent).toBe("Pipeline #4822 failed.");
    });
  });
});
