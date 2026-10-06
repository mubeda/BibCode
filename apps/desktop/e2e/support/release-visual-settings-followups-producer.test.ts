// @effect-diagnostics nodeBuiltinImport:off - Public action ports, decoded contracts and opaque socket observations only; no native execution or pixels.
import { expect, it } from "vite-plus/test";
import {
  runSettingsFollowupProducer,
  type SettingsFollowupProducerInput,
} from "./release-visual-settings-followups-producer.ts";
import {
  settingsSourceFixture,
  settingsUsageFixture,
  settingsDiagnosticsFixture,
} from "./release-visual-settings-followups-test-fixtures.ts";
import { settingsFollowupScenes } from "./release-visual-settings-followups.ts";
function fixture(mode = "owned") {
  const primary = settingsSourceFixture(),
    remote = settingsSourceFixture("remote"),
    diag = settingsDiagnosticsFixture();
  let route = "workspace",
    selected = "local",
    label = "Owned remote",
    field = label,
    popup = false,
    active = 1,
    accepted = 1,
    holding = false,
    removed = 0,
    restored = 0,
    unsafe = 0,
    afterFailure = false,
    delayedStage: number | null = null,
    readinessTicks = 0,
    socketClosed = false;
  const actions: string[] = [],
    captures: string[] = [];
  const readiness: Array<{ active: number; accepted: number; holding: boolean }> = [];
  const original = new Error("Inert original Settings capture refusal.");
  const api = (
    target: typeof primary,
    unavailable: boolean,
  ): SettingsFollowupProducerInput["primary"]["api"] => ({
    config: async () => target.config,
    snapshot: async () => target.snapshot,
    usage: async () => settingsUsageFixture(unavailable ? "unavailable" : "available"),
    refreshUsage: async () => settingsUsageFixture(unavailable ? "unavailable" : "available"),
    diagnostics: async () => (afterFailure ? diag.after : diag.before),
    processes: async () => diag.processes,
    requestOwnedReadFailure: async () => {
      afterFailure = true;
      return { ownedReadFailure: true, error: diag.error };
    },
  });
  const browser = {
    $$: () => ({ length: 1 }),
    $: (selector: string) => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      getText: async () => "Owned visual review draft",
      getValue: async () => field,
      getAttribute: async (name: string) => (name === "aria-label" ? label : null),
      isDisplayed: async () =>
        selector.includes("dialog-popup")
          ? popup
          : selector.includes("provider-usage-detail")
            ? usageOpen
            : true,
      isFocused: async () => !usageOpen,
      setValue: async (value: string) => {
        field = value;
      },
      click: async () => {
        actions.push(selector);
        if (selector.includes("environment-rail-manage")) route = "settings";
        if (
          selector.includes("button=Back") ||
          selector.includes("thread-card-button-") ||
          selector.includes("primary-card-button-")
        )
          route = "workspace";
        if (selector.includes("environment-rail-entry-")) selected = remote.target.environmentId;
        if (selector.includes("environment-rail-local")) selected = "local";
        if (selector.includes('role="menuitem"') && selector.includes("Rename")) {
          popup = true;
          field = label;
        }
        if (selector.endsWith("button=Save")) {
          label = field;
          popup = false;
        }
        if (selector.endsWith("button=Cancel")) popup = false;
        if (selector.includes("Disconnect") && !selector.includes("More actions")) active = 0;
        if (selector.includes('normalize-space()="Connect"')) {
          if (mode.startsWith("delayed-")) delayedStage = 0;
          else {
            active = 1;
            accepted++;
            holding = true;
          }
        }
        if (selector.includes('aria-label="Codex usage"')) usageOpen = true;
      },
    }),
    keys: async () => {
      usageOpen = false;
      popup = false;
    },
    execute: async (
      read: { name: string },
      input: { environmentId?: string; environmentLabel?: string },
    ) => {
      if (read.name === "scrollSettingsFollowupSection") return true;
      return {
        route,
        selectedMatched: selected === input.environmentId,
        labelMatched: input.environmentId === "local" || input.environmentLabel === label,
        credentialAbsent: true,
        bootShellAbsent: true,
      };
    },
  } as unknown as SettingsFollowupProducerInput["browser"];
  let usageOpen = false;
  const input: SettingsFollowupProducerInput = {
    browser,
    owner: {
      until: async (check) => {
        for (let tick = 0; tick < 5; tick++) {
          if (await check()) return;
          if (delayedStage !== null) {
            readiness.push({ active, accepted, holding });
            readinessTicks++;
            if (delayedStage === 0) active = 1;
            if (delayedStage === 1) accepted++;
            if (delayedStage === 2) {
              holding = true;
              if (mode === "delayed-foreign-generation") accepted++;
              if (mode === "delayed-closed") socketClosed = true;
              if (mode === "delayed-expired") {
                active = 0;
                holding = false;
              }
              delayedStage = null;
            } else delayedStage++;
          }
        }
        throw new Error("Inert expected state absent.");
      },
    },
    origin: "http://127.0.0.1:4885",
    theme: "light",
    primary: {
      target: primary.target,
      api: api(primary, false),
      readPhysical: async () => primary.physical,
    },
    remote: {
      target: remote.target,
      api: api(remote, true),
      readPhysical: async () => remote.physical,
    },
    originalRemoteLabel: label,
    nextRemoteLabel: "Owned renamed remote",
    ownedPrimaryServerPid: 1,
    ownedMissingPath: "/owned/missing",
    admitOwner: async () => {},
    socket: {
      observation: () => ({
        activeNoiseConnections: active,
        acceptedNoiseConnections: accepted,
        holding,
        heldBytes: holding ? 100 : 0,
        closed: socketClosed,
      }),
      armNextConfiguration: async () => {
        expect(active).toBe(0);
      },
      verifyHolding: async () => {
        if (mode === "delayed-expired") throw original;
        if (!holding) throw new Error("Inert hold absent.");
        if (mode === "delayed-original-error") throw original;
      },
      release: async () => {
        if (mode === "delayed-original-error") throw new Error("Inert secondary release refusal.");
        holding = false;
      },
      close: async () => {
        active = 0;
      },
    },
    capture: async (observation, verify) => {
      await verify();
      captures.push(observation.scene);
      if (mode === "capture-failure" && observation.scene === "remote-rename-applied")
        throw original;
      if (mode === "reconnect-on-rename" && observation.scene === "remote-rename") accepted++;
      await verify();
    },
    removeOwnedRemoteRegistration: async () => {
      removed++;
      if (mode === "cleanup-failure") throw original;
      active = 0;
    },
    verifyOriginalRestored: async () => {
      restored++;
      expect(selected).toBe("local");
    },
    observeUnsafeCleanup: () => {
      unsafe++;
    },
    step: () => {},
  };
  return {
    input,
    captures,
    actions,
    original,
    removed: () => removed,
    restored: () => restored,
    unsafe: () => unsafe,
    label: () => label,
    holding: () => holding,
    readiness,
    readinessTicks: () => readinessTicks,
  };
}
it("runs all nine approved scenes through actual producer actions and source joins before restoring the owned context", async () => {
  const f = fixture();
  const result = await runSettingsFollowupProducer(f.input);
  expect(f.captures).toEqual(settingsFollowupScenes);
  expect(f.actions.some((value) => value.includes("View diagnostics"))).toBe(true);
  expect(f.actions.some((value) => value.includes("Rename"))).toBe(true);
  expect(f.label()).toBe("Owned remote");
  expect(f.removed()).toBe(1);
  expect(f.restored()).toBe(1);
  expect(f.holding()).toBe(false);
  expect(f.unsafe()).toBe(0);
  expect(result).toMatchObject({
    completeGroup: false,
    sourceIdentityRetained: true,
    originalContextRestored: true,
  });
});
it("waits for asynchronous original handshake, authenticated upgrade and held application records before receiving capture", async () => {
  const f = fixture("delayed-hold");
  await expect(runSettingsFollowupProducer(f.input)).resolves.toMatchObject({
    completeGroup: false,
  });
  expect(f.readinessTicks()).toBe(3);
  expect(f.readiness).toEqual([
    { active: 0, accepted: 1, holding: false },
    { active: 1, accepted: 1, holding: false },
    { active: 1, accepted: 2, holding: false },
  ]);
  expect(f.captures).toEqual(settingsFollowupScenes);
  expect(f.holding()).toBe(false);
  expect(f.unsafe()).toBe(0);
});
it("preserves the original strict held-scope error after delayed readiness and makes failed release cleanup unsafe", async () => {
  const f = fixture("delayed-original-error");
  await expect(runSettingsFollowupProducer(f.input)).rejects.toBe(f.original);
  expect(f.readinessTicks()).toBe(3);
  expect(f.captures).not.toContain("receiving-settings-row");
  expect(f.removed()).toBe(1);
  expect(f.restored()).toBe(1);
  expect(f.unsafe()).toBe(1);
});
it.each(["delayed-foreign-generation", "delayed-closed"])(
  "refuses %s readiness before admitting any receiving capture",
  async (mode) => {
    const f = fixture(mode);
    await expect(runSettingsFollowupProducer(f.input)).rejects.toThrow();
    expect(f.readinessTicks()).toBe(3);
    expect(f.captures).not.toContain("receiving-settings-row");
    expect(f.removed()).toBe(1);
    expect(f.restored()).toBe(1);
  },
);
it("retains the expired returning socket's original failure instead of waiting for a vanished upgraded peer", async () => {
  const f = fixture("delayed-expired");
  await expect(runSettingsFollowupProducer(f.input)).rejects.toBe(f.original);
  expect(f.readinessTicks()).toBe(3);
  expect(f.captures).not.toContain("receiving-settings-row");
  expect(f.removed()).toBe(1);
  expect(f.restored()).toBe(1);
});
it("preserves the original capture exception while completing alias, registration and selected-context cleanup", async () => {
  const f = fixture("capture-failure");
  await expect(runSettingsFollowupProducer(f.input)).rejects.toBe(f.original);
  expect(f.label()).toBe("Owned remote");
  expect(f.removed()).toBe(1);
  expect(f.restored()).toBe(1);
  expect(f.unsafe()).toBe(0);
});
it("rejects a replaced Noise generation during rename and does not admit applied or receiving captures", async () => {
  const f = fixture("reconnect-on-rename");
  await expect(runSettingsFollowupProducer(f.input)).rejects.toThrow();
  expect(f.captures).not.toContain("remote-rename-applied");
  expect(f.removed()).toBe(1);
  expect(f.restored()).toBe(1);
});
it("makes failed owned registration cleanup fatal and marks the fixture unsafe to delete", async () => {
  const f = fixture("cleanup-failure");
  await expect(runSettingsFollowupProducer(f.input)).rejects.toThrow();
  expect(f.unsafe()).toBe(1);
  expect(f.restored()).toBe(1);
});
