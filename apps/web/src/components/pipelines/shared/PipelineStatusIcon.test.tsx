import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PipelineStatusIcon } from "./PipelineStatusIcon";

const render = (status: Parameters<typeof PipelineStatusIcon>[0]["status"], warnings = false) =>
  renderToStaticMarkup(<PipelineStatusIcon status={status} warnings={warnings} />);

describe("PipelineStatusIcon", () => {
  it("draws each status with its own shape", () => {
    expect(render("success")).toContain("lucide-circle-check");
    expect(render("failed")).toContain("lucide-circle-x");
    expect(render("manual")).toContain("lucide-circle-play");
    expect(render("scheduled")).toContain("lucide-clock");
    expect(render("skipped")).toContain("lucide-circle-minus");
    expect(render("unknown")).toContain("lucide-circle-help");
  });

  it("spins only a running status, and only when motion is allowed", () => {
    expect(render("running")).toContain("motion-safe:animate-spin");
    expect(render("queued")).not.toContain("animate-spin");
  });

  it("draws a success with warnings as a warning", () => {
    expect(render("success", true)).toContain("lucide-triangle-alert");
    expect(render("success", true)).not.toContain("lucide-circle-check");
  });

  it("draws a failure that was allowed to fail as a warning, not a failure", () => {
    expect(render("failed", true)).toContain("lucide-triangle-alert");
    expect(render("failed", true)).not.toContain("lucide-circle-x");
  });

  it("is decorative: the caller names the status", () => {
    expect(render("failed")).toContain('aria-hidden="true"');
  });
});
