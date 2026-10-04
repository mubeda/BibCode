// @effect-diagnostics nodeBuiltinImport:off - Execute actual controller callsites against inert public/identity ports.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { createSettingsCaptureFailureObserver } from "../qualify-delivery-retry.ts";
import {
  projectSettingsVisualCapture,
  projectSettingsVisualAssertion,
} from "./release-visual-settings.ts";
const source = NodeFS.readFileSync(
  new URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
const facts = {
  "model-picker": [
    "singlePicker",
    "ownedReadyModel",
    "searchFocused",
    "favoriteControl",
    "draftRetained",
    "selectionRetained",
    "containedScroll",
  ],
  "settings-provider-form": [
    "nonSecretFieldsVisible",
    "ownedConfigOnly",
    "modelsVisible",
    "modelControlsVisible",
    "accountsRedacted",
  ],
  "settings-keybindings": [
    "filteredRow",
    "conditionEditor",
    "conditionFocused",
    "structuredCondition",
    "unsavedCancelableRow",
  ],
  "settings-source-control": [
    "gitAvailable",
    "gitVersionVisible",
    "hostingUnavailable",
    "availabilityReasons",
    "fetchIntervalVisible",
    "scanSettled",
  ],
};
const proof = {
  managedIdentityMatched: true,
  draftRetained: true,
  providerSelectionRetained: true,
  keybindingCancelled: true,
  noSettingsSaved: true,
  addProviderDialog: "unsupported-hidden-control",
  unpictured: [
    "add-provider-instance-dialog",
    "provider-ready-disabled-unavailable-overview",
    "provider-account-and-status-header",
    "model-effort-fast-mode-controls",
    "source-control-azure-bitbucket",
  ],
};
function wiring(failure?: string) {
  const begin = source.indexOf(
    '      } else if (config.selection === "release-visual-settings") {',
    source.indexOf("const proof = await runVisualCore"),
  );
  const end = source.indexOf("      } else {", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const captures: unknown[] = [],
    assertions: unknown[] = [],
    order: string[] = [];
  const snapshots: Array<{ captures: unknown[]; assertions: unknown[] }> = [];
  let selectedReads = 0;
  const identity = {
    path: "/private/managed",
    branch: "codex/delivery-retry-light",
    commonDirectory: "/private/project/.git",
  };
  const visualInput = {
    root: "/private/root",
    project: "/private/project",
    home: "/private/home",
    git: "/private/bin/git",
    branch: identity.branch,
  };
  const browser = {
    execute: async (_read: unknown, input: unknown) => {
      expect(input).toEqual({
        origin: "http://127.0.0.1:4885",
        branch: identity.branch,
        boundThreadId: "owned-thread",
      });
      order.push("public-selected");
      selectedReads++;
      return { threadId: failure === "selected" || selectedReads === 1 ? "other" : "owned-thread" };
    },
  };
  const owner = {
    until: async (read: () => Promise<boolean>) => {
      for (let index = 0; index < 2; index++) if (await read()) return;
      throw new Error("Owned public identity refused.");
    },
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function wire() {" +
        source.slice(
          begin + '      } else if (config.selection === "release-visual-settings") {'.length,
          end,
        ) +
        "}\nwire",
    ),
    {
      browser,
      owner,
      origin: "http://127.0.0.1:4885",
      theme: "light",
      workspace: { ...identity, threadId: "owned-thread" },
      visualInput,
      config: { evidence: "/owned-evidence" },
      capturedVisuals: new Set(),
      settingsCaptureFailures: new WeakMap(),
      createSettingsCaptureFailureObserver,
      captures,
      assertions,
      b: () => browser,
      step: () => {},
      type: async (value: string) => {
        expect(value).toBe("Owned visual review draft");
        order.push("draft");
      },
      check: (value: unknown) => {
        if (!value) throw new Error("Owned Git identity refused.");
      },
      readSelectedDeliveryWorktree: () => {},
      readOwnedDeliveryWorktree: (input: unknown) => {
        expect(input).toEqual(visualInput);
        order.push("private-git");
        return failure === "git" ? { ...identity, path: "/private/other" } : identity;
      },
      runVisualSettings: async (options: {
        verifyManaged: () => Promise<void>;
        capture: (scene: string) => Promise<void>;
      }) => {
        await options.verifyManaged();
        for (const scene of [
          "model-picker",
          "settings-keybindings",
          "settings-source-control",
          "settings-provider-form",
        ])
          await options.capture(scene);
        await options.verifyManaged();
        return failure === "assertion-extra" ? { ...proof, secret: "private-token" } : proof;
      },
      captureSettingsVisualScene: async (input: {
        scene: keyof typeof facts;
        theme: string;
        origin: string;
        threadId: string;
        branch: string;
        verifyOwnedIdentity: () => Promise<void>;
      }) => {
        expect(input).toMatchObject({
          theme: "light",
          origin: "http://127.0.0.1:4885",
          threadId: "owned-thread",
          branch: identity.branch,
        });
        await input.verifyOwnedIdentity();
        order.push("capture:" + input.scene);
        const capture = {
          scene: input.scene,
          theme: "light",
          file: input.scene + "-light.png",
          width: 1280,
          height: 960,
          nonBlank: true,
          sha256: "a".repeat(64),
          witness: Object.fromEntries(
            [
              "themeMatched",
              "selectedMatched",
              "expectedTextMatched",
              "targetInView",
              "credentialAbsent",
              "bootShellAbsent",
              ...facts[input.scene],
            ].map((key) => [key, true]),
          ),
        };
        return failure === "capture-extra" ? { ...capture, secret: "private-token" } : capture;
      },
      projectSettingsVisualCapture,
      projectSettingsVisualAssertion,
      write: (name: string, value: unknown) => {
        expect(name).toBe("assertions");
        expect(JSON.stringify(value)).not.toMatch(/private|owned-thread|4885/);
        order.push("write");
        snapshots.push(JSON.parse(JSON.stringify(value)));
      },
    },
  ) as () => Promise<void>;
  return { run, captures, assertions, order, snapshots };
}
describe("actual separate settings callsite", () => {
  it.each(["delivery-retry-ui", "release-visual-core", "release-visual-settings"])(
    "writes the original private configuration except for the explicitly selected settings preflight: %s",
    (selection) => {
      const begin = source.indexOf("      let settingsForWrite = configured;");
      const end = source.indexOf("      await new Promise<void>", begin);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const configured = { known: "original" },
        selected = { known: "settings" },
        calls: unknown[] = [],
        writes: unknown[] = [];
      const childEnv = { PATH: "/private/shims:/private/bin", HOME: "/private/home" };
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "function writeSettings() {" + source.slice(begin, end) + "}\nwriteSettings",
        ),
        {
          configured,
          selection,
          config: {
            selection,
            fixture: "/private",
            binary: "/private/binary",
            source: "a".repeat(40),
            evidence: "/private/evidence",
          },
          runRoot: "/private/light",
          theme: "light",
          context: { shimDirectory: "/private/shims", fixtureUserHomePath: "/private/home" },
          childEnv,
          settingsPath: "/private/settings.json",
          NodePath: { join: (...parts: string[]) => parts.join("/") },
          step: () => {},
          readSettingsVisualProviderConfiguration: (input: unknown) => {
            calls.push(input);
            return selected;
          },
          NodeFS: {
            writeFileSync: (path: string, bytes: string, options: unknown) =>
              writes.push({ path, value: JSON.parse(bytes), options }),
          },
        },
      );
      run();
      expect(writes).toEqual([
        {
          path: "/private/settings.json",
          value: selection === "release-visual-settings" ? selected : configured,
          options: { mode: 0o600 },
        },
      ]);
      if (selection === "release-visual-settings")
        expect(calls).toEqual([
          {
            fixtureRoot: "/private",
            runRoot: "/private/light",
            theme: "light",
            shimDirectory: "/private/shims",
            home: "/private/home",
            binDirectory: "/private/bin",
            childEnv,
            binary: "/private/binary",
            source: "a".repeat(40),
            evidence: "/private/evidence",
            configured,
          },
        ]);
      else expect(calls).toEqual([]);
      expect(configured).toEqual({ known: "original" });
    },
  );
  it("waits for the same public card before Git, uses the identity closure for every capture and exports only closed receipts", async () => {
    const f = wiring();
    await f.run();
    expect(f.order.slice(0, 4)).toEqual([
      "draft",
      "public-selected",
      "public-selected",
      "private-git",
    ]);
    expect(f.captures).toHaveLength(4);
    expect(f.assertions).toHaveLength(1);
    expect(f.snapshots.at(-1)?.captures).toHaveLength(4);
    expect(f.snapshots.at(-1)?.assertions).toHaveLength(1);
    expect(f.order.filter((value) => value.startsWith("capture:"))).toEqual([
      "capture:model-picker",
      "capture:settings-keybindings",
      "capture:settings-source-control",
      "capture:settings-provider-form",
    ]);
    expect(JSON.stringify([f.captures, f.assertions])).not.toMatch(/private|owned-thread|4885/);
  });
  it.each(["selected", "git", "capture-extra", "assertion-extra"])(
    "propagates %s refusal without publishing private or successful assertions",
    async (failure) => {
      const f = wiring(failure);
      await expect(f.run()).rejects.toThrow();
      expect(f.assertions).toEqual([]);
      expect(JSON.stringify(f.captures)).not.toContain("private-token");
      if (failure !== "assertion-extra") expect(f.captures).toEqual([]);
      if (failure === "selected") expect(f.order).not.toContain("private-git");
    },
  );
  it("runs the existing managed-worktree creator exactly once in the shared per-theme setup", async () => {
    const begin = source.indexOf(
      "      const workspace = await createOwnedWorkspace(context, runRoot);",
    );
    const end = source.indexOf('      if (config.selection === "release-visual-core") {', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    let creates = 0;
    const context = { projectPath: "/private/project", fixtureUserHomePath: "/private/home" };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function setup() {" +
          source.slice(begin, end) +
          "return { workspace, visualInput }; }\nsetup",
      ),
      {
        context,
        runRoot: "/private/root",
        config: { fixture: "/private" },
        NodePath: { join: (...parts: string[]) => parts.join("/") },
        createOwnedWorkspace: async (actual: unknown, root: string) => {
          expect(actual).toBe(context);
          expect(root).toBe("/private/root");
          creates++;
          return { branch: "codex/delivery-retry-light", threadId: "owned-thread" };
        },
      },
    );
    const result = await run();
    expect(creates).toBe(1);
    expect(result.visualInput.branch).toBe("codex/delivery-retry-light");
  });
});
