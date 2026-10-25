import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PIPELINES_FILTERS } from "../../../pipelinesStore";
import { pipelineRow } from "../testFixtures";
import {
  buildPipelinesListInput,
  filtersSearch,
  listSnapshotInput,
  listTimerEnabled,
  mergePipelineRows,
  pipelineRowActions,
  shownFilters,
  validatePipelinesSearch,
} from "./pipelinesList.logic";

describe("pipelines list search", () => {
  it("keeps valid filters and drops defaults and junk", () => {
    expect(validatePipelinesSearch({ scope: "running", ref: " main ", workflow: "12" })).toEqual({
      scope: "running",
      ref: "main",
      workflow: 12,
    });
    expect(validatePipelinesSearch({ scope: "all", ref: "", workflow: "x" })).toEqual({});
    expect(validatePipelinesSearch({ scope: "bogus", workflow: -1 })).toEqual({});
  });

  it("writes only the filters that differ from the defaults", () => {
    expect(filtersSearch(DEFAULT_PIPELINES_FILTERS)).toEqual({});
    expect(filtersSearch({ scope: "finished", ref: "release", workflowId: null })).toEqual({
      scope: "finished",
      ref: "release",
    });
  });

  it("shows the route's filters when it names any, otherwise the project's last ones", () => {
    const stored = { scope: "running" as const, ref: "main", workflowId: null };
    expect(shownFilters({}, stored)).toBe(stored);
    expect(shownFilters(undefined, stored)).toBe(stored);
    // A copied link names its whole filter: what it leaves out is the default.
    expect(shownFilters({ ref: "release" }, stored)).toEqual({
      scope: "all",
      ref: "release",
      workflowId: null,
    });
  });
});

describe("pipelines list input", () => {
  it("reads every first page as a user read, and keys the snapshot by the list alone", () => {
    const input = buildPipelinesListInput(
      { scope: "running", ref: "main", workflowId: null },
      "/r",
    );
    expect(input).toEqual({
      cwd: "/r",
      scope: "running",
      ref: "main",
      workflowId: null,
      cursor: null,
      refresh: "user",
    });
    expect(listSnapshotInput({ ...input, cursor: "c2", refresh: "timer" })).toEqual({
      ...input,
      pipelineId: null,
      attempt: null,
      jobId: null,
    });
  });
});

describe("listTimerEnabled", () => {
  it("runs on GitLab as the stream's fallback, whatever the rows", () => {
    expect(listTimerEnabled("gitlab", [])).toBe(true);
    expect(listTimerEnabled("gitlab", [{ terminal: true }])).toBe(true);
  });

  it("runs on GitHub only while a shown pipeline can still change", () => {
    expect(listTimerEnabled("github", [])).toBe(false);
    expect(listTimerEnabled("github", [{ terminal: true }])).toBe(false);
    expect(listTimerEnabled("github", [{ terminal: true }, { terminal: false }])).toBe(true);
  });
});

describe("mergePipelineRows", () => {
  it("keeps one row per pipeline, the first page's copy first", () => {
    const fresh = { ...pipelineRow, status: "success" as const };
    const later = { ...pipelineRow, id: 4800, label: "#4800" };
    expect(mergePipelineRows([fresh], [pipelineRow, later])).toEqual([fresh, later]);
  });
});

describe("pipelineRowActions", () => {
  it("offers Retry for a finished pipeline that did not pass, and Cancel for a running one", () => {
    expect(pipelineRowActions(pipelineRow, null)).toEqual({
      retry: { allowed: true, reason: null },
      cancel: null,
    });
    expect(pipelineRowActions({ ...pipelineRow, status: "success" }, null)).toEqual({
      retry: null,
      cancel: null,
    });
    expect(
      pipelineRowActions({ ...pipelineRow, status: "running", terminal: false }, null),
    ).toEqual({ retry: null, cancel: { allowed: true, reason: null } });
  });

  it("explains a disabled action with the host's answer first", () => {
    const denied = {
      ...pipelineRow,
      permissions: { retry: "denied" as const, cancel: "granted" as const },
    };
    expect(pipelineRowActions(denied, "Update the server.").retry).toEqual({
      allowed: false,
      reason: "You don't have permission to retry pipelines in this project.",
    });
    expect(pipelineRowActions(pipelineRow, "Update the server.").retry).toEqual({
      allowed: false,
      reason: "Update the server.",
    });
    expect(pipelineRowActions({ ...pipelineRow, permissions: null }, null).retry).toEqual({
      allowed: false,
      reason: "The host didn't say whether you can retry pipelines.",
    });
  });
});
