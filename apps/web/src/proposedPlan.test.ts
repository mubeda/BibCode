// @vitest-environment happy-dom
import type { DesktopBridge } from "@bibcode/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("./components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/ui/toast")>()),
  toastManager: { add: toastAdd },
}));

import {
  downloadPlanAsTextFile,
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  buildProposedPlanMarkdownFilename,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });
});

describe("buildPlanImplementationPrompt", () => {
  it("formats the plan exactly like the Codex follow-up handoff prompt", () => {
    expect(buildPlanImplementationPrompt("## Ship it\n\n- step 1\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
    );
  });
});

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("drops the redundant title heading and preserves the following markdown lines", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        "# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2",
        {
          maxLines: 4,
        },
      ),
    ).toBe("- step 1\n- step 2");
  });

  it("appends an overflow marker when the preview truncates remaining content", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown("# Integrate RPC\n\n- step 1\n- step 2\n- step 3", {
        maxLines: 2,
      }),
    ).toBe("- step 1\n- step 2\n\n...");
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("drops the leading title heading from displayed plan markdown", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Summary\n\n- step 1\n")).toBe(
      "- step 1",
    );
  });

  it("preserves non-summary headings after dropping the title heading", () => {
    expect(stripDisplayedPlanMarkdown("# Integrate RPC\n\n## Scope\n\n- step 1\n")).toBe(
      "## Scope\n\n- step 1",
    );
  });
});

describe("resolvePlanFollowUpSubmission", () => {
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
    });
  });

  it("stays in plan mode when the user adds a follow-up prompt", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "Refine step 2 first",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "Refine step 2 first",
      interactionMode: "plan",
    });
  });
});

describe("buildPlanImplementationThreadTitle", () => {
  it("uses the plan heading when building the implementation thread title", () => {
    expect(buildPlanImplementationThreadTitle("# Integrate RPC\n\nBody")).toBe(
      "Implement Integrate RPC",
    );
  });

  it("falls back when the plan has no markdown heading", () => {
    expect(buildPlanImplementationThreadTitle("- step 1")).toBe("Implement plan");
  });
});

describe("buildProposedPlanMarkdownFilename", () => {
  it("derives a stable markdown filename from the plan heading", () => {
    expect(buildProposedPlanMarkdownFilename("# Integrate Effect RPC Into Server App")).toBe(
      "integrate-effect-rpc-into-server-app.md",
    );
  });

  it("keeps a long title within what the desktop Save dialog accepts", () => {
    const filename = buildProposedPlanMarkdownFilename(`# ${"word ".repeat(100)}`);
    expect(filename.length).toBeLessThanOrEqual(124);
    expect(filename).toMatch(/^word(-word)*\.md$/);
  });

  it("falls back to a generic filename when the plan has no heading", () => {
    expect(buildProposedPlanMarkdownFilename("- step 1")).toBe("plan.md");
  });
});

describe("downloadPlanAsTextFile", () => {
  const saveTextFile = vi.fn<NonNullable<DesktopBridge["saveTextFile"]>>();
  afterEach(() => {
    delete window.desktopBridge;
    saveTextFile.mockReset();
    toastAdd.mockReset();
    vi.restoreAllMocks();
  });
  const inDesktop = () => {
    window.desktopBridge = { saveTextFile } as unknown as DesktopBridge;
  };

  it("in the desktop app saves through the bridge with the plan filename", async () => {
    inDesktop();
    saveTextFile.mockResolvedValue("/chosen/plan.md");
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await downloadPlanAsTextFile("integrate-rpc.md", "# Integrate RPC\n");
    expect(saveTextFile).toHaveBeenCalledWith({
      suggestedName: "integrate-rpc.md",
      contents: "# Integrate RPC\n",
    });
    expect(anchorClick).not.toHaveBeenCalled();
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("a cancelled save writes nothing and shows no error", async () => {
    inDesktop();
    saveTextFile.mockResolvedValue(null);
    await downloadPlanAsTextFile("plan.md", "# Plan\n");
    expect(saveTextFile).toHaveBeenCalledOnce();
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("a failed save shows an error", async () => {
    inDesktop();
    saveTextFile.mockRejectedValue(new Error("Could not save the file: disk full"));
    await downloadPlanAsTextFile("plan.md", "# Plan\n");
    expect(toastAdd).toHaveBeenCalledOnce();
    expect(toastAdd.mock.calls[0]![0]).toMatchObject({
      type: "error",
      description: "Could not save the file: disk full",
    });
  });

  it("in the browser keeps the download link", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:plan");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let downloaded: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    await downloadPlanAsTextFile("plan.md", "# Plan\n");
    expect(downloaded).toBe("plan.md");
  });
});
