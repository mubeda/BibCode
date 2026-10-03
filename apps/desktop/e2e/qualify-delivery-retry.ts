// @effect-diagnostics nodeBuiltinImport:off - Disposable CI browser qualifier owns fixture paths.
// @effect-diagnostics globalFetch:off - Only the owned loopback CLI is probed.
// @effect-diagnostics globalTimers:off - Real bounded negative observation windows.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import {
  QualificationOwner,
  bounded,
  delay,
  openOwnedBrowser,
  prepareOwnedNetwork,
  verifyOwnedBrowserOnline,
  type QualificationBrowser,
} from "./support/qualification-owner.ts";
import { prepareDesktopUiTestContext } from "./support/test-project.ts";
import {
  classifyQualificationFailure,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";
import { inspectScreenshot, validateCaptureWitness } from "./support/remote-ui-evidence.ts";
import {
  deliveryThemes,
  deliveryScenes,
  newConversationNotice,
  readDeliveryReceipts,
  verifyFreshRetry,
  withUnavailableWorkspace,
  type DeliveryTheme,
  type DeliveryScene,
  type DeliveryReceipts,
} from "./support/delivery-retry-evidence.ts";
import { resolveActualRetryPrompt } from "./support/delivery-retry-flow.ts";
import {
  readOwnedDeliveryWorktree,
  readSelectedDeliveryWorktree,
} from "./support/delivery-retry-workspace.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const origin = "http://127.0.0.1:4885";
const surface = '[data-center-surface-host][data-visible="true"]';
const composer = `${surface} [data-testid="composer-editor"]`;
const form = `${surface} [data-chat-composer-form="true"]`;

export function deliveryConfiguration(
  environment: NodeJS.ProcessEnv,
  readNamespace = () => NodeFS.readlinkSync("/proc/self/ns/net"),
) {
  const values = {
    fixture: environment.BIBCODE_UPLOAD_FIXTURE,
    evidence: environment.BIBCODE_UPLOAD_EVIDENCE,
    binary: environment.BIBCODE_UPLOAD_SERVER,
    assets: environment.BIBCODE_DELIVERY_UI_WEB,
    chrome: environment.BIBCODE_UPLOAD_CHROME,
    driver: environment.BIBCODE_UPLOAD_DRIVER,
  };
  if (
    environment.CI !== "true" ||
    !/^[0-9a-f]{40}$/.test(environment.BIBCODE_UPLOAD_SOURCE ?? "") ||
    Object.values(values).some((value) => !value || !NodePath.isAbsolute(value)) ||
    !environment.BIBCODE_UPLOAD_NETNS
  )
    throw new Error("Owned delivery qualification configuration refused.");
  try {
    if (readNamespace() !== environment.BIBCODE_UPLOAD_NETNS) throw new Error();
  } catch {
    throw new Error("Owned delivery qualification namespace refused.");
  }
  return { ...values, source: environment.BIBCODE_UPLOAD_SOURCE! } as {
    fixture: string;
    evidence: string;
    binary: string;
    assets: string;
    chrome: string;
    driver: string;
    source: string;
  };
}

/** Sampled DOM facts only; never a substitute for a completed WebDriver command. */
export function projectDeliveryWorktreeObservation(input: unknown) {
  const value =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const rawSafeLocation = value.safeLocation;
  const safeLocation = typeof rawSafeLocation === "boolean" ? rawSafeLocation : null;
  const source = safeLocation === true ? value : {};
  const boolean = (key: string): boolean | null => {
    const field = source[key];
    return typeof field === "boolean" ? field : null;
  };
  const count = source.createCount;
  return {
    safeLocation,
    createCount:
      typeof count === "string" && ["none", "one", "multiple"].includes(count) ? count : null,
    headerHovered: boolean("headerHovered"),
    headerVisible: boolean("headerVisible"),
    headerHitTarget: boolean("headerHitTarget"),
    createVisible: boolean("createVisible"),
    createEnabled: boolean("createEnabled"),
    createHitTarget: boolean("createHitTarget"),
    dialogVisible: boolean("dialogVisible"),
    modelPickerVisible: boolean("modelPickerVisible"),
  };
}

/** Failure attribution only: closed facts, never page values or driver payloads. */
export function projectDeliveryStartupObservation(input: unknown) {
  const value =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const safeLocation = typeof value.safeLocation === "boolean" ? value.safeLocation : null;
  const source = safeLocation === true ? value : {};
  const boolean = (key: string): boolean | null =>
    typeof source[key] === "boolean" ? source[key] : null;
  return {
    safeLocation,
    route:
      typeof source.route === "string" &&
      [
        "pair",
        "root",
        "workspace",
        "settings-general",
        "settings-remote-servers",
        "other",
      ].includes(source.route)
        ? source.route
        : null,
    readyState:
      typeof source.readyState === "string" &&
      ["loading", "interactive", "complete"].includes(source.readyState)
        ? source.readyState
        : null,
    online: boolean("online"),
    tokenInputPresent: boolean("tokenInputPresent"),
    tokenInputDisabled: boolean("tokenInputDisabled"),
    submitPresent: boolean("submitPresent"),
    submitDisabled: boolean("submitDisabled"),
    pairingErrorPresent: boolean("pairingErrorPresent"),
    pendingHeadingPresent: boolean("pendingHeadingPresent"),
    sidebarPresent: boolean("sidebarPresent"),
    primaryConnected: boolean("primaryConnected"),
    themeControlPresent: boolean("themeControlPresent"),
    darkTheme: boolean("darkTheme"),
  };
}

export async function runDeliveryRetryQualification() {
  const config = deliveryConfiguration(process.env);
  const owner = new QualificationOwner(root, config.fixture);
  let browser: QualificationBrowser | undefined;
  let phase = "prepare-network";
  let theme: DeliveryTheme = "light";
  let success = false;
  const assertions: object[] = [];
  const captures: object[] = [];
  const networkProofs: object[] = [];
  const write = (name: string, value: unknown) =>
    NodeFS.writeFileSync(
      NodePath.join(config.evidence, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  const step = (name: string) => {
    phase = name;
    write("phase", { phase, theme });
  };
  const check = (value: unknown) => {
    if (!value) throw new Error("Owned delivery qualification assertion failed.");
  };
  const b = () => {
    if (!browser) throw new Error("Owned browser unavailable.");
    return browser;
  };
  const click = async (selector: string) => {
    const button = b().$(selector);
    await button.waitForDisplayed();
    await button.waitForEnabled();
    await button.click();
  };
  const row = (id: string) => {
    check(/^[A-Za-z0-9._:-]{1,128}$/.test(id));
    return `${surface} [data-message-id="${id}"]`;
  };
  const readMessage = async (prompt: string) =>
    b().execute((input) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-center-surface-host][data-visible="true"] [data-message-role="user"]',
        ),
      );
      const matches = rows.filter(
        (entry) =>
          entry.querySelector('[data-user-message-body="true"]')?.textContent?.trim() === input,
      );
      if (matches.length !== 1) return null;
      return {
        id: matches[0]!.dataset.messageId ?? "",
        text: matches[0]!.querySelector('[data-user-message-body="true"]')!.textContent!.trim(),
      };
    }, prompt);
  const draftIs = async (draft: string) => (await b().$(composer).getText()).trim() === draft;
  const unchanged = (before: DeliveryReceipts, after: DeliveryReceipts) =>
    check(after.complete && JSON.stringify(after.entries) === JSON.stringify(before.entries));

  async function readStartupFailureObservation() {
    try {
      return projectDeliveryStartupObservation(
        await bounded(
          browser!.execute((expectedOrigin) => {
            if (
              location.origin !== expectedOrigin ||
              location.search !== "" ||
              location.hash !== ""
            )
              return { safeLocation: false };
            const token = document.querySelector("#pairing-token");
            const pairingForm = token instanceof HTMLInputElement ? token.form : null;
            const submit = pairingForm?.querySelector('button[type="submit"]');
            return {
              safeLocation: true,
              route:
                location.pathname === "/pair"
                  ? "pair"
                  : location.pathname === "/"
                    ? "root"
                    : location.pathname === "/settings/general"
                      ? "settings-general"
                      : location.pathname === "/settings/remote-servers"
                        ? "settings-remote-servers"
                        : location.pathname.startsWith("/local/")
                          ? "workspace"
                          : "other",
              readyState: document.readyState,
              online: navigator.onLine,
              tokenInputPresent: token instanceof HTMLInputElement,
              tokenInputDisabled: token instanceof HTMLInputElement ? token.disabled : null,
              submitPresent: submit instanceof HTMLButtonElement,
              submitDisabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
              pairingErrorPresent: pairingForm?.querySelector(".text-destructive") != null,
              pendingHeadingPresent:
                document.querySelector("h1")?.textContent?.trim() ===
                "Pairing with this environment",
              sidebarPresent:
                document.querySelector('[data-testid="sidebar-add-project-trigger"]') !== null,
              primaryConnected:
                document.querySelector(
                  '[data-testid="environment-rail-local"] [data-status="connected"]',
                ) !== null,
              themeControlPresent:
                document.querySelector('[aria-label="Theme preference"]') !== null,
              darkTheme: document.documentElement.classList.contains("dark"),
            };
          }, origin),
          2000,
        ),
      );
    } catch {
      // Unavailable diagnostics stay unknown; original failure and owned cleanup still run.
      return null;
    }
  }

  async function readWorktreeFailureObservation() {
    try {
      return projectDeliveryWorktreeObservation(
        await bounded(
          browser!.execute((expectedOrigin) => {
            if (
              location.origin !== expectedOrigin ||
              location.search !== "" ||
              location.hash !== ""
            )
              return { safeLocation: false };
            const controls = document.querySelectorAll('button[aria-label^="New worktree in "]');
            const create = controls.length === 1 ? controls[0]! : null;
            const header = create?.closest('div[class~="group/project-header"]') ?? null;
            const visible = (element: Element | null): boolean | null =>
              element && typeof element.checkVisibility === "function"
                ? element.checkVisibility({
                    contentVisibilityAuto: true,
                    opacityProperty: true,
                    visibilityProperty: true,
                  })
                : null;
            const hitTarget = (element: Element | null): boolean | null => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return hit !== null && (hit === element || element.contains(hit));
            };
            const anyVisible = (selector: string): boolean | null => {
              const observations = new Set(
                Array.from(document.querySelectorAll(selector), visible),
              );
              return observations.has(true) ? true : observations.has(null) ? null : false;
            };
            return {
              safeLocation: true,
              createCount:
                controls.length === 0 ? "none" : controls.length === 1 ? "one" : "multiple",
              headerHovered: header?.matches(":hover") ?? null,
              headerVisible: visible(header),
              headerHitTarget: hitTarget(header),
              createVisible: visible(create),
              createEnabled: create instanceof HTMLButtonElement ? !create.disabled : null,
              createHitTarget: hitTarget(create),
              dialogVisible: anyVisible('[data-slot="dialog-popup"][role="dialog"]'),
              modelPickerVisible: anyVisible('[data-model-picker-content="true"]'),
            };
          }, origin),
          2000,
        ),
      );
    } catch {
      // The original failure survives unavailable/late diagnostics and owns cleanup.
      return null;
    }
  }

  async function setTheme() {
    step("theme-open-settings");
    await click('[data-testid="environment-rail-manage"]');
    step("theme-open-general");
    await click("button=General");
    step("theme-open-preference");
    await click('[aria-label="Theme preference"]');
    step("theme-select");
    await click(
      `//*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`,
    );
    step("theme-wait-applied");
    await owner.until(async () =>
      b().execute(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      ),
    );
    step("theme-open-remote-servers");
    await click("button=Remote Servers");
    step("theme-back");
    await click("button=Back");
  }

  async function importProject(project: string) {
    step("import-open-project-menu");
    await click('[data-testid="sidebar-add-project-trigger"]');
    step("import-browse-folder");
    await click(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    step("import-path-choice");
    await owner.until(
      async () =>
        (await b().$("#add-project-host-path").isDisplayed()) ||
        (await b().$("button=Type a path instead").isDisplayed()),
    );
    if (!(await b().$("#add-project-host-path").isExisting())) {
      step("import-type-path");
      await click("button=Type a path instead");
    }
    step("import-path-ready");
    await b().$("#add-project-host-path").waitForDisplayed();
    step("import-fill-path");
    await b().$("#add-project-host-path").setValue(project);
    step("import-submit-project");
    await click("button=Open project");
    step("import-wait-composer");
    await b().$(composer).waitForDisplayed();
    await selectClaudeModel("import");
  }

  async function selectClaudeModel(scope: "import" | "worktree") {
    step(`${scope}-open-model-picker`);
    await click(`${form} [data-chat-provider-model-picker="true"]`);
    const model =
      '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]';
    step(`${scope}-select-claude-opus`);
    await click(model);
    step(`${scope}-verify-claude-opus`);
    // The visible trigger text is model-only; its accessible label includes the
    // actual selected provider and full model name from the owned Claude fixture.
    await owner.until(
      async () =>
        (await b()
          .$(`${form} [data-chat-provider-model-picker="true"]`)
          .getAttribute("aria-label")) === "Claude · Opus 5",
    );
  }

  async function createOwnedWorkspace(
    context: ReturnType<typeof prepareDesktopUiTestContext>,
    runRoot: string,
  ) {
    const branch = `codex/delivery-retry-${theme}`;
    const create = 'button[aria-label^="New worktree in "]';
    const popup = '[data-slot="dialog-popup"][role="dialog"]';
    step("worktree-open-count");
    check((await b().$$(create).length) === 1);
    const createButton = b().$(create);
    step("worktree-open-focus");
    // The existing focus-within action strip does not depend on hover capability.
    await owner.until(async () => {
      if (await createButton.isFocused()) return true;
      await b().keys("Tab");
      return createButton.isFocused();
    });
    step("worktree-open-displayed");
    await createButton.waitForDisplayed();
    step("worktree-open-enabled");
    await createButton.waitForEnabled();
    step("worktree-open-focus-confirm");
    check((await b().$$(create).length) === 1 && (await createButton.isFocused()));
    step("worktree-open-enter");
    await b().keys("Enter");
    step("worktree-name");
    const name = b().$(`${popup} input[placeholder="Worktree name"]`);
    await name.waitForDisplayed();
    // Keep the title distinct so the actual card retains its branch/path hint.
    await name.setValue(branch.replaceAll("-", " "));
    step("worktree-create");
    await click(
      '//*[@data-slot="dialog-popup"]//button[starts-with(normalize-space(.),"Create worktree")]',
    );
    await b().$(popup).waitForDisplayed({ reverse: true });
    step("worktree-select-identity");
    let selected: { threadId: string } | null = null;
    await owner.until(async () => {
      selected = await b().execute(readSelectedDeliveryWorktree, {
        origin,
        branch,
        boundThreadId: null,
      });
      return selected !== null;
    });
    check(selected !== null);
    const threadId = (selected as { threadId: string } | null)!.threadId;
    step("worktree-git-identity");
    const identity = readOwnedDeliveryWorktree({
      root: runRoot,
      project: context.projectPath,
      home: context.fixtureUserHomePath,
      git: NodePath.join(config.fixture, "bin", "git"),
      branch,
    });
    step("worktree-visible-path");
    await b()
      .$(`[data-testid="thread-row-${threadId}"] [id$="-branch"] [data-slot="tooltip-trigger"]`)
      .moveTo();
    await owner.until(async () =>
      b().execute(
        (expected) =>
          Array.from(document.querySelectorAll('[data-slot="tooltip-popup"]')).some(
            (element) =>
              element.getClientRects().length > 0 && element.textContent?.trim() === expected,
          ),
        `Worktree: ${NodePath.basename(identity.path)} (${branch})`,
      ),
    );
    await selectClaudeModel("worktree");
    step("worktree-ready");
    check(
      (await b().execute(readSelectedDeliveryWorktree, { origin, branch, boundThreadId: threadId }))
        ?.threadId === threadId,
    );
    return { ...identity, threadId };
  }

  async function type(text: string) {
    check((await b().$(composer).getText()).trim() === "");
    await b().$(composer).click();
    await b().keys(text);
    check(await draftIs(text));
  }
  async function send(text: string) {
    await type(text);
    await click(`${form} button[aria-label="Send message"]`);
    await owner.until(async () => (await b().$(composer).getText()).trim() === "");
  }

  async function capture(scene: DeliveryScene, id: string, prompt: string, draft: string) {
    check(!(await b().isAlertOpen()));
    const selector = row(id);
    const expected = scene === "new-conversation" ? newConversationNotice : "Delivery uncertain";
    await b().$(selector).scrollIntoView({ block: "center" });
    await b().performActions([
      {
        type: "pointer",
        id: "delivery-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1, origin: "viewport" }],
      },
    ]);
    let witness: unknown;
    await owner.until(async () => {
      witness = await bounded(
        b().execute(
          (input) => {
            const target = document.querySelector<HTMLElement>(input.selector);
            const rect = target?.getBoundingClientRect();
            const visible = (element: Element) => {
              const box = element.getBoundingClientRect();
              return (
                box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden"
              );
            };
            const cleanOverlays = Array.from(
              document.querySelectorAll(
                '[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]',
              ),
            ).every((element) => !visible(element));
            const unobstructed =
              !!target &&
              !!rect &&
              [
                [rect.x + rect.width / 2, rect.y + 2],
                [rect.x + rect.width / 2, rect.y + rect.height / 2],
                [rect.x + rect.width / 2, rect.bottom - 2],
              ].every(([x, y]) => {
                const hit = document.elementFromPoint(x!, y!);
                return !!hit && (hit === target || target.contains(hit));
              });
            const notice = target?.querySelector<HTMLElement>('[role="status"]');
            return {
              themeMatched:
                document.documentElement.classList.contains("dark") === (input.theme === "dark"),
              selectedMatched:
                document
                  .querySelector('[data-testid="environment-rail-local"]')
                  ?.getAttribute("aria-checked") === "true" &&
                target?.querySelector('[data-user-message-body="true"]')?.textContent?.trim() ===
                  input.prompt &&
                document.querySelector(input.composer)?.textContent?.trim() === input.draft,
              expectedTextMatched:
                target?.textContent?.includes(input.expected) === true &&
                (input.scene !== "new-conversation" ||
                  (notice?.classList.contains("text-muted-foreground") === true &&
                    parseFloat(getComputedStyle(notice).fontSize) >= 12)),
              targetInView:
                !!target &&
                !!rect &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.x >= 0 &&
                rect.y >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight &&
                unobstructed &&
                cleanOverlays,
              credentialAbsent:
                location.origin === input.origin &&
                location.search === "" &&
                location.hash === "" &&
                document.querySelector(
                  '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
                ) === null,
              bootShellAbsent:
                document.getElementById("boot-shell") === null &&
                document.querySelector("vite-error-overlay") === null,
            };
          },
          { selector, theme, scene, expected, prompt, draft, composer, origin },
        ),
        2000,
      );
      try {
        validateCaptureWitness(witness);
        return true;
      } catch {
        return false;
      }
    });
    const proof = validateCaptureWitness(witness);
    const bytes = Buffer.from(await bounded(b().takeScreenshot(), 5000), "base64");
    const image = inspectScreenshot(bytes);
    const file = `${scene}-${theme}.png`;
    NodeFS.writeFileSync(NodePath.join(config.evidence, file), bytes, { mode: 0o600, flag: "wx" });
    captures.push({ scene, theme, file, ...proof, ...image });
    write("assertions", { captures, assertions });
  }

  try {
    const network = await prepareOwnedNetwork(root);
    for (const nextTheme of deliveryThemes) {
      theme = nextTheme;
      step("prepare-fixture");
      const runRoot = NodePath.join(config.fixture, theme);
      const env = {
        ...process.env,
        BIBCODE_E2E_RUN_ROOT: runRoot,
        BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(runRoot, "private"),
        BIBCODE_E2E_PLATFORM: "linux",
      };
      const context = prepareDesktopUiTestContext(env);
      const control = NodePath.join(runRoot, "delivery-retry");
      NodeFS.mkdirSync(control, { mode: 0o700 });
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        BIBCODE_E2E_CLAUDE_RETRY: "1",
        PATH: context.shimDirectory + NodePath.delimiter + NodePath.join(config.fixture, "bin"),
        CLAUDE_CONFIG_DIR: NodePath.join(context.fixtureUserHomePath, ".claude"),
        RUST_LOG: "warn",
        BIBCODE_LOG: "warn",
      };
      delete childEnv.BIBCODE_HERMETIC_GUARD;
      const settingsPath = NodePath.join(context.stateRoot, "userdata", "settings.json");
      const configured = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
      const missing = NodePath.join(runRoot, "missing-provider");
      for (const entry of Object.values(configured.providers) as Record<string, unknown>[]) {
        entry.enabled = false;
        entry.binaryPath = missing;
      }
      for (const entry of Object.values(configured.providerInstances ?? {}) as Record<
        string,
        unknown
      >[]) {
        entry.enabled = false;
        entry.config = { binaryPath: missing };
        entry.environment = [];
      }
      const claude = NodePath.join(context.shimDirectory, "claude");
      configured.providers.claudeAgent = { enabled: true, binaryPath: claude };
      configured.providerInstances.claudeAgent = {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: claude },
      };
      configured.enableProviderUpdateChecks = false;
      configured.worktreeBaseDirectory = NodePath.join(runRoot, "managed-worktrees");
      NodeFS.mkdirSync(configured.worktreeBaseDirectory, { mode: 0o700 });
      NodeFS.writeFileSync(settingsPath, JSON.stringify(configured), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const probe = NodeNet.createServer();
        probe.once("error", () => reject(new Error("Owned delivery port unavailable.")));
        probe.listen(4885, "127.0.0.1", () =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      });
      const server = owner.spawn(
        config.binary,
        [
          "serve",
          "--mode",
          "web",
          "--host",
          "127.0.0.1",
          "--port",
          "4885",
          "--base-dir",
          context.stateRoot,
          "--static-dir",
          config.assets,
          "--no-browser",
          "--no-startup-pairing-offer",
        ],
        childEnv,
        "primary",
      );
      await owner.until(async () => {
        try {
          return (
            await fetch(origin + "/.well-known/bibcode/environment", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      });
      step("browser");
      const opened = await openOwnedBrowser(
        owner,
        config.chrome,
        config.driver,
        origin,
        NodePath.join(runRoot, "profile"),
      );
      browser = opened.browser;
      networkProofs.push(await verifyOwnedBrowserOnline(browser, network));
      step("pair-issue-credential");
      const grant = await owner.json(
        config.binary,
        ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
        childEnv,
      );
      step("pair-check-credential");
      const credential =
        typeof grant === "object" && grant !== null && "credential" in grant
          ? grant.credential
          : null;
      if (typeof credential !== "string" || credential.length < 8)
        throw new Error("Owned pairing credential unavailable.");
      step("pair-navigate");
      await browser.url(origin + "/pair");
      step("pair-wait-token");
      await browser.$("#pairing-token").waitForDisplayed();
      step("pair-fill-token");
      await browser.$("#pairing-token").setValue(credential);
      step("pair-submit");
      await click("button=Continue");
      step("pair-wait-sidebar");
      await browser.$('[data-testid="sidebar-add-project-trigger"]').waitForDisplayed();
      step("pair-wait-connected");
      await browser
        .$('[data-testid="environment-rail-local"] [data-status="connected"]')
        .waitForDisplayed();
      await setTheme();
      step("import");
      await importProject(context.projectPath);
      const workspace = await createOwnedWorkspace(context, runRoot);
      const baseline = `delivery baseline ${theme}`;
      const prompt = `delivery held message ${theme}`;
      const draft = `delivery preserved draft ${theme}`;
      step("baseline");
      await send(baseline);
      await owner.until(
        async () =>
          (await browser!.$(surface).getText()).includes(
            "BiBCode deterministic streamed fixture response.",
          ) &&
          !(await browser!.$(`${form} button[aria-label="Stop generation"]`).isDisplayed()) &&
          !(await browser!.$(`${surface} [data-timeline-row-kind="working"]`).isDisplayed()),
      );
      await browser.$(`${form} button[aria-label="Send message"]`).waitForDisplayed();
      check(!(await browser.$(surface).getText()).includes(newConversationNotice));
      step("hold-input");
      NodeFS.writeFileSync(NodePath.join(control, "withhold-next"), "hold", {
        mode: 0o600,
        flag: "wx",
      });
      await send(prompt);
      await owner.until(async () => {
        const value = readDeliveryReceipts(control);
        return (
          value.complete &&
          value.entries.some(
            (entry) => entry.kind === "input" && entry.prompt === prompt && entry.withheld,
          )
        );
      });
      const message = await readMessage(prompt);
      check(message && message.text === prompt);
      const id = message!.id;
      await type(draft);
      step("workspace-verify-identity");
      check(
        (
          await browser.execute(readSelectedDeliveryWorktree, {
            origin,
            branch: workspace.branch,
            boundThreadId: workspace.threadId,
          })
        )?.threadId === workspace.threadId,
      );
      check(
        JSON.stringify(
          readOwnedDeliveryWorktree({
            root: runRoot,
            project: context.projectPath,
            home: context.fixtureUserHomePath,
            git: NodePath.join(config.fixture, "bin", "git"),
            branch: workspace.branch,
          }),
        ) ===
          JSON.stringify({
            path: workspace.path,
            branch: workspace.branch,
            commonDirectory: workspace.commonDirectory,
          }),
      );
      step("workspace-loss");
      await withUnavailableWorkspace(runRoot, workspace.path, async () => {
        step("workspace-wait-loss");
        await owner.until(async () => {
          check(
            NodeFS.statSync(context.projectPath).isDirectory() &&
              NodeFS.statSync(workspace.commonDirectory).isDirectory(),
          );
          const warning = browser!.$(`[data-testid="worktree-availability-${workspace.threadId}"]`);
          return (
            (await warning.isExisting()) &&
            (await warning.getText()).includes(
              "The worktree directory is missing. Git registration remains.",
            ) &&
            (await browser!.$(row(id)).getText()).includes("Delivery uncertain")
          );
        });
      });
      step("uncertain");
      const before = readDeliveryReceipts(control);
      check(before.complete);
      const holdStarted = performance.now();
      while (performance.now() - holdStarted < 10_000) {
        unchanged(before, readDeliveryReceipts(control));
        await delay(100);
      }
      unchanged(before, readDeliveryReceipts(control));
      const uncertaintyWindowMs = Math.floor(performance.now() - holdStarted);
      step("workspace-wait-recovered");
      await owner.until(
        async () =>
          (
            await browser!.execute(readSelectedDeliveryWorktree, {
              origin,
              branch: workspace.branch,
              boundThreadId: workspace.threadId,
            })
          )?.threadId === workspace.threadId &&
          !(await browser!
            .$(`[data-testid="worktree-availability-${workspace.threadId}"]`)
            .isExisting()),
      );
      check(
        readOwnedDeliveryWorktree({
          root: runRoot,
          project: context.projectPath,
          home: context.fixtureUserHomePath,
          git: NodePath.join(config.fixture, "bin", "git"),
          branch: workspace.branch,
        }).path === workspace.path,
      );
      unchanged(before, readDeliveryReceipts(control));
      step("uncertain");
      check((await readMessage(prompt))?.id === id && (await draftIs(draft)));
      await capture("uncertain", id, prompt, draft);
      step("dismiss-prompt");
      const retry = () => click(`${row(id)} button[aria-label="Retry message delivery"]`);
      const dismissed = await resolveActualRetryPrompt(browser, retry, "dismiss");
      const cancelStarted = performance.now();
      while (performance.now() - cancelStarted < 1000) {
        unchanged(before, readDeliveryReceipts(control));
        await delay(100);
      }
      unchanged(before, readDeliveryReceipts(control));
      const cancelWindowMs = Math.floor(performance.now() - cancelStarted);
      check(
        (await browser.$(row(id)).getText()).includes("Delivery uncertain") &&
          (await draftIs(draft)),
      );
      await capture("retry-cancelled", id, prompt, draft);
      step("accept-prompt");
      const accepted = await resolveActualRetryPrompt(browser, retry, "accept");
      await owner.until(async () =>
        (await browser!.$(row(id)).getText()).includes(newConversationNotice),
      );
      const proof = verifyFreshRetry(before, readDeliveryReceipts(control), prompt);
      check((await readMessage(prompt))?.id === id && (await draftIs(draft)));
      assertions.push({
        theme,
        ordinaryDeliveredHasNoNotice: true,
        selectedManagedWorktree: true,
        registeredGitIdentityMatched: true,
        primaryGitAnchorPreserved: true,
        catalogLossObserved: true,
        workspaceRestoredBeforeRetry: true,
        uncertaintyWindowMs,
        cancelWindowMs,
        noAutomaticResend: true,
        dismissed,
        accepted,
        cancelNoDispatch: true,
        sameMessage: true,
        exactText: true,
        draftRetained: true,
        ...proof,
      });
      await capture("new-conversation", id, prompt, draft);
      step("theme-cleanup");
      await owner.cleanup("browser", () =>
        bounded(
          browser!.deleteSession().then(() => undefined),
          15_000,
        ),
      );
      browser = undefined;
      await owner.stop(opened.driver);
      await owner.stop(server);
      check(owner.failures.length === 0);
    }
    check(
      captures.length === deliveryThemes.length * deliveryScenes.length && assertions.length === 2,
    );
    success = true;
  } catch (error) {
    const startupObservation =
      browser && (phase.startsWith("pair-") || phase.startsWith("theme-"))
        ? await readStartupFailureObservation()
        : null;
    const worktreeObservation =
      browser &&
      [
        "worktree-open-count",
        "worktree-open-focus",
        "worktree-open-displayed",
        "worktree-open-enabled",
        "worktree-open-focus-confirm",
        "worktree-open-enter",
      ].includes(phase)
        ? await readWorktreeFailureObservation()
        : null;
    write("failure", {
      phase,
      theme,
      failure: classifyQualificationFailure(error),
      startupObservation,
      worktreeObservation,
    });
  } finally {
    const processes = owner.processes.map(({ child, role, log, spawnFailure }) =>
      projectQualificationProcess({
        role,
        log,
        spawnFailure,
        exitCode: child.exitCode,
        signal: child.signalCode,
      }),
    );
    if (
      processes.some(
        (entry) => !entry.logReadable || entry.logTruncated || entry.guardRefusals !== 0,
      )
    )
      success = false;
    await owner.close(
      browser ? { browser: () => browser!.deleteSession().then(() => undefined) } : {},
    );
    if (owner.failures.length > 0 || !owner.childrenClosed()) success = false;
    write("result", {
      success,
      phase,
      theme,
      source: config.source,
      captures,
      assertions,
      networkProofs,
      processes,
      cleanupFailures: owner.failures,
      childProcessesClosed: owner.childrenClosed(),
      scope:
        "Real Linux Chromium Retry prompt and rendered notices only; not Tauri native-dialog or final issue29 qualification.",
    });
  }
  return success ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runDeliveryRetryQualification();
