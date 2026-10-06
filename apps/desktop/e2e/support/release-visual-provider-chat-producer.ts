// @effect-diagnostics nodeBuiltinImport:off - Closed receipts contain no public or private source values.
import * as NodeUtil from "node:util";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import type { DeliveryWorktreeIdentity } from "./delivery-retry-workspace.ts";
import {
  projectProviderChatCapture,
  runProviderChatScene,
  selectOwnedCodexVisualHigh,
  type ProviderChatScene,
  type ProviderChatDriver,
} from "./release-visual-provider-chat.ts";
import { providerChatFixturePrompts } from "./release-visual-provider-chat-fixture.ts";
import {
  bindProviderChatMessage,
  verifyProviderChatCheckpoint,
  verifyProviderChatDelivery,
  type ProviderChatMessageBinding,
  type ProviderChatNativeInput,
} from "./release-visual-provider-chat-turns.ts";
import type {
  ProviderChatLossBinding,
  ProviderChatWorkspaceLossScope,
} from "./release-visual-provider-chat-loss.ts";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { correctDesktopUiOuterSize } from "./window-size.ts";
import { readVisualViewport } from "./release-visual-observation.ts";
export const qualifiedProviderChatScenes = [
  "composer-command-menu",
  "context-popover",
  "mcp-popover",
  "chat-markdown-plan",
  "activity-narrow",
  "chat-refused-model",
  "chat-held-workspace-loss",
] as const;
export function readProviderChatBinding(input: {
  snapshot: OrchestrationReadModel;
  hostThreadId: string;
  targetThreadId: string;
  projectPath: string;
  workspace: DeliveryWorktreeIdentity;
  provider: "claudeAgent" | "codex";
}) {
  const refused = () => new Error("Owned provider context refused.");
  const hosts = input.snapshot.threads.filter((value) => value.id === input.hostThreadId);
  const targets = input.snapshot.threads.filter((value) => value.id === input.targetThreadId);
  if (hosts.length !== 1 || targets.length !== 1) throw refused();
  const host = hosts[0]!,
    target = targets[0]!;
  const projects = input.snapshot.projects.filter((value) => value.id === host.projectId);
  if (
    projects.length !== 1 ||
    projects[0]!.deletedAt !== null ||
    projects[0]!.workspaceRoot !== input.projectPath ||
    host.kind !== "workspace" ||
    host.modelSelection.instanceId !== "claudeAgent" ||
    target.kind !== (target.id === host.id ? "workspace" : "panel") ||
    (input.provider === "claudeAgent") !== (target.id === host.id) ||
    target.modelSelection.instanceId !== input.provider ||
    target.modelSelection.model !== (input.provider === "codex" ? "gpt-5.4" : "opus") ||
    [host, target].some(
      (value) =>
        value.deletedAt !== null ||
        value.archivedAt !== null ||
        value.projectId !== host.projectId ||
        value.worktreePath !== input.workspace.path ||
        value.branch !== input.workspace.branch,
    ) ||
    (target.session !== null &&
      (target.session.threadId !== target.id ||
        target.session.providerInstanceId !== input.provider ||
        target.session.providerName !== input.provider))
  )
    throw refused();
  return { host, target };
}
const assertionFields = [
  "providerChatOnly",
  "completeGroup",
  "hostAndOwnedPanelJoined",
  "nativeTurnsJoined",
  "checkpointFileJoined",
  "assetBytesJoined",
  "refusalFifoJoined",
  "registeredLossJoined",
  "lossFifoJoined",
  "noAutomaticResend",
  "ownedPanelClosed",
  "originalHostRestored",
] as const;
export function projectProviderChatAssertion(theme: "light" | "dark") {
  return {
    theme,
    providerChatOnly: true,
    completeGroup: false,
    hostAndOwnedPanelJoined: true,
    nativeTurnsJoined: true,
    checkpointFileJoined: true,
    assetBytesJoined: true,
    refusalFifoJoined: true,
    registeredLossJoined: true,
    lossFifoJoined: true,
    noAutomaticResend: true,
    ownedPanelClosed: true,
    originalHostRestored: true,
  };
}
export function validateProviderChatJoins(captures: unknown, assertions: unknown): void {
  const refused = () => new Error("Owned provider evidence joins refused.");
  const array = (value: unknown, length: number): value is unknown[] =>
    Array.isArray(value) &&
    !NodeUtil.types.isProxy(value) &&
    value.length === length &&
    Reflect.ownKeys(value).length === length + 1 &&
    Array.from({ length }, (_, index) =>
      Object.getOwnPropertyDescriptor(value, String(index)),
    ).every((field) => field && Object.hasOwn(field, "value"));
  if (!array(captures, 14) || !array(assertions, 2)) throw refused();
  const names = new Set<string>();
  for (const value of captures) {
    const capture = projectProviderChatCapture(value);
    if (
      !qualifiedProviderChatScenes.some((scene) => scene === capture.scene) ||
      names.has(capture.file)
    )
      throw refused();
    names.add(capture.file);
  }
  const themes = new Set<string>();
  for (const value of assertions) {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Reflect.ownKeys(value).length !== assertionFields.length + 1
    )
      throw refused();
    const theme = Object.getOwnPropertyDescriptor(value, "theme");
    if (
      !theme?.enumerable ||
      !Object.hasOwn(theme, "value") ||
      !["light", "dark"].includes(theme.value) ||
      themes.has(theme.value)
    )
      throw refused();
    themes.add(theme.value);
    for (const key of assertionFields) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (
        !field?.enumerable ||
        !Object.hasOwn(field, "value") ||
        field.value !== (key !== "completeGroup")
      )
        throw refused();
    }
  }
}

