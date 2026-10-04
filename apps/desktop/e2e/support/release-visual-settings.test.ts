// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Inert DOM/driver ports and original synthetic PNGs only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  captureSettingsVisualScene,
  readSettingsVisualWitness,
  readSettingsAddProviderVisibility,
  runVisualSettings,
  validateSettingsVisualWitness,
  settingsVisualScreenshotName,
  projectSettingsVisualCapture,
  projectSettingsVisualAssertion,
  validateSettingsVisualJoins,
  type SettingsVisualCaptureInput,
  type SettingsVisualInput,
  type SettingsVisualObservationInput,
} from "./release-visual-settings.ts";

const observation: SettingsVisualObservationInput = {
  scene: "model-picker",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
};
function locationAt(path: string) {
  vi.stubGlobal("location", { origin: observation.origin, pathname: path, search: "", hash: "" });
}
function page(scene: SettingsVisualObservationInput["scene"]) {
  locationAt(
    scene === "model-picker"
      ? "/local/owned"
      : {
          "settings-keybindings": "/settings/keybindings",
          "settings-source-control": "/settings/source-control",
          "settings-provider-form": "/settings/providers",
        }[scene],
  );
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.className = "";
  const content = {
    "model-picker": `<button data-testid="thread-card-button-owned" aria-current="page" aria-describedby="owned-branch"></button><div id="owned-branch"><span data-slot="tooltip-trigger">codex/delivery-retry-light</span></div><div data-center-surface-host data-visible="true"><div data-testid="composer-editor">Owned visual review draft</div><button data-chat-provider-model-picker="true" aria-label="Claude · Opus 5"></button></div><div data-model-picker-content="true"><input placeholder="Search models..."><div class="model-picker-list"><div style="overscroll-behavior-y:contain"><div role="option" data-model-picker-instance-id="claudeAgent" data-model-picker-model-slug="opus" data-selected>Opus 5 Claude<button aria-label="Add to favorites"></button></div></div></div></div>`,
    "settings-keybindings": `<button data-slot="sidebar-menu-button" data-active="true">Keybindings</button><main data-slot="sidebar-inset"><section><h2>Keybindings</h2><input aria-label="Search keybindings" value="sidebar"><div aria-label="sidebar.toggle">Sidebar: Toggle</div><kbd>Ctrl</kbd><button aria-label="Cancel new keybinding"></button><button disabled>Save</button></section></main><div data-slot="popover-popup"><input aria-label="When expression" value="terminalFocus &amp;&amp; !terminalOpen"><button aria-label="Negate terminalFocus" aria-pressed="false"></button><button aria-label="Negate terminalOpen" aria-pressed="true"></button></div>`,
    "settings-provider-form": `<button data-slot="sidebar-menu-button" data-active="true">Providers</button><main data-slot="sidebar-inset"><section><h2>Providers</h2><input id="provider-instance-claudeAgent-binaryPath" value="claude"><input id="provider-instance-claudeAgent-homePath"><input id="provider-instance-claudeAgent-launchArgs"><div>Models Opus 5</div><input id="provider-instance-claudeAgent-custom-model"><button aria-label="Add Opus 5 to favorites"></button><button aria-label="Move Opus 5 up" disabled></button></section></main>`,
    "settings-source-control": `<button data-slot="sidebar-menu-button" data-active="true">Source Control</button><main data-slot="sidebar-inset"><section><h2>Version Control</h2><button aria-label="Toggle Git details" aria-expanded="true"></button><button aria-label="Git availability" role="switch" aria-checked="true" disabled></button><span>Git</span><code>git version 2.50.0</code><input aria-label="Automatic Git fetch interval in seconds" value="0"></section><section><h2>Source Control Providers</h2><div><span>GitHub</span><p>Not available on this server: Install GitHub CLI.</p><button role="switch" aria-label="GitHub availability" aria-checked="false" disabled></button></div><div><span>GitLab</span><p>Not available on this server: Install GitLab CLI.</p><button role="switch" aria-label="GitLab availability" aria-checked="false" disabled></button></div><button aria-label="Rescan server environment"></button></section><button aria-label="Enable pull requests" role="switch" aria-checked="true"></button></main>`,
  }[scene];
  document.body.innerHTML = `<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div>${content}`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 510,
    bottom: 610,
    width: 500,
    height: 600,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector(
      scene === "model-picker"
        ? '[data-model-picker-content="true"]'
        : scene === "settings-keybindings"
          ? '[data-slot="popover-popup"]'
          : '[data-slot="sidebar-inset"]',
    ),
  );
  document
    .querySelector<HTMLInputElement>(
      scene === "model-picker"
        ? 'input[placeholder="Search models..."]'
        : 'input[aria-label="When expression"]',
    )
    ?.focus();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("closed settings DOM witnesses", () => {
  it.each([
    "model-picker",
    "settings-keybindings",
    "settings-provider-form",
    "settings-source-control",
  ] as const)("admits only the actual visible %s state", (scene) => {
    page(scene);
    const proof = readSettingsVisualWitness({ ...observation, scene });
    expect(validateSettingsVisualWitness(scene, proof)).toMatchObject({
      themeMatched: true,
      credentialAbsent: true,
      expectedTextMatched: true,
      targetInView: true,
    });
    expect(JSON.stringify(proof)).not.toMatch(/4885|"owned"|claudeAgent|terminalFocus|2\.50/);
  });
  it.each([
    "secret",
    "hidden-secret",
    "duplicate",
    "wrong-route",
    "wrong-branch",
    "wrong-theme",
    "overlay",
    "disabled-instance",
    "changed-draft",
    "foreign-row",
    "lost-focus",
    "clipped-control",
    "uncontained-scroll",
  ])("refuses model capture after %s", (failure) => {
    page("model-picker");
    if (failure === "secret" || failure === "hidden-secret") {
      const field = document.createElement("input");
      field.type = "password";
      if (failure === "hidden-secret") field.style.display = "none";
      document.body.append(field);
    }
    if (failure === "duplicate")
      document.body.append(
        document.querySelector('[data-model-picker-content="true"]')!.cloneNode(true),
      );
    if (failure === "wrong-route") locationAt("/settings/agents");
    if (failure === "wrong-branch")
      document.querySelector('[data-slot="tooltip-trigger"]')!.textContent = "another-branch";
    if (failure === "wrong-theme") document.documentElement.classList.add("dark");
    if (failure === "overlay") vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    if (failure === "disabled-instance")
      document.querySelector('[role="option"]')!.setAttribute("aria-disabled", "true");
    if (failure === "changed-draft")
      document.querySelector('[data-testid="composer-editor"]')!.textContent = "Changed";
    if (failure === "foreign-row")
      document
        .querySelector('[role="option"]')!
        .setAttribute("data-model-picker-instance-id", "codex");
    if (failure === "lost-focus") document.querySelector<HTMLInputElement>("input")!.blur();
    if (failure === "uncontained-scroll")
      document.querySelector<HTMLElement>(".model-picker-list > div")!.style.overscrollBehaviorY =
        "auto";
    if (failure === "clipped-control") {
      const list = document.querySelector<HTMLElement>(".model-picker-list")!;
      list.style.overflowY = "hidden";
      Object.defineProperty(list, "getBoundingClientRect", {
        value: () => ({
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 510,
          bottom: 300,
          width: 500,
          height: 290,
          toJSON: () => ({}),
        }),
      });
    }
    expect(() =>
      validateSettingsVisualWitness("model-picker", readSettingsVisualWitness(observation)),
    ).toThrow();
  });
  it("refuses a private provider path, unredacted account and incomplete form", () => {
    for (const failure of ["path", "account", "field"]) {
      page("settings-provider-form");
      if (failure === "path")
        document.querySelector<HTMLInputElement>('input[id$="binaryPath"]')!.value =
          "/private/fixture/claude";
      if (failure === "account")
        document.body.insertAdjacentHTML(
          "beforeend",
          '<button aria-label="Toggle account email visibility">private@example.test</button>',
        );
      if (failure === "field") document.querySelector('input[id$="launchArgs"]')!.remove();
      expect(() =>
        validateSettingsVisualWitness(
          "settings-provider-form",
          readSettingsVisualWitness({ ...observation, scene: "settings-provider-form" }),
        ),
      ).toThrow();
      vi.restoreAllMocks();
    }
  });
  it.each(["auth", "pending"])(
    "refuses %s discovery without masking another failure",
    (failure) => {
      page("settings-source-control");
      if (failure === "auth")
        document
          .querySelector('[aria-label="GitHub availability"]')!
          .setAttribute("aria-checked", "true");
      if (failure === "pending")
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Rescan server environment"]',
        )!.disabled = true;
      const proof = readSettingsVisualWitness({ ...observation, scene: "settings-source-control" });
      if (failure === "pending")
        expect(proof).toEqual({
          themeMatched: true,
          selectedMatched: true,
          expectedTextMatched: false,
          targetInView: true,
          credentialAbsent: true,
          bootShellAbsent: true,
          gitAvailable: true,
          gitVersionVisible: true,
          hostingUnavailable: true,
          availabilityReasons: true,
          fetchIntervalVisible: true,
          scanSettled: false,
        });
      expect(() => validateSettingsVisualWitness("settings-source-control", proof)).toThrow();
    },
  );
  it("reports actual computed Add visibility, including a hidden-attribute CSS override", () => {
    page("settings-provider-form");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button aria-label="Add provider instance" hidden style="display:none!important"></button>',
    );
    expect(readSettingsAddProviderVisibility(observation)).toEqual({
      oneControl: true,
      visible: false,
      hidden: true,
      enabled: true,
    });
    document.querySelector<HTMLElement>('[aria-label="Add provider instance"]')!.style.display =
      "inline-flex";
    expect(readSettingsAddProviderVisibility(observation)).toMatchObject({
      hidden: true,
      visible: true,
    });
    locationAt("/settings/agents");
    expect(readSettingsAddProviderVisibility(observation)).toBeNull();
  });
  it("refuses extra witness fields and getter-shaped receipts", () => {
    page("model-picker");
    const proof = readSettingsVisualWitness(observation)!;
    expect(() =>
      validateSettingsVisualWitness("model-picker", { ...proof, private: "token" }),
    ).toThrow();
    const read = vi.fn(() => true);
    Object.defineProperty(proof, "themeMatched", { enumerable: true, get: read });
    expect(() => validateSettingsVisualWitness("model-picker", proof)).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(() => settingsVisualScreenshotName("../escape", "light")).toThrow();
    expect(() => settingsVisualScreenshotName("model-picker", "system")).toThrow();
  });
});

