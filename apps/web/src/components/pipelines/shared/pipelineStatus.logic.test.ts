import { describe, expect, it } from "vite-plus/test";
import {
  formatPipelineDuration,
  pipelineBadgeLabel,
  pipelineStatusText,
} from "./pipelineStatus.logic";

describe("pipelineStatusText", () => {
  it("names a status, and a pass with warnings", () => {
    expect(pipelineStatusText("failed", false)).toBe("Failed");
    expect(pipelineStatusText("success", false)).toBe("Passed");
    expect(pipelineStatusText("success", true)).toBe("Passed with warnings");
  });

  it("lets a reason name the outcome instead of the status word", () => {
    expect(pipelineStatusText("skipped", false, "neutral")).toBe("Neutral");
    expect(pipelineStatusText("manual", false, "action_required")).toBe("Action required");
    expect(pipelineStatusText("waiting", false, "approval")).toBe("Waiting for approval");
  });
});

describe("formatPipelineDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatPipelineDuration(12.4)).toBe("12s");
    expect(formatPipelineDuration(252)).toBe("4m 12s");
    expect(formatPipelineDuration(3_900)).toBe("1h 5m");
    expect(formatPipelineDuration(-3)).toBe("0s");
  });
});

describe("pipelineBadgeLabel", () => {
  it("uses the host's words", () => {
    expect(pipelineBadgeLabel("merge_request")).toBe("merge request");
    expect(pipelineBadgeLabel("api")).toBe("API");
    expect(pipelineBadgeLabel("yaml_invalid")).toBe("YAML invalid");
  });
});
