import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectExternalUpdates,
  type ProviderVersionObservation,
} from "./externalUpdateNotice.logic";

const environmentId = EnvironmentId.make("environment-local");

const claude = (
  version: string | null,
  overrides: Partial<ProviderVersionObservation> = {},
): ProviderVersionObservation => ({
  environmentId,
  environmentLabel: "This computer",
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  version,
  updatedByBiBCode: false,
  ...overrides,
});

describe("detectExternalUpdates", () => {
  it("says nothing the first time an instance is seen", () => {
    const { notices, next } = detectExternalUpdates(
      new Map(),
      [claude("2.1.314")],
      new Set(),
      false,
    );
    expect(notices).toEqual([]);
    expect(next.get(`${environmentId}:claudeAgent`)).toBe("2.1.314");
  });

  it("announces a version that rose by itself, with what happens to running sessions", () => {
    const previous = new Map([[`${environmentId}:claudeAgent`, "2.1.314"]]);
    const { notices } = detectExternalUpdates(previous, [claude("2.1.318")], new Set(), false);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Claude updated to 2.1.318");
    expect(notices[0]?.description).toContain("running sessions keep 2.1.314");
  });

  it("names the environment only when there is more than one", () => {
    const previous = new Map([[`${environmentId}:claudeAgent`, "2.1.314"]]);
    const { notices } = detectExternalUpdates(previous, [claude("2.1.318")], new Set(), true);
    expect(notices[0]?.description.startsWith("This computer: ")).toBe(true);
  });

  it("leaves out an update BiBCode ran, a downgrade, an unchanged version and other drivers", () => {
    const previous = new Map([
      [`${environmentId}:claudeAgent`, "2.1.314"],
      [`${environmentId}:codex`, "0.166.0"],
    ]);
    const cases = [
      claude("2.1.318", { updatedByBiBCode: true }),
      claude("2.1.300"),
      claude("2.1.314"),
      claude(null),
      claude("0.167.0", { instanceId: "codex", driver: "codex", displayName: "Codex" }),
    ];
    for (const observation of cases) {
      expect(detectExternalUpdates(previous, [observation], new Set(), false).notices).toEqual([]);
    }
  });

  it("never repeats a notice for the same version", () => {
    const previous = new Map([[`${environmentId}:claudeAgent`, "2.1.314"]]);
    const first = detectExternalUpdates(previous, [claude("2.1.318")], new Set(), false);
    const announced = new Set(first.notices.map((notice) => notice.key));
    const again = detectExternalUpdates(previous, [claude("2.1.318")], announced, false);
    expect(again.notices).toEqual([]);
  });
});