describe("closed settings artifact joins", () => {
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
  function capture(scene: SettingsVisualObservationInput["scene"], theme: "light" | "dark") {
    page(scene);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      const branch = document.querySelector('[data-slot="tooltip-trigger"]');
      if (branch) branch.textContent = "codex/delivery-retry-dark";
    }
    return {
      scene,
      theme,
      file: `${scene}-${theme}.png`,
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: "a".repeat(64),
      witness: readSettingsVisualWitness({
        ...observation,
        scene,
        theme,
        branch: `codex/delivery-retry-${theme}`,
      }),
    };
  }
  it("requires the exact eight named theme/scene joins and two closed assertions without expanding latent coverage", () => {
    const captures = (
      [
        "model-picker",
        "settings-provider-form",
        "settings-keybindings",
        "settings-source-control",
      ] as const
    ).flatMap((scene) => [capture(scene, "light"), capture(scene, "dark")]);
    const assertions = [
      projectSettingsVisualAssertion("light", proof),
      projectSettingsVisualAssertion("dark", proof),
    ];
    expect(() => validateSettingsVisualJoins(captures, assertions)).not.toThrow();
    expect(() => validateSettingsVisualJoins(captures.slice(1), assertions)).toThrow();
    expect(() =>
      validateSettingsVisualJoins([...captures.slice(1), captures[1]!], assertions),
    ).toThrow();
    expect(() => validateSettingsVisualJoins(captures, [assertions[0]!, assertions[0]!])).toThrow();
    expect(JSON.stringify(assertions)).not.toMatch(/owned-thread|4885|credential|private/);
  });
  it("refuses arbitrary capture fields, getter receipts and coerced coverage strings before they can reach the shared writer", () => {
    const valid = capture("model-picker", "light");
    expect(projectSettingsVisualCapture(valid)).toMatchObject({ file: "model-picker-light.png" });
    expect(() => projectSettingsVisualCapture({ ...valid, providerId: "private" })).toThrow();
    expect(() => projectSettingsVisualCapture({ ...valid, file: "../private.png" })).toThrow();
    expect(() => projectSettingsVisualCapture({ ...valid, sha256: "private" })).toThrow();
    const getter = vi.fn(() => "light");
    Object.defineProperty(valid, "theme", { get: getter, enumerable: true });
    expect(() => projectSettingsVisualCapture(valid)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => projectSettingsVisualAssertion("light", { ...proof, raw: "private" })).toThrow();
    expect(() =>
      projectSettingsVisualAssertion("light", {
        ...proof,
        addProviderDialog: { toString: () => "unsupported-hidden-control", secret: "private" },
      }),
    ).toThrow();
    expect(() => projectSettingsVisualAssertion("light", { ...proof, unpictured: [] })).toThrow();
  });
});

