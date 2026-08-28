// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { RemoteUpdateSnapshot } from "@bibcode/contracts";

import {
  ServerUpdateBadge,
  manualUpdateInstructions,
  serverUpdateBadgeVariant,
} from "./ServerUpdateBadge";

const manualSnapshot: RemoteUpdateSnapshot = {
  serverVersion: "0.4.2",
  latestVersion: null,
  state: "idle",
  error: null,
  support: { installMode: "manual", reason: "manual-update-required" },
};

const interactiveSnapshot: RemoteUpdateSnapshot = {
  ...manualSnapshot,
  latestVersion: "0.5.0",
  state: "update-available",
  support: { installMode: "interactive", reason: "available" },
};

describe("serverUpdateBadgeVariant", () => {
  it("maps every snapshot state onto a badge variant", () => {
    expect(serverUpdateBadgeVariant(null)).toBe("unknown");
    expect(serverUpdateBadgeVariant(manualSnapshot)).toBe("manual");
    expect(serverUpdateBadgeVariant({ ...manualSnapshot, state: "up-to-date" })).toBe("up-to-date");
    expect(serverUpdateBadgeVariant(interactiveSnapshot)).toBe("update-available");
    expect(serverUpdateBadgeVariant({ ...interactiveSnapshot, state: "checking" })).toBe("busy");
    expect(serverUpdateBadgeVariant({ ...interactiveSnapshot, state: "downloading" })).toBe("busy");
    expect(serverUpdateBadgeVariant({ ...interactiveSnapshot, state: "installing" })).toBe("busy");
    expect(
      serverUpdateBadgeVariant({ ...interactiveSnapshot, state: "error", error: "boom" }),
    ).toBe("error");
  });
});

describe("ServerUpdateBadge", () => {
  it("names the available version when known", () => {
    const markup = renderToStaticMarkup(<ServerUpdateBadge snapshot={interactiveSnapshot} />);
    expect(markup).toContain("0.5.0");
    expect(markup).toContain('data-variant="update-available"');
  });

  it("labels manual servers without claiming update knowledge", () => {
    const markup = renderToStaticMarkup(<ServerUpdateBadge snapshot={manualSnapshot} />);
    expect(markup).toContain("Manual updates");
  });
});

describe("manualUpdateInstructions", () => {
  it("gives copy-paste steps that mention the running version", () => {
    const instructions = manualUpdateInstructions("0.4.2");
    expect(instructions).toContain("bibcode serve");
    expect(instructions).toContain("0.4.2");
  });
});
