import type { ServerTool } from "@bibcode/contracts";

export type ToolRowTone = "neutral" | "warning" | "success" | "error";

export interface ToolRowView {
  /** The sentence under the tool's name: what is installed and what happens next. */
  readonly description: string;
  readonly tone: ToolRowTone;
  /** Present when the Update button is available. */
  readonly canUpdate: boolean;
  /** Why the Update button is off, when it is off and the description does not already say so. */
  readonly disabledReason: string | null;
  readonly updating: boolean;
}

function versionLabel(version: string | null): string {
  return version === null ? "unknown version" : `version ${version.replace(/^v/, "")}`;
}

/**
 * What the Tools group says about one tool. Every state names what BiBCode found and what the
 * person can do: an install BiBCode cannot update says how to update it by hand, a damaged one
 * says why it is flagged, and a running one says the button is busy.
 */
export function toolRowView(tool: ServerTool): ToolRowView {
  const advisory = tool.versionAdvisory;
  const state = tool.updateState;
  if (state?.status === "queued" || state?.status === "running") {
    return {
      description: `${state.message ?? "Updating."} Running agent sessions keep the old version until they restart.`,
      tone: "neutral",
      canUpdate: false,
      disabledReason: null,
      updating: true,
    };
  }
  if (!tool.installed) {
    return {
      description: `Not installed. BiBCode does not install ${tool.displayName}.`,
      tone: "neutral",
      canUpdate: false,
      disabledReason: null,
      updating: false,
    };
  }
  const installed = `${tool.displayName} ${versionLabel(tool.version)} is installed.`;
  if (state?.status === "failed" || state?.status === "unchanged") {
    return {
      description:
        `${state.message ?? "The last update did not finish."} ${advisory?.message ?? ""}`.trim(),
      tone: state.status === "failed" ? "error" : "warning",
      canUpdate: advisory?.canUpdate === true,
      disabledReason: null,
      updating: false,
    };
  }
  if (advisory?.status === "behind_latest" && advisory.latestVersion !== null) {
    return {
      description: `${installed} Version ${advisory.latestVersion.replace(/^v/, "")} is available.`,
      tone: "warning",
      canUpdate: advisory.canUpdate,
      disabledReason: advisory.canUpdate
        ? null
        : "BiBCode cannot update this installation. Update it with its own installer.",
      updating: false,
    };
  }
  if (advisory?.status === "current") {
    return {
      description: `${installed} It is up to date.`,
      tone: "success",
      canUpdate: false,
      disabledReason: null,
      updating: false,
    };
  }
  // Unknown: a registry failure, an install BiBCode will not touch, or a damaged one.
  return {
    description: `${installed} ${advisory?.message ?? "BiBCode could not check for a newer version."}`,
    tone: advisory?.message === null || advisory?.message === undefined ? "neutral" : "warning",
    canUpdate: advisory?.canUpdate === true,
    disabledReason: null,
    updating: false,
  };
}