/** Serialized public DOM admission; the ordinary route stays on the original host card. */
export function readProviderChatPublicContext(input: {
  origin: string;
  hostThreadId: string;
  targetThreadId: string;
  branch: string;
  provider: "claudeAgent" | "codex";
}) {
  if (
    location.origin !== input.origin ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.pathname !== "/local/" + input.hostThreadId ||
    location.search ||
    location.hash ||
    !/^codex\/delivery-retry-(light|dark)$/.test(input.branch) ||
    ![input.hostThreadId, input.targetThreadId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    )
  )
    return false;
  const visible = (node: Element) => {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const one = (selector: string) => {
    const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
    return nodes.length === 1 ? nodes[0]! : null;
  };
  const expected =
    input.targetThreadId === input.hostThreadId ? "chat:host" : "chat:" + input.targetThreadId;
  const surfaces = Array.from(
    document.querySelectorAll('[data-center-surface-host][data-visible="true"]'),
  ).filter(visible);
  const surface = surfaces.length === 1 ? surfaces[0]! : null;
  const card = one(`[data-testid="thread-card-button-${input.hostThreadId}"][aria-current="page"]`);
  const branches = (card?.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((value) => value.endsWith("-branch"));
  return (
    card !== null &&
    branches.length === 1 &&
    document
      .getElementById(branches[0]!)
      ?.querySelector('[data-slot="tooltip-trigger"]')
      ?.textContent?.trim() === input.branch &&
    surface !== null &&
    surface.getAttribute("data-center-surface-host") === expected &&
    one('[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]') !==
      null &&
    surface.querySelectorAll('[data-chat-provider-model-picker="true"]').length === 1 &&
    surface
      .querySelector('[data-chat-provider-model-picker="true"]')
      ?.getAttribute("aria-label") ===
      (input.provider === "codex" ? "Codex · GPT-5.4" : "Claude · Opus 5")
  );
}

export interface ProviderChatProducerInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  theme: "light" | "dark";
  origin: string;
  hostThreadId: string;
  projectPath: string;
  workspace: DeliveryWorktreeIdentity;
  snapshot: () => Promise<OrchestrationReadModel>;
  readInputs: () => readonly ProviderChatNativeInput[];
  verifyWorktree: () => void;
  verifyMedia: (changed: boolean) => void;
  withRefusedModel: (run: () => Promise<void>) => Promise<void>;
  withManagedWorkspaceLoss: (
    readBinding: () => Promise<ProviderChatLossBinding>,
    run: (scope: ProviderChatWorkspaceLossScope) => Promise<void>,
  ) => Promise<void>;
  verifyLoss: (scope: ProviderChatWorkspaceLossScope, binding: ProviderChatLossBinding) => void;
  capture: (scene: ProviderChatScene, verify: () => Promise<void>) => Promise<void>;
  observeUnsafeCleanup: () => void;
  step: (phase: string) => void;
}
/** Seven existing rows via public composer, panel and queue callbacks only. */
export async function runProviderChatVisual(input: ProviderChatProducerInput) {
  const refused = () => new Error("Owned provider visual producer refused.");
  const browser = input.browser;
  let targetThreadId = input.hostThreadId,
    provider: "claudeAgent" | "codex" = "claudeAgent",
    panelId: string | null = null;
  const surface = () =>
    `[data-center-surface-host="${targetThreadId === input.hostThreadId ? "chat:host" : "chat:" + targetThreadId}"][data-visible="true"]`;
  const form = () => surface() + ' [data-chat-composer-form="true"]';
  const editor = () => form() + ' [data-testid="composer-editor"]';
  const binding = async () =>
    readProviderChatBinding({
      snapshot: await input.snapshot(),
      hostThreadId: input.hostThreadId,
      targetThreadId,
      projectPath: input.projectPath,
      workspace: input.workspace,
      provider,
    });
  const verifyContext = async () => {
    await binding();
    if (
      (await bounded(
        browser.execute(readProviderChatPublicContext, {
          origin: input.origin,
          hostThreadId: input.hostThreadId,
          targetThreadId,
          branch: input.workspace.branch,
          provider,
        }),
        2000,
      )) !== true
    )
      throw refused();
  };
  const ordinary = async () => {
    input.verifyWorktree();
    await verifyContext();
  };
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const draft = async (text: string) => {
    if ((await browser.$(editor()).getText()).trim() !== "") throw refused();
    await click(editor());
    await browser.keys(text);
    if ((await browser.$(editor()).getText()).trim() !== text) throw refused();
  };
  const clearDraft = async (expected: string) => {
    if ((await browser.$(editor()).getText()).trim() !== expected) throw refused();
    if (expected) {
      await click(editor());
      await browser.keys(["Control", "a"]);
      await browser.keys("Backspace");
    }
    if ((await browser.$(editor()).getText()).trim() !== "") throw refused();
  };
  const viewport = async (width: number, height: number) => {
    const observed = await bounded(browser.execute(readVisualViewport), 2000);
    const outer = await browser.getWindowSize();
    const corrected = correctDesktopUiOuterSize(
      outer,
      { width, height },
      observed,
      observed.devicePixelRatio,
    );
    await browser.setWindowSize(corrected.width, corrected.height);
    await input.owner.until(async () => {
      const current = await bounded(browser.execute(readVisualViewport), 2000);
      return current.width === width && current.height === height;
    });
  };
  let scene: ProviderChatScene = "composer-command-menu",
    original: ProviderChatMessageBinding | null = null,
    queued: ProviderChatMessageBinding | null = null,
    last: ProviderChatMessageBinding | null = null;
  const send = async (prompt: string) => {
    const before = (await binding()).target,
      beforeInputs = input.readInputs();
    await draft(prompt);
    await click(form() + ' button[aria-label="Send message"]');
    const state =
      scene === "chat-refused-model"
        ? original === null
          ? "refused"
          : "queued"
        : scene === "chat-held-workspace-loss"
          ? original === null
            ? "running"
            : "queued"
          : "completed";
    let joined: ProviderChatMessageBinding | null = null;
    await input.owner.until(async () => {
      const after = (await binding()).target;
      const fresh = after.messages.filter(
        (value) =>
          value.role === "user" &&
          !before.messages.some((old) => old.id === value.id) &&
          value.text === prompt,
      );
      if (fresh.length === 0) return false;
      if (fresh.length !== 1) throw refused();
      const message = fresh[0]!;
      if (state === "running" || state === "completed") {
        if (
          message.delivery?.state === "queued" ||
          message.delivery?.state === "pending" ||
          message.delivery?.state === "sending" ||
          (after.latestTurn?.state === "running" && state === "completed")
        )
          return false;
      } else if (state === "refused" && message.delivery?.state !== "failed") return false;
      else if (state === "queued" && message.delivery?.state !== "queued") return false;
      if (
        input.readInputs().length === beforeInputs.length &&
        (state === "running" || state === "completed")
      )
        return false;
      joined = bindProviderChatMessage({
        before,
        after,
        prompt,
        provider,
        state,
        inputs: input.readInputs(),
        beforeInputCount: beforeInputs.length,
      });
      return true;
    });
    if (joined === null) throw refused();
    last = joined;
    if (scene === "chat-markdown-plan")
      await input.owner.until(async () => {
        const current = (await binding()).target;
        if (
          !current.checkpoints.some(
            (value) => value.turnId === last?.turnId && value.status === "ready",
          )
        )
          return false;
        if (last === null) throw refused();
        verifyProviderChatCheckpoint(current, last);
        input.verifyMedia(true);
        return true;
      });
    if (scene === "chat-refused-model" || scene === "chat-held-workspace-loss") {
      if (original === null) original = joined;
      else if (queued === null) queued = joined;
      else throw refused();
    }
    await input.owner.until(async () => (await browser.$(editor()).getText()).trim() === "");
  };
  const joinScene = async (scope?: ProviderChatWorkspaceLossScope) => {
    if (scope) {
      const current = await binding();
      input.verifyLoss(scope, current);
      await verifyContext();
    } else await ordinary();
    const current = (await binding()).target;
    if (scene === "chat-markdown-plan") {
      if (!last) throw refused();
      verifyProviderChatCheckpoint(current, last);
      input.verifyMedia(true);
    }
    if (scene === "chat-refused-model" || scene === "chat-held-workspace-loss") {
      if (!original || !queued) throw refused();
      verifyProviderChatDelivery({
        scene,
        thread: current,
        original,
        queuedMessageId: queued.messageId,
        inputs: input.readInputs(),
      });
    }
  };
  const cleanupQueue = async () => {
    if (queued === null) return;
    const waiting = queued,
      first = original,
      beforeInputs = input.readInputs();
    const text = (await browser.$(editor()).getText()).trim();
    if (text !== "" && text !== "Owned visual review draft") throw refused();
    await clearDraft(text);
    await click(
      surface() +
        ` [data-queued-message-row="${waiting.messageId}"] button[data-queued-message-cancel="true"]`,
    );
    // The public cancel callback withdraws the queued message from the read model.
    await input.owner.until(
      async () =>
        !(await binding()).target.messages.some((value) => value.id === waiting.messageId),
    );
    await input.owner.until(
      async () => (await browser.$(editor()).getText()).trim() === waiting.prompt,
    );
    await clearDraft(waiting.prompt);
    if (scene === "chat-refused-model" && first) {
      await click(
        surface() +
          ` [data-message-role="user"][data-message-id="${first.messageId}"] button[aria-label="Dismiss and skip this message"]`,
      );
      await input.owner.until(async () =>
        (await binding()).target.messages.some(
          (value) => value.id === first.messageId && value.delivery?.state === "dismissed",
        ),
      );
    }
    if (JSON.stringify(input.readInputs()) !== JSON.stringify(beforeInputs)) throw refused();
    queued = null;
    original = null;
  };
  const cleanupScene = async () => {
    await browser.keys("Escape");
    await cleanupQueue();
    const text = (await browser.$(editor()).getText()).trim();
    if (text === "/comp" || text === "Owned visual review draft") await clearDraft(text);
    else if (text !== "") throw refused();
    const hidePlan = surface() + ' button[aria-label="Hide plan sidebar"]';
    if (await browser.$(hidePlan).isDisplayed()) await click(hidePlan);
    const collapse = surface() + ' button[aria-label^="Collapse activity summary:"]';
    if (await browser.$(collapse).isDisplayed()) await click(collapse);
    if (await browser.$("[data-activity-panel]").isDisplayed())
      await click('button[aria-label^="Toggle right panel"]');
    await viewport(1280, 960);
    await ordinary();
  };
  let failed = false,
    failure: unknown;
  try {
    await ordinary();
    input.verifyMedia(false);
    const driver: ProviderChatDriver = {
      browser,
      prepare: async (next) => {
        scene = next;
        last = null;
        original = null;
        queued = null;
        input.step("visual-provider-chat-" + next);
        if (["activity-narrow", "chat-refused-model", "chat-held-workspace-loss"].includes(next)) {
          if (panelId === null) {
            const before = await input.snapshot(),
              ids = new Set(before.threads.map((value) => value.id));
            await click('button[aria-label="New panel"]');
            await click('//*[@role="menuitem"][.//span[normalize-space()="Codex"]]');
            await input.owner.until(async () => {
              const current = await input.snapshot();
              const candidates = current.threads.filter(
                (value) => !ids.has(value.id) && value.deletedAt === null,
              );
              if (candidates.length === 0) return false;
              if (candidates.length !== 1) throw refused();
              const candidate = candidates[0]!;
              readProviderChatBinding({
                snapshot: current,
                hostThreadId: input.hostThreadId,
                targetThreadId: candidate.id,
                projectPath: input.projectPath,
                workspace: input.workspace,
                provider: "codex",
              });
              panelId = candidate.id;
              return true;
            });
          }
          if (panelId === null) throw refused();
          targetThreadId = panelId;
          provider = "codex";
          await click(
            `[data-center-panel-tab-id="chat:${panelId}"] [data-center-panel-tab-activation]`,
          );
          await click(form() + ' [data-chat-provider-model-picker="true"]');
          await click(
            '[data-model-picker-content="true"] [data-model-picker-instance-id="codex"][data-model-picker-model-slug="gpt-5.4"]',
          );
          await input.owner.until(
            async () =>
              (await bounded(
                browser.execute(readProviderChatPublicContext, {
                  origin: input.origin,
                  hostThreadId: input.hostThreadId,
                  targetThreadId,
                  branch: input.workspace.branch,
                  provider,
                }),
                2000,
              )) === true,
          );
          if (next === "chat-refused-model")
            await selectOwnedCodexVisualHigh({
              browser,
              owner: input.owner,
              verifyOwnedIdentity: ordinary,
              scene: next,
              theme: input.theme,
              origin: input.origin,
              threadId: input.hostThreadId,
              branch: input.workspace.branch,
            });
        }
        await ordinary();
      },
      verifyOwnedIdentity: ordinary,
      send,
      draft,
      viewport,
      click: async (selector) => {
        if (selector.startsWith('button[aria-label^="Show "]')) {
          const show = surface() + ' button[aria-label="Show plan sidebar"]',
            hide = surface() + ' button[aria-label="Hide plan sidebar"]';
          if (await browser.$(hide).isDisplayed()) return;
          await click(show);
          return;
        }
        await click(
          selector.startsWith("[data-activity-row") ? selector : surface() + " " + selector,
        );
      },
      withRefusedModel: input.withRefusedModel,
      withManagedWorkspaceLoss: (run) =>
        input.withManagedWorkspaceLoss(binding, async (scope) => {
          await input.owner.until(async () => {
            const current = await binding();
            input.verifyLoss(scope, current);
            return (
              current.target.latestTurn?.turnId === original?.turnId &&
              current.target.latestTurn?.state === "error" &&
              current.target.session?.activeTurnId === null &&
              current.target.messages.some(
                (value) =>
                  value.id === queued?.messageId &&
                  value.delivery?.state === "queued" &&
                  value.delivery.held === true,
              )
            );
          });
          await run(scope);
        }),
      capture: async (_scene, scope) => {
        await joinScene(scope);
        await input.capture(scene, () => joinScene(scope));
      },
    };
    for (const next of qualifiedProviderChatScenes) {
      await runProviderChatScene(driver, next);
      await cleanupScene();
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  let cleanupFailed = false;
  try {
    await cleanupScene();
    if (panelId !== null) {
      const owned = panelId;
      await browser.$(`[data-center-panel-tab-id="chat:${owned}"]`).moveTo();
      await click(`[data-center-panel-tab-id="chat:${owned}"] button[aria-label^="Close "]`);
      await input.owner.until(async () =>
        (await input.snapshot()).threads.some(
          (value) => value.id === owned && value.deletedAt !== null,
        ),
      );
      panelId = null;
    }
    targetThreadId = input.hostThreadId;
    provider = "claudeAgent";
    await click(`[data-testid="thread-card-button-${input.hostThreadId}"]`);
    await ordinary();
  } catch {
    cleanupFailed = true;
    input.observeUnsafeCleanup();
  }
  if (failed) throw failure;
  if (cleanupFailed) throw refused();
  return projectProviderChatAssertion(input.theme);
}
