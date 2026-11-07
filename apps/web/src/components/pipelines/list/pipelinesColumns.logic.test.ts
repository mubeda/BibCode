import { describe, expect, it } from "vite-plus/test";
import { COLUMN_BOUNDS, pipelinesGridTemplates, visibleStageCount } from "./pipelinesColumns.logic";

const widths = { pipeline: 480, author: 160, stages: 160 };

describe("pipelinesGridTemplates", () => {
  it("folds columns in a fixed order as the panel narrows", () => {
    const templates = pipelinesGridTemplates(widths, new Set());
    expect(templates.full).toBe("144px minmax(240px,480px) 160px 160px 104px");
    // Created by goes first, then Stages folds short, then Status folds to its icon.
    expect(templates.medium).toBe("144px minmax(0,1fr) 160px 104px");
    expect(templates.compact).toBe("144px minmax(0,1fr) 64px 104px");
    expect(templates.narrow).toBe("24px minmax(0,1fr) 64px 104px");
  });

  it("drops the track of a hidden column at every step", () => {
    const templates = pipelinesGridTemplates(widths, new Set(["author", "stages"] as const));
    expect(templates).toEqual({
      narrow: "24px minmax(0,1fr) 104px",
      compact: "144px minmax(0,1fr) 104px",
      medium: "144px minmax(0,1fr) 104px",
      full: "144px minmax(240px,480px) 104px",
    });
  });

  it("keeps the Pipeline minimum below its default width", () => {
    expect(COLUMN_BOUNDS.pipeline.min).toBeLessThan(COLUMN_BOUNDS.pipeline.default);
  });
});

describe("visibleStageCount", () => {
  it("shows all stages when they fit or the width is unknown", () => {
    expect(visibleStageCount(0, 6)).toBe(6);
    expect(visibleStageCount(106, 6)).toBe(6);
  });
  it("leaves room for the +N count when stages are left out", () => {
    expect(visibleStageCount(64, 6)).toBe(2);
    expect(visibleStageCount(10, 6)).toBe(0);
  });
});