function png() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(NodeZlib.crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(3841 * 960);
  for (let y = 0; y < 960; y++) raw.fill(y % 256, y * 3841 + 1, (y + 1) * 3841);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
describe("original settings PNG boundary", () => {
  it.each([
    "ok",
    "before",
    "after",
    "alert",
    "driver",
    "identity",
    "after-identity",
    "existing-file",
  ])(
    "retains original bytes only after both complete witnesses and owned identity pass: %s",
    async (failure) => {
      page("model-picker");
      const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-visual-test-"));
      const original = png();
      let shots = 0;
      let checks = 0;
      const input = {
        ...observation,
        evidence,
        captured: new Set<string>(),
        owner: {
          until: async (check: () => Promise<boolean>) => {
            if (!(await check())) throw new Error("Owned observation timeout.");
          },
        },
        verifyOwnedIdentity: async () => {
          checks++;
          if (failure === "identity" || (failure === "after-identity" && checks === 2))
            throw new Error("Identity changed.");
        },
        browser: {
          isAlertOpen: async () => failure === "alert",
          execute: async (
            read: typeof readSettingsVisualWitness,
            args: SettingsVisualObservationInput,
          ) => read(args),
          takeScreenshot: async () => {
            shots++;
            if (failure === "driver") throw new Error("Driver refused.");
            if (failure === "after") locationAt("/local/foreign");
            return original.toString("base64");
          },
        },
      } as unknown as SettingsVisualCaptureInput;
      if (failure === "before")
        document.body.insertAdjacentHTML("beforeend", '<input type="password">');
      if (failure === "existing-file")
        NodeFS.writeFileSync(NodePath.join(evidence, "model-picker-light.png"), "owned original");
      try {
        if (failure === "ok") {
          const receipt = await captureSettingsVisualScene(input);
          expect(receipt).toMatchObject({
            file: "model-picker-light.png",
            width: 1280,
            height: 960,
            nonBlank: true,
          });
          expect(NodeFS.readFileSync(NodePath.join(evidence, "model-picker-light.png"))).toEqual(
            original,
          );
          expect(checks).toBe(2);
          await expect(captureSettingsVisualScene(input)).rejects.toThrow();
          expect(shots).toBe(1);
        } else {
          await expect(captureSettingsVisualScene(input)).rejects.toThrow();
          expect(input.captured.size).toBe(0);
          expect(NodeFS.readdirSync(evidence)).toEqual(
            failure === "existing-file" ? ["model-picker-light.png"] : [],
          );
          if (["before", "alert", "identity", "existing-file"].includes(failure))
            expect(shots).toBe(0);
          if (failure === "existing-file")
            expect(
              NodeFS.readFileSync(NodePath.join(evidence, "model-picker-light.png"), "utf8"),
            ).toBe("owned original");
        }
      } finally {
        NodeFS.rmSync(evidence, { recursive: true, force: true });
      }
    },
  );
});

function controller(failure?: string) {
  const actions: string[] = [];
  const captures: string[] = [];
  let route = "chat",
    popup = "",
    newBinding = false,
    details = false;
  const failed = new Error("Owned capture failed.");
  const element = (selector: string) => ({
    waitForDisplayed: async (options?: { reverse?: boolean }) => {
      if (options?.reverse && popup) throw new Error("Popup still open.");
    },
    waitForEnabled: async () => {},
    isDisplayed: async () => selector !== 'button[aria-label="Add provider instance"]',
    click: async () => {
      actions.push(selector);
      if (selector === '[data-testid="environment-rail-manage"]') route = "settings";
      if (selector === "button=Back") {
        route = "chat";
        popup = "";
        newBinding = false;
      }
      if (selector === "button=Providers") route = "providers";
      if (selector === "button=Keybindings") route = "keybindings";
      if (selector === "button=Source Control") route = "source-control";
      if (selector.includes("data-chat-provider-model-picker")) popup = "picker";
      if (selector.includes("Add keybinding")) newBinding = true;
      if (selector.includes("Cancel new keybinding")) newBinding = false;
      if (selector.includes("Edit when clause")) popup = "when";
      if (selector.includes("Toggle Claude details")) details = !details;
    },
    setValue: async (value: string) => {
      actions.push(selector + ":" + value);
    },
    scrollIntoView: async () => {
      actions.push("scroll:" + selector);
    },
    getText: async () =>
      failure === "draft" && route === "chat" && actions.includes("button=Back")
        ? "changed"
        : "Owned visual review draft",
    getAttribute: async () => "Claude · Opus 5",
  });
  const input = {
    browser: {
      $: element,
      $$: async () => [element("unique")],
      keys: async (key: string) => {
        actions.push("key:" + key);
        if (key === "Escape") popup = "";
      },
      execute: async (read: unknown) => {
        if (read === readSettingsAddProviderVisibility)
          return { oneControl: true, visible: false, hidden: true, enabled: true };
        return { x: 0, y: 0 };
      },
    },
    owner: {
      until: async (check: () => Promise<boolean>) => {
        if (!(await check())) throw new Error("Inert wait refused.");
      },
    },
    threadId: "owned",
    branch: observation.branch,
    origin: observation.origin,
    theme: observation.theme,
    step: (phase: string) => actions.push("phase:" + phase),
    verifyManaged: async () => {
      if (route !== "chat") throw new Error("Managed route lost.");
      actions.push("verify-managed");
    },
    verifyOwnedIdentity: async () => {
      actions.push("verify-identity");
    },
    capture: async (scene: string) => {
      if (scene === failure) throw failed;
      captures.push(scene);
    },
  } as unknown as SettingsVisualInput;
  return { input, actions, captures, failed, state: () => ({ route, popup, newBinding, details }) };
}
describe("fixed public settings controller", () => {
  it("uses public actions, cancels the new condition draft, returns to the same chat and labels hidden Add unpictured", async () => {
    const c = controller();
    const receipt = await runVisualSettings(c.input);
    expect(c.captures).toEqual([
      "model-picker",
      "settings-keybindings",
      "settings-source-control",
      "settings-provider-form",
    ]);
    expect(c.state()).toEqual({ route: "chat", popup: "", newBinding: false, details: false });
    expect(receipt).toMatchObject({
      draftRetained: true,
      providerSelectionRetained: true,
      keybindingCancelled: true,
      addProviderDialog: "unsupported-hidden-control",
    });
    expect(
      c.actions.indexOf('input[aria-label="When expression"]:terminalFocus && !terminalOpen'),
    ).toBeLessThan(c.actions.indexOf('button[aria-label="Cancel new keybinding"]'));
    expect(c.actions).not.toContain('button[aria-label="Add provider instance"]');
    expect(
      c.actions.some(
        (action) =>
          action.includes("Save") ||
          action.includes("availability") ||
          action.includes("Enable Claude"),
      ),
    ).toBe(false);
  });
  it.each([
    "model-picker",
    "settings-provider-form",
    "settings-keybindings",
    "settings-source-control",
  ])("cleans up public overlays/edits without replacing %s capture failure", async (scene) => {
    const c = controller(scene);
    await expect(runVisualSettings(c.input)).rejects.toBe(c.failed);
    expect(c.state()).toMatchObject({ route: "chat", popup: "", newBinding: false });
    expect(c.captures).not.toContain(scene);
  });
  it("refuses a changed retained draft after returning", async () => {
    const c = controller("draft");
    await expect(runVisualSettings(c.input)).rejects.toThrow("Visual settings draft changed.");
  });
});
