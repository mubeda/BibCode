// @effect-diagnostics nodeBuiltinImport:off - Reject untrusted Node witnesses before descriptor access.
import * as NodeUtil from "node:util";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { validateCaptureWitness } from "./remote-ui-evidence.ts";
import { readVisualPageScroll } from "./release-visual-observation.ts";

export const workspaceSubstates = [
  "selected-stash-diff",
  "files-item-context-menu",
  "workspace-activity-lines",
] as const;
export type WorkspaceSubstate = (typeof workspaceSubstates)[number];

export const workspaceSubstateRows = Object.freeze({
  "selected-stash-diff": "git-history-stashes",
  "files-item-context-menu": "files-editor-comment",
  "workspace-activity-lines": "workspace-composite",
} as const);
const prefixes = Object.freeze({
  "selected-stash-diff": "git-history-stashes-selected-diff",
  "files-item-context-menu": "files-editor-comment-item-context-menu",
  "workspace-activity-lines": "workspace-composite-activity-lines",
});
const commonKeys = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
const facts = Object.freeze({
  "selected-stash-diff": [
    "selectedStash",
    "selectedStashFile",
    "actualStashDiff",
    "containedStashList",
  ],
  "files-item-context-menu": [
    "itemSelected",
    "singleItemMenu",
    "fileActions",
    "fileEditorPresent",
    "commentRetained",
  ],
  "workspace-activity-lines": [
    "terminalActivity",
    "terminalTooltip",
    "sessionModelAge",
    "oneOtherChat",
    "originalWorkspaceRetained",
  ],
});
const refused = () => new Error("Owned workspace substate refused.");

function state(value: unknown): WorkspaceSubstate {
  if (typeof value !== "string" || !workspaceSubstates.some((entry) => entry === value))
    throw refused();
  return value as WorkspaceSubstate;
}
export function workspaceSubstateFileName(substate: unknown, theme: unknown): string {
  const selected = state(substate);
  if (theme !== "light" && theme !== "dark") throw refused();
  return `${prefixes[selected]}-${theme}.png`;
}

export interface WorkspaceSubstateContext {
  readonly origin: string;
  readonly theme: "light" | "dark";
  readonly threadId: string;
  readonly projectId: string;
  readonly branch: string;
}
export interface WorkspaceSubstateObservation extends WorkspaceSubstateContext {
  readonly substate: WorkspaceSubstate;
}
export type WorkspaceActivityPhase =
  | "context"
  | "managed"
  | "admission"
  | "panel-count"
  | "terminal-open"
  | "terminal-focus"
  | "terminal-command"
  | "terminal-running"
  | "host-return"
  | "chat-open"
  | "chat-compose"
  | "chat-send"
  | "chat-response"
  | "host-restore"
  | "terminal-hover"
  | "capture";

function activityStep(input: WorkspaceSubstateFlowInput, phase: WorkspaceActivityPhase): void {
  try {
    input.step?.(`visual-workspace-activity-${phase}`);
  } catch {
    // Optional closed attribution never changes the public operation or its failure.
  }
}

export interface WorkspaceSubstateFlowInput extends WorkspaceSubstateContext {
  readonly browser: QualificationBrowser;
  readonly owner: Pick<QualificationOwner, "until">;
  /** Positive current managed Git/worktree/provider-source proof remains caller-owned. */
  readonly verifyManaged: () => Promise<void>;
  readonly capture: (substate: WorkspaceSubstate) => Promise<unknown>;
  readonly step?: (phase: `visual-workspace-activity-${WorkspaceActivityPhase}`) => void;
  readonly observeCleanupFailure?: (phase: "stash" | "files-menu" | "workspace-panels") => void;
}

function observation(
  input: WorkspaceSubstateContext,
  selected: WorkspaceSubstate,
): WorkspaceSubstateObservation {
  if (input === null || typeof input !== "object" || NodeUtil.types.isProxy(input)) throw refused();
  const data: Record<string, unknown> = {};
  for (const key of ["origin", "theme", "threadId", "projectId", "branch"]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
    data[key] = descriptor.value;
  }
  if (
    data.origin !== "http://127.0.0.1:4885" ||
    (data.theme !== "light" && data.theme !== "dark") ||
    ![data.threadId, data.projectId].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    data.branch !== `codex/delivery-retry-${data.theme}`
  )
    throw refused();
  return Object.freeze({
    ...data,
    substate: state(selected),
  }) as unknown as WorkspaceSubstateObservation;
}

