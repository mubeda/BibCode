import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detectExternalUpdates,
  type ProviderVersionObservation,
  type RememberedVersion,
} from "./externalUpdateNotice.logic";

const environmentId = EnvironmentId.make("environment-local");
const key = `${environmentId}:claudeAgent`;

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
  updateActive: false,
  updateFinishedAt: null,
  ...overrides,
});

const remembered = (
  version: string,
  updateFinishedAt: string | null = null,
): ReadonlyMap<string, RememberedVersion> => new Map([[key, { version, updateFinishedAt }]]);

describe("detectExternalUpdates", () => {
  it("says nothing the first time an instance is seen", () => {
    const { notices, next } = detectExternalUpdates(
      new Map(),
      [claude("2.1.314")],
      new Set(),
      false,
    );
    expect(notices).toEqual([]);
    expect(next.get(key)?.version).toBe("2.1.314");
  });

  it("announces a version that rose by itself, with what happens to running sessions", () => {
    const { notices } = detectExternalUpdates(
      remembered("2.1.314"),
      [claude("2.1.318")],
      new Set(),
      false,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Claude updated to 2.1.318");
    expect(notices[0]?.description).toContain("running sessions keep 2.1.314");
  });

  it("reads Claude's real version strings numerically, in both directions", () => {
    const up = detectExternalUpdates(
      remembered("2.1.99 (Claude Code)"),
      [claude("2.1.100 (Claude Code)")],
      new Set(),
      false,
    );
    expect(up.notices).toHaveLength(1);
    expect(up.notices[0]?.title).toBe("Claude updated to 2.1.100");
    expect(up.notices[0]?.description).toContain("running sessions keep 2.1.99 until");
    const down = detectExternalUpdates(
      remembered("2.1.100 (Claude Code)"),
      [claude("2.1.99 (Claude Code)")],
      new Set(),
      false,
    );
    expect(down.notices).toEqual([]);
  });

  it("names the environment only when there is more than one", () => {
    const { notices } = detectExternalUpdates(
      remembered("2.1.314"),
      [claude("2.1.318")],
      new Set(),
      true,
    );
    expect(notices[0]?.description.startsWith("This computer: ")).toBe(true);
  });

  it("leaves out a downgrade, an unchanged version, an unknown one and other drivers", () => {
    const previous = new Map([
      [key, { version: "2.1.314", updateFinishedAt: null }],
      [`${environmentId}:codex`, { version: "0.166.0", updateFinishedAt: null }],
    ]);
    const cases = [
      claude("2.1.300"),
      claude("2.1.314"),
      claude(null),
      claude("0.167.0", { instanceId: "codex", driver: "codex", displayName: "Codex" }),
    ];
    for (const observation of cases) {
      expect(detectExternalUpdates(previous, [observation], new Set(), false).notices).toEqual([]);
    }
  });

  it("leaves out the exact update BiBCode ran, but not a later automatic one", () => {
    // BiBCode's update finished in this snapshot, so the rise is its own.
    const own = detectExternalUpdates(
      remembered("2.1.314"),
      [claude("2.1.318", { updateFinishedAt: "2026-11-02T10:00:00.000Z" })],
      new Set(),
      false,
    );
    expect(own.notices).toEqual([]);
    // The same retained state, unchanged, does not explain the next rise.
    const later = detectExternalUpdates(
      own.next,
      [claude("2.1.320", { updateFinishedAt: "2026-11-02T10:00:00.000Z" })],
      new Set(),
      false,
    );
    expect(later.notices).toHaveLength(1);
    expect(later.notices[0]?.title).toBe("Claude updated to 2.1.320");
    // A running update explains a rise too.
    expect(
      detectExternalUpdates(
        remembered("2.1.314"),
        [claude("2.1.318", { updateActive: true })],
        new Set(),
        false,
      ).notices,
    ).toEqual([]);
  });

  it("never repeats a notice for the same version, including one dismissed earlier", () => {
    const first = detectExternalUpdates(
      remembered("2.1.314"),
      [claude("2.1.318")],
      new Set(),
      false,
    );
    const announced = new Set(first.notices.map((notice) => notice.key));
    expect(
      detectExternalUpdates(remembered("2.1.314"), [claude("2.1.318")], announced, false).notices,
    ).toEqual([]);
  });
});
