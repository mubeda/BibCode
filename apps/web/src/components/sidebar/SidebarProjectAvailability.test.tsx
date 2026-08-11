import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId } from "@bibcode/contracts";

import { SidebarProjectAvailability } from "./SidebarProjectAvailability";
import type { SidebarProjectAvailabilityView } from "../Sidebar.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function view(
  kind:
    | "available"
    | "empty-confirmed"
    | "loading"
    | "degraded"
    | "storage-changed"
    | "recovery-required"
    | "unavailable"
    | "configuration-error",
): SidebarProjectAvailabilityView {
  switch (kind) {
    case "available":
    case "empty-confirmed":
    case "loading":
      return { kind, environmentId: null, error: null };
    case "degraded":
    case "storage-changed":
    case "recovery-required":
    case "unavailable":
    case "configuration-error":
      return {
        kind,
        environmentId: ENVIRONMENT_ID,
        error: null,
        hasCachedProjects: kind === "degraded",
      };
  }
}

function render(kind: Parameters<typeof view>[0]) {
  return renderToStaticMarkup(
    <SidebarProjectAvailability
      view={view(kind)}
      onRetry={vi.fn()}
      onOpenSettings={vi.fn()}
      onViewDiagnostics={vi.fn()}
      onAdoptStorage={vi.fn()}
    />,
  );
}

describe("SidebarProjectAvailability", () => {
  it("uses the genuine empty copy only for an authoritative empty catalog", () => {
    expect(render("empty-confirmed")).toContain("No projects yet");
    for (const kind of [
      "loading",
      "degraded",
      "storage-changed",
      "recovery-required",
      "unavailable",
      "configuration-error",
    ] as const) {
      expect(render(kind)).not.toContain("No projects yet");
    }
  });

  it.each([
    ["loading", "Project data is still loading"],
    ["degraded", "Showing cached projects"],
    ["storage-changed", "Project data location changed"],
    ["recovery-required", "Project data needs recovery"],
    ["unavailable", "Projects are unavailable"],
    ["configuration-error", "Project data configuration needs attention"],
  ] as const)("renders honest %s copy", (kind, copy) => {
    expect(render(kind)).toContain(copy);
  });

  it("wires retry, settings, diagnostics, and explicit storage adoption actions", () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    const onViewDiagnostics = vi.fn();
    const onAdoptStorage = vi.fn();
    const element = SidebarProjectAvailability({
      view: view("storage-changed"),
      onRetry,
      onOpenSettings,
      onViewDiagnostics,
      onAdoptStorage,
    });
    if (element === null || typeof element !== "object" || !("props" in element)) {
      throw new Error("Expected the availability component to render actions.");
    }
    const children = Array.isArray(element.props.children)
      ? element.props.children
      : [element.props.children];
    const actions = children.flatMap((child: any) =>
      child?.props?.children === undefined
        ? []
        : Array.isArray(child.props.children)
          ? child.props.children
          : [child.props.children],
    );
    for (const action of actions) {
      if (action?.props?.children === "Retry") action.props.onClick();
      if (action?.props?.children === "Settings") action.props.onClick();
      if (action?.props?.children === "Diagnostics") action.props.onClick();
      if (action?.props?.children === "Use this data location") action.props.onClick();
    }
    expect(onRetry).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onViewDiagnostics).toHaveBeenCalledOnce();
    expect(onAdoptStorage).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });

  it("renders nothing while live projects are available", () => {
    expect(render("available")).toBe("");
  });

  it("labels retained rows as cached while storage adoption is blocked", () => {
    const markup = renderToStaticMarkup(
      <SidebarProjectAvailability
        view={{
          kind: "storage-changed",
          environmentId: ENVIRONMENT_ID,
          error: null,
          hasCachedProjects: true,
        }}
        onRetry={vi.fn()}
        onOpenSettings={vi.fn()}
        onViewDiagnostics={vi.fn()}
        onAdoptStorage={vi.fn()}
      />,
    );
    expect(markup).toContain("Cached projects remain visible");
  });
});