/** One serialized read: fixed facts only, no DOM/store mutation or retained page values. */
export function readWorkspaceSubstate(
  input: WorkspaceSubstateObservation,
): Record<string, boolean> | null {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      input.origin !== "http://127.0.0.1:4885" ||
      location.origin !== input.origin ||
      location.search !== "" ||
      location.hash !== "" ||
      (input.theme !== "light" && input.theme !== "dark") ||
      ![input.threadId, input.projectId].every(
        (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
      ) ||
      input.branch !== `codex/delivery-retry-${input.theme}`
    )
      return null;
    const visible = (node: Element | null): node is HTMLElement => {
      if (!node) return false;
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity) === 0
        )
          return false;
      }
      return true;
    };
    const all = (selector: string, root: ParentNode = document) =>
      Array.from(root.querySelectorAll(selector)).filter(visible);
    const one = (selector: string, root: ParentNode = document) => {
      const nodes = all(selector, root);
      return nodes.length === 1 ? nodes[0]! : null;
    };
    const text = (node: Element | null) => node?.textContent?.trim() ?? "";
    const row = one(`[data-testid="thread-row-${input.threadId}"]`);
    const card = one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`);
    const git = input.substate === "selected-stash-diff";
    const selected = git
      ? location.pathname === `/project/local/${input.projectId}/git` &&
        text(one('[aria-label="Worktree"]')) === input.branch &&
        text(one('[aria-label="Choose branch"]')) === input.branch
      : location.pathname === `/local/${input.threadId}` && card !== null && row !== null;
    let target: HTMLElement | null = null;
    let ownedOverlay: HTMLElement | null = null;
    let required: Record<string, boolean>;
    if (input.substate === "selected-stash-diff") {
      target = one('section[aria-label="Stash 11 diff"]');
      const entry = one('button[aria-label="Select stash stash@{11}"]');
      const list = entry?.closest('[role="listbox"]') ?? null;
      const selectedFile =
        target && one('[role="option"][aria-selected="true"][title="visual-stash.txt"]', target);
      const hosts = target ? all("diffs-container", target) : [];
      const content = hosts.map((host) => host.shadowRoot?.textContent ?? "").join("\n");
      const listBox = list?.getBoundingClientRect();
      required = {
        selectedStash: entry?.closest('[role="option"]')?.getAttribute("aria-selected") === "true",
        selectedStashFile: selectedFile !== null && !!selectedFile,
        actualStashDiff:
          hosts.length === 1 &&
          content.includes("Owned stash change 1") &&
          content.includes("Visual stash baseline"),
        containedStashList:
          !!listBox &&
          listBox.left >= 0 &&
          listBox.top >= 0 &&
          listBox.right <= innerWidth &&
          listBox.bottom <= innerHeight,
      };
    } else if (input.substate === "files-item-context-menu") {
      target = one('[data-file-tree-context-menu-root="true"][role="menu"]');
      const tree = one("[data-preview-panel-mode] file-tree-container");
      const items = tree?.shadowRoot
        ? all('[role="treeitem"][data-item-path="src/nested/visual-note.ts"]', tree.shadowRoot)
        : [];
      const menus = all('[role="menu"]');
      const labels = target ? all('[role="menuitem"]', target).map((item) => text(item)) : [];
      const views = all("[data-preview-panel-mode] diffs-container");
      required = {
        itemSelected: items.length === 1 && items[0]?.getAttribute("aria-selected") === "true",
        singleItemMenu: target !== null && menus.length === 1,
        fileActions:
          ["Copy Relative Path", "Duplicate", "Rename…", "Delete"].every((label) =>
            labels.includes(label),
          ) && !labels.includes("Add as Project…"),
        fileEditorPresent:
          views.length === 1 &&
          text(
            views[0]?.shadowRoot?.querySelector(
              '[role="textbox"][aria-label="src/nested/visual-note.ts"]',
            ) ?? null,
          ).includes("Review this owned file"),
        commentRetained:
          all("[data-file-comment-annotation]").some((node) =>
            text(node).includes("Review this owned line"),
          ) && one('button[aria-label="Delete comment"]') !== null,
      };
    } else if (input.substate === "workspace-activity-lines") {
      target = row;
      const indicator = row && one('[role="img"][aria-label="Terminal process running"]', row);
      const tooltipId = indicator?.getAttribute("aria-describedby");
      const tooltip = tooltipId ? document.getElementById(tooltipId) : null;
      ownedOverlay =
        visible(tooltip) &&
        tooltip.getAttribute("role") === "tooltip" &&
        text(tooltip) === "Terminal process running"
          ? tooltip
          : null;
      const session = row && one('[id$="-session"]', row);
      const model = session && one("span.font-mono", session);
      const age = session && one("time", session);
      const chatLines = row ? all("span", row).filter((node) => text(node) === "1 more chat") : [];
      const surface = one('[data-center-surface-host][data-visible="true"]');
      required = {
        terminalActivity: !!indicator,
        terminalTooltip: ownedOverlay !== null,
        sessionModelAge:
          !!session &&
          !!model &&
          text(model).length > 0 &&
          text(model).length <= 64 &&
          !!age &&
          text(age).length > 0 &&
          text(age).length <= 32 &&
          session?.querySelector(".workspace-card-provider-icon") !== null,
        oneOtherChat: chatLines.length === 1,
        originalWorkspaceRetained:
          text(surface).includes("BiBCode deterministic streamed fixture response.") &&
          text(one('[data-testid="composer-editor"]', surface ?? document)) ===
            "Owned visual review draft",
      };
    } else return null;
    const fits = (node: HTMLElement | null) => {
      if (!visible(node)) return false;
      const box = node.getBoundingClientRect();
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
        return false;
      return [box.top + 2, box.top + box.height / 2, box.bottom - 2].every((y) => {
        const hit = document.elementFromPoint(box.left + box.width / 2, y);
        return (
          hit !== null &&
          (hit === node ||
            node.contains(hit) ||
            (ownedOverlay !== null && (hit === ownedOverlay || ownedOverlay.contains(hit))))
        );
      });
    };
    return {
      themeMatched:
        document.documentElement.classList.contains("dark") === (input.theme === "dark"),
      selectedMatched:
        selected &&
        document
          .querySelector('[data-testid="environment-rail-local"]')
          ?.getAttribute("aria-checked") === "true" &&
        document.querySelector(
          '[data-testid="environment-rail-local"] [data-status="connected"]',
        ) !== null,
      expectedTextMatched: Object.values(required).every(Boolean),
      targetInView:
        innerWidth === 1280 &&
        innerHeight === 960 &&
        fits(target) &&
        (ownedOverlay === null || fits(ownedOverlay)),
      credentialAbsent:
        document.querySelector(
          '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
        ) === null,
      bootShellAbsent:
        document.getElementById("boot-shell") === null &&
        document.querySelector("vite-error-overlay") === null,
      ...required,
    };
  } catch {
    return null;
  }
}

export function validateWorkspaceSubstate(
  substate: WorkspaceSubstate,
  value: unknown,
): Record<string, true> {
  const selected = state(substate),
    keys = [...commonKeys, ...facts[selected]];
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value !== true)
      throw refused();
  }
  validateCaptureWitness(Object.fromEntries(commonKeys.map((key) => [key, true])));
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, true] as const)));
}

/** Separate fixed originals bind existing rows; they never replace the nine core originals. */
export async function captureWorkspaceSubstate(
  input: WorkspaceSubstateContext & {
    readonly substate: WorkspaceSubstate;
    readonly browser: QualificationBrowser;
    readonly owner: Pick<QualificationOwner, "until">;
    readonly evidence: string;
    readonly captured: Set<string>;
    readonly verifyManaged: () => Promise<void>;
  },
): Promise<object> {
  const selected = state(input.substate),
    observed = observation(input, selected);
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    file: workspaceSubstateFileName(selected, observed.theme),
    captured: input.captured,
    observation: () => observed,
    read: (context) => input.browser.execute(readWorkspaceSubstate, context),
    verifyOwnedIdentity: input.verifyManaged,
    validate: (value) => validateWorkspaceSubstate(selected, value),
    project: ({ file, witness, ...image }) => {
      if (!witness) throw refused();
      return Object.freeze({
        scene: workspaceSubstateRows[selected],
        substate: selected,
        theme: observed.theme,
        file,
        witness,
        ...image,
      });
    },
    refused,
  });
}

async function admit(input: WorkspaceSubstateFlowInput, selected: WorkspaceSubstate) {
  if (selected === "workspace-activity-lines") activityStep(input, "context");
  const context = observation(input, selected);
  if (selected === "workspace-activity-lines") activityStep(input, "managed");
  await input.verifyManaged();
  if (selected === "workspace-activity-lines") activityStep(input, "admission");
  const value = await bounded(input.browser.execute(readWorkspaceSubstate, context), 2000);
  if (
    !value ||
    ["themeMatched", "selectedMatched", "credentialAbsent", "bootShellAbsent"].some(
      (key) => value[key] !== true,
    )
  )
    throw refused();
  return context;
}
async function click(input: WorkspaceSubstateFlowInput, selector: string) {
  if ((await input.browser.$$(selector).length) !== 1) throw refused();
  const element = input.browser.$(selector);
  await element.waitForDisplayed();
  await element.waitForEnabled();
  await element.waitForClickable();
  await input.verifyManaged();
  await element.click();
}
async function restoreAfter(
  input: WorkspaceSubstateFlowInput,
  phase: "stash" | "files-menu" | "workspace-panels",
  body: () => Promise<void>,
  restore: () => Promise<void>,
) {
  let original: unknown;
  let failed = false;
  try {
    await body();
  } catch (error) {
    original = error;
    failed = true;
  }
  try {
    await restore();
  } catch (error) {
    try {
      input.observeCleanupFailure?.(phase);
    } catch {
      /* Closed optional observation. */
    }
    if (!failed) throw error;
  }
  if (failed) throw original;
}

/** Read-only stash selection: never apply, pop, drop or change the index. */
export async function runSelectedStashDiff(input: WorkspaceSubstateFlowInput): Promise<void> {
  await admit(input, "selected-stash-diff");
  const toggle = input.browser.$('[aria-label="Toggle repository stashes"]');
  const expanded = await toggle.getAttribute("aria-expanded");
  if (expanded !== "true" && expanded !== "false") throw refused();
  await restoreAfter(
    input,
    "stash",
    async () => {
      if (expanded === "false") await click(input, '[aria-label="Toggle repository stashes"]');
      const entry = input.browser.$('button[aria-label="Select stash stash@{11}"]');
      await entry.waitForEnabled();
      const before = await bounded(input.browser.execute(readVisualPageScroll), 2000);
      await entry.scrollIntoView({ block: "end" });
      const after = await bounded(input.browser.execute(readVisualPageScroll), 2000);
      if (before.x !== after.x || before.y !== after.y) throw refused();
      await click(input, 'button[aria-label="Select stash stash@{11}"]');
      await input.capture("selected-stash-diff");
    },
    async () => {
      await click(
        input,
        '//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]',
      );
      if (expanded === "false") await click(input, '[aria-label="Toggle repository stashes"]');
    },
  );
}

/** Open only the already selected owned file's actual shadow-tree item menu. */
export async function runFilesItemContextMenu(input: WorkspaceSubstateFlowInput): Promise<void> {
  const context = await admit(input, "files-item-context-menu");
  const before = await bounded(input.browser.execute(readWorkspaceSubstate, context), 2000);
  if (before?.itemSelected !== true) throw refused();
  const entry = input.browser
    .$("[data-preview-panel-mode] file-tree-container")
    .shadow$('[role="treeitem"][data-item-path="src/nested/visual-note.ts"]');
  let attempted = false;
  await restoreAfter(
    input,
    "files-menu",
    async () => {
      await entry.waitForDisplayed();
      await entry.waitForEnabled();
      await entry.waitForClickable();
      await input.verifyManaged();
      attempted = true;
      await entry.click({ button: "right" });
      await input.browser
        .$('[data-file-tree-context-menu-root="true"][role="menu"]')
        .waitForDisplayed();
      await input.capture("files-item-context-menu");
    },
    async () => {
      if (!attempted) return;
      await input.browser.keys("Escape");
      await input.browser
        .$('[data-file-tree-context-menu-root="true"][role="menu"]')
        .waitForDisplayed({ reverse: true });
    },
  );
}

/** Public terminal subprocess and second provider chat, with owned resources closed on every exit. */
export async function runWorkspaceActivityLines(input: WorkspaceSubstateFlowInput): Promise<void> {
  await admit(input, "workspace-activity-lines");
  activityStep(input, "panel-count");
  const base = '[data-center-panel-tab-id="chat:host"]';
  if (
    (await input.browser.$$("[data-center-panel-tab-id]").length) !== 1 ||
    (await input.browser.$$(base).length) !== 1
  )
    throw refused();
  const terminal = '[data-center-panel-tab-id^="terminal:"]',
    chat = '[data-center-panel-tab-id^="chat:"]:not([data-center-panel-tab-id="chat:host"])';
  let terminalAttempted = false,
    chatAttempted = false;
  const panel = async (label: "Open Terminal" | "Claude") => {
    await click(input, 'button[aria-label="New panel"]');
    await click(
      input,
      `//*[@role="menu"]//*[@role="menuitem" and normalize-space()="${label}" and not(@aria-disabled="true")]`,
    );
  };
  await restoreAfter(
    input,
    "workspace-panels",
    async () => {
      activityStep(input, "terminal-open");
      terminalAttempted = true;
      await panel("Open Terminal");
      activityStep(input, "terminal-focus");
      const screen =
        '[data-center-surface-host][data-visible="true"] [data-terminal-owner="center"] .xterm-screen';
      await click(input, screen);
      await input.owner.until(() =>
        input.browser.execute(() => {
          const active = document.activeElement;
          return (
            active?.classList.contains("xterm-helper-textarea") === true &&
            active.closest(
              '[data-center-surface-host][data-visible="true"] [data-terminal-owner="center"]',
            ) !== null
          );
        }),
      );
      // The contained fixture PATH deliberately excludes ambient command lookup.
      activityStep(input, "terminal-command");
      await input.browser.keys("/bin/sleep 600");
      await input.browser.keys("Enter");
      activityStep(input, "terminal-running");
      await input.owner.until(() =>
        input.browser
          .$(`[data-testid="thread-row-${input.threadId}"] [aria-label="Terminal process running"]`)
          .isDisplayed(),
      );
      activityStep(input, "host-return");
      await click(input, `${base} [data-center-panel-tab-activation]`);
      activityStep(input, "chat-open");
      chatAttempted = true;
      await panel("Claude");
      activityStep(input, "chat-compose");
      const composer =
        '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
      await click(input, composer);
      await input.browser.keys("Owned workspace substate chat");
      activityStep(input, "chat-send");
      await click(
        input,
        '[data-center-surface-host][data-visible="true"] button[aria-label="Send message"]',
      );
      activityStep(input, "chat-response");
      await input.owner.until(async () =>
        (
          await input.browser.$('[data-center-surface-host][data-visible="true"]').getText()
        ).includes("BiBCode deterministic streamed fixture response."),
      );
      activityStep(input, "host-restore");
      await click(input, `${base} [data-center-panel-tab-activation]`);
      activityStep(input, "terminal-hover");
      await input.browser
        .$(`[data-testid="thread-row-${input.threadId}"] [aria-label="Terminal process running"]`)
        .moveTo();
      activityStep(input, "capture");
      await input.capture("workspace-activity-lines");
    },
    async () => {
      const errors: unknown[] = [];
      const attempt = async (run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          errors.push(error);
        }
      };
      if (chatAttempted)
        await attempt(async () => {
          const count = await input.browser.$$(chat).length;
          if (count > 1) throw refused();
          if (count === 1) {
            await input.browser.$(chat).moveTo();
            await click(input, `${chat} button[aria-label^="Close "]`);
          }
        });
      if (terminalAttempted)
        await attempt(async () => {
          const count = await input.browser.$$(terminal).length;
          if (count > 1) throw refused();
          if (count === 1) {
            let interruptFailure: unknown;
            let interruptFailed = false;
            try {
              await click(input, `${terminal} [data-center-panel-tab-activation]`);
              await click(
                input,
                '[data-center-surface-host][data-visible="true"] [data-terminal-owner="center"] .xterm-screen',
              );
              await input.browser.keys(["Control", "c"]);
            } catch (error) {
              interruptFailed = true;
              interruptFailure = error;
            }
            await input.browser.$(terminal).moveTo();
            await click(input, `${terminal} button[aria-label^="Close "]`);
            if (interruptFailed) throw interruptFailure;
          }
        });
      await attempt(async () => {
        await click(input, `${base} [data-center-panel-tab-activation]`);
        await input.owner.until(
          async () =>
            (await input.browser.$$("[data-center-panel-tab-id]").length) === 1 &&
            !(await input.browser
              .$(
                `[data-testid="thread-row-${input.threadId}"] [aria-label="Terminal process running"]`,
              )
              .isDisplayed()) &&
            (await input.browser.execute((threadId) => {
              const row = document.querySelector(`[data-testid="thread-row-${threadId}"]`);
              return (
                row !== null &&
                !Array.from(row.querySelectorAll("span")).some((node) =>
                  /^\d+ more chats?$/.test(node.textContent?.trim() ?? ""),
                )
              );
            }, input.threadId)),
        );
      });
      if (errors.length) throw errors[0];
    },
  );
}

/** A separate three-substate batch; the original nine-scene core never calls this. */
export async function runWorkspaceSubstateBatch(
  input: WorkspaceSubstateFlowInput,
): Promise<object> {
  const focus = async (selector: string) => {
    if ((await input.browser.$$(selector).length) !== 1) throw refused();
    const control = input.browser.$(selector);
    await input.owner.until(async () => {
      if (await control.isFocused()) return true;
      await input.browser.keys("Tab");
      return control.isFocused();
    });
    await control.waitForDisplayed();
    await control.waitForEnabled();
    if ((await input.browser.$$(selector).length) !== 1 || !(await control.isFocused()))
      throw refused();
    await input.verifyManaged();
    await input.browser.keys("Enter");
  };
  await runWorkspaceActivityLines(input);
  await focus('[data-testid="git-manager-button"]');
  await click(input, '[aria-label="Worktree"]');
  await click(input, `//*[@role="option"][.//span[normalize-space()="${input.branch}"]]`);
  await click(input, '//button[@role="tab" and normalize-space()="History"]');
  await click(
    input,
    '//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]',
  );
  await runSelectedStashDiff(input);
  await focus(`[data-testid="thread-card-button-${input.threadId}"]`);
  await input.verifyManaged();
  if (!(await input.browser.$("[data-right-panel-tabbar]").isDisplayed()))
    await click(input, 'button[aria-label^="Toggle right panel"]');
  await click(input, '//button[.//span[normalize-space()="Files"] and not(@aria-disabled="true")]');
  await click(input, '[aria-label="Collapse all folders"]');
  const tree = input.browser.$("[data-preview-panel-mode] file-tree-container");
  for (const path of ["src/", "src/nested/", "src/nested/visual-note.ts"]) {
    const item = tree.shadow$(`[role="treeitem"][data-item-path="${path}"]`);
    await item.waitForDisplayed();
    await item.waitForEnabled();
    await input.verifyManaged();
    await item.click();
  }
  const gutter = input.browser
    .$("[data-preview-panel-mode] diffs-container")
    .shadow$('[data-gutter] [data-column-number="1"]');
  await gutter.waitForDisplayed();
  await input.verifyManaged();
  await gutter.click();
  const comment = input.browser.$('textarea[aria-label="Comment on lines L1"]');
  await comment.waitForDisplayed();
  await comment.waitForEnabled();
  await comment.setValue("Review this owned line");
  await click(input, '//button[normalize-space()="Comment"]');
  await runFilesItemContextMenu(input);
  return Object.freeze({
    existingRowsOnly: true,
    fixedSubstates: true,
    extraOriginals: true,
    completeGroup: false,
  });
}

export function validateWorkspaceSubstateJoins(captures: unknown, assertions: unknown): void {
  const data = (value: unknown, keys: readonly string[]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      NodeUtil.types.isProxy(value)
    )
      throw refused();
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === "string" && keys.includes(key))
    )
      throw refused();
    return Object.fromEntries(
      keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
        return [key, descriptor.value];
      }),
    );
  };
  if (
    !Array.isArray(captures) ||
    NodeUtil.types.isProxy(captures) ||
    captures.length !== 6 ||
    !Array.isArray(assertions) ||
    NodeUtil.types.isProxy(assertions) ||
    assertions.length !== 2
  )
    throw refused();
  const observed = new Set<string>(),
    themes = new Set<string>();
  for (const value of captures) {
    const item = data(value, [
      "scene",
      "substate",
      "theme",
      "file",
      "witness",
      "width",
      "height",
      "nonBlank",
      "sha256",
    ]);
    const selected = state(item.substate);
    const file = workspaceSubstateFileName(selected, item.theme);
    if (
      item.scene !== workspaceSubstateRows[selected] ||
      item.file !== file ||
      observed.has(file) ||
      item.width !== 1280 ||
      item.height !== 960 ||
      item.nonBlank !== true ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw refused();
    validateWorkspaceSubstate(selected, item.witness);
    observed.add(file);
  }
  for (const value of assertions) {
    const item = data(value, [
      "theme",
      "existingRowsOnly",
      "fixedSubstates",
      "extraOriginals",
      "completeGroup",
    ]);
    if (
      (item.theme !== "light" && item.theme !== "dark") ||
      themes.has(item.theme) ||
      item.existingRowsOnly !== true ||
      item.fixedSubstates !== true ||
      item.extraOriginals !== true ||
      item.completeGroup !== false
    )
      throw refused();
    themes.add(item.theme);
  }
}
