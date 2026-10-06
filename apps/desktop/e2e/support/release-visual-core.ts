import { observeOwnedBrowserAlert } from "./owned-browser-alert.ts";
import { readCoreImageDiffWitness } from "./release-visual-core-image.ts";
// @effect-diagnostics nodeBuiltinImport:off - Writes only finite original PNG evidence in the owned root.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { projectCoreCaptureFailureWitness } from "./release-visual-core-capture-facts.ts";
export {
  projectCoreCaptureFailureWitness,
  createCoreCaptureFailureObserver,
  readCoreCaptureFailureFacts,
  type CoreCaptureFailureRecord,
} from "./release-visual-core-capture-facts.ts";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import {
  validateVisualWitness,
  visualScreenshotName,
  type VisualScene,
} from "./release-visual-evidence.ts";
import {
  readVisualWitness,
  readVisualWorkingImageSelected,
  readVisualPageScroll,
  observeVisualNameClear,
  projectVisualNameClearObservation,
  type VisualObservationInput,
} from "./release-visual-observation.ts";
export interface VisualCaptureInput extends VisualObservationInput {
  browser: QualificationBrowser;
  owner: QualificationOwner;
  evidence: string;
  captured: Set<string>;
  observeFailure?: (error: unknown, witness: Readonly<Record<string, boolean>> | null) => void;
  /** Required for the owned image original; ordinary scene behavior remains unchanged. */
  verifyOwnedSource?: () => Promise<void>;
}
export async function captureVisualScene(input: VisualCaptureInput): Promise<object> {
  let latestFailureFacts: Readonly<Record<string, boolean>> | null = null;
  try {
    const file = visualScreenshotName(input.scene, input.theme);
    if (input.captured.has(file) || (await observeOwnedBrowserAlert(input.browser)))
      throw new Error("Visual capture refused.");
    const verifyImageSource = input.scene === "git-image-diff" ? input.verifyOwnedSource : null;
    if (input.scene === "git-image-diff" && typeof verifyImageSource !== "function")
      throw new Error("Owned image capture source refused.");
    if (verifyImageSource) await verifyImageSource();
    const readWitness: (value: VisualObservationInput) => Record<string, boolean> | null =
      input.scene === "git-image-diff" ? readCoreImageDiffWitness : readVisualWitness;
    const observation: VisualObservationInput = {
      scene: input.scene,
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    };
    let witness: Record<string, true> | undefined;
    await input.owner.until(async () => {
      const value = await bounded(input.browser.execute(readWitness, observation), 2_000);
      if (input.scene === "git-branch-menu" || input.scene === "command-palette")
        latestFailureFacts = projectCoreCaptureFailureWitness(input.scene, value);
      try {
        witness = validateVisualWitness(input.scene, value);
        return true;
      } catch {
        return false;
      }
    });
    const bytes = Buffer.from(await bounded(input.browser.takeScreenshot(), 5_000), "base64");
    if (verifyImageSource) await verifyImageSource();
    const finalWitness = await bounded(input.browser.execute(readWitness, observation), 2_000);
    if (input.scene === "git-branch-menu" || input.scene === "command-palette")
      latestFailureFacts = projectCoreCaptureFailureWitness(input.scene, finalWitness);
    validateVisualWitness(input.scene, finalWitness);
    const image = inspectScreenshot(bytes);
    if (image.width !== 1280 || image.height !== 960) throw new Error("Visual viewport refused.");
    NodeFS.writeFileSync(NodePath.join(input.evidence, file), bytes, { mode: 0o600, flag: "wx" });
    input.captured.add(file);
    return { scene: input.scene, theme: input.theme, file, witness, ...image };
  } catch (error) {
    try {
      input.observeFailure?.(error, latestFailureFacts);
    } catch {
      /* Optional facts cannot replace the original capture failure. */
    }
    throw error;
  }
}
export interface VisualCoreInput {
  browser: QualificationBrowser;
  owner: QualificationOwner;
  threadId: string;
  branch: string;
  step: (phase: string) => void;
  capture: (scene: VisualScene) => Promise<void>;
  openWorktreeDialog: () => Promise<void>;
  verifyManaged: () => Promise<void>;
  partialStageMatches: () => boolean;
  captureImageOriginal: (capture: () => Promise<void>) => Promise<void>;
  recordClearObservation?: (value: ReturnType<typeof projectVisualNameClearObservation>) => void;
}
/** One fixed nine-scene sequence. Every UI mutation is an ordinary WebDriver action. */
export async function runVisualCore(input: VisualCoreInput): Promise<object> {
  const { browser, owner, step } = input;
  const capture = async (scene: VisualScene) => {
    step(`visual-${scene}`);
    await input.capture(scene);
  };
  type PartialStageControl =
    | "changes-tab"
    | "text-row"
    | "first-run"
    | "stage-submit"
    | "staged-area";
  const observePartialAwait = (
    control: PartialStageControl | "index",
    operation: "displayed" | "enabled" | "click" | "proof",
  ) => {
    try {
      step("visual-partial-stage-" + control + "-" + operation);
    } catch {
      // Optional attribution cannot replace an existing action or outcome.
    }
  };
  const click = async (
    selector: string,
    control?: PartialStageControl,
    filesControl?: "card" | "right-panel" | "open" | "collapse" | "comment",
  ) => {
    const element = browser.$(selector);
    if (filesControl) step(`visual-files-${filesControl}-displayed`);
    if (control) observePartialAwait(control, "displayed");
    await element.waitForDisplayed();
    if (filesControl) step(`visual-files-${filesControl}-enabled`);
    if (control) observePartialAwait(control, "enabled");
    await element.waitForEnabled();
    if (filesControl) step(`visual-files-${filesControl}-click`);
    if (control) observePartialAwait(control, "click");
    await element.click();
  };
  const focus = async (selector: string, ready?: () => Promise<boolean>) => {
    if ((await browser.$$(selector).length) !== 1)
      throw new Error("Visual public control refused.");
    const element = browser.$(selector);
    const elementId = ready ? await element.elementId : undefined;
    if (ready && !elementId) throw new Error("Visual public control refused.");
    await owner.until(async () => {
      if (ready && !(await ready())) return false;
      if (await element.isFocused()) return true;
      await browser.keys("Tab");
      return element.isFocused();
    });
    await element.waitForDisplayed();
    await element.waitForEnabled();
    if (
      (await browser.$$(selector).length) !== 1 ||
      !(await element.isFocused()) ||
      (ready && ((await element.elementId) !== elementId || !(await ready())))
    )
      throw new Error("Visual public control refused.");
    return element;
  };
  const clearOwnedInput = async (selector: string) => {
    const field = await focus(selector);
    const fieldId = field.elementId;
    if (!fieldId) throw new Error("Visual public control refused.");
    await browser.keys(["Control", "a"]);
    if (
      (await browser.$$(selector).length) !== 1 ||
      !(await field.isFocused()) ||
      field.elementId !== fieldId
    )
      throw new Error("Visual public control refused.");
    await browser.keys("Backspace");
  };
  const composer =
    '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
  const card = `[data-testid="thread-card-button-${input.threadId}"]`;
  await input.verifyManaged();
  await capture("workspace-composite");

  step("visual-menu-open");
  await focus(card);
  await browser.keys(["Shift", "F10"]);
  await browser.$('[role="menu"]').waitForDisplayed();
  await browser.keys("Home");
  await capture("workspace-card-menu");
  await browser.keys("Escape");
  await browser.$('[role="menu"]').waitForDisplayed({ reverse: true });

  step("visual-create-ref-open");
  await input.openWorktreeDialog();
  const popup = '[data-slot="dialog-popup"][role="dialog"]';
  await click('//*[@data-slot="dialog-popup"]//button[normalize-space()="Branch"]');
  const clearInput = {
    origin: "http://127.0.0.1:4885",
    threadId: input.threadId,
    admission: NodeCrypto.randomUUID(),
  };
  let observedStart = false;
  if (input.recordClearObservation) {
    try {
      observedStart =
        (await bounded(
          browser.execute(observeVisualNameClear, { ...clearInput, operation: "start" as const }),
          2_000,
        )) === true;
    } catch {
      // Unavailable diagnostics never change the original public command.
    }
  }
  try {
    await clearOwnedInput(`${popup} input[placeholder="Worktree name"]`);
  } finally {
    if (input.recordClearObservation) {
      let observation = null;
      if (observedStart) {
        try {
          const value = await bounded(
            browser.execute(observeVisualNameClear, {
              ...clearInput,
              operation: "finish" as const,
              admitted: true,
            }),
            2_000,
          );
          observation = projectVisualNameClearObservation(value);
        } catch {
          // The original clear failure and existing cleanup remain authoritative.
        }
      }
      try {
        input.recordClearObservation(observation);
      } catch {
        // A diagnostic callback cannot replace the original public command result.
      }
    }
  }
  // Exact refs select automatically and remove their result row. Wait on the
  // derived name/reuse hint in the capture witness; do not click a vanished row.
  await browser.$(`${popup} input[aria-label="Create From"]`).setValue("visual-held");
  await capture("worktree-create-ref");
  await browser.keys("Escape");
  await browser.$(popup).waitForDisplayed({ reverse: true });
  await input.verifyManaged();

  step("visual-git-open");
  await focus('[data-testid="git-manager-button"]');
  await browser.keys("Enter");
  await click('[aria-label="Worktree"]');
  await click(`//*[@role="option"][.//span[normalize-space()="${input.branch}"]]`);
  await click('//button[@role="tab" and normalize-space()="Changes"]');
  step("visual-image-working-tree");
  await click('[role="option"][data-path="visual-swatch.png"]');
  await owner.until(async () =>
    bounded(browser.execute(readVisualWorkingImageSelected, { branch: input.branch }), 2_000),
  );
  // Image bytes are supported for commit diffs. Retain the binary working-tree
  // row check, then inspect the existing two-sided baseline through History.
  step("visual-image-inspect");
  await input.captureImageOriginal(() => capture("git-image-diff"));
  step("visual-partial-stage");
  await click('//button[@role="tab" and normalize-space()="Changes"]', "changes-tab");
  await click('[role="option"][data-path="pierre-step5.ts"]', "text-row");
  await click(
    'aside[aria-label="Partial staging selection gutter"] button[aria-label="Toggle changed-line run starting at line 1"]',
    "first-run",
  );
  await click(
    '//aside[@aria-label="Partial staging selection gutter"]//button[normalize-space()="Stage selected lines"]',
    "stage-submit",
  );
  observePartialAwait("index", "proof");
  await owner.until(async () => input.partialStageMatches());
  await click(
    '//section[@aria-label="Diff for pierre-step5.ts"]//button[normalize-space()="Staged"]',
    "staged-area",
  );
  await capture("git-changes-diff");

  step("visual-history-open");
  await click('//button[@role="tab" and normalize-space()="History"]');
  await click('//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]');
  await click('[aria-label="Toggle repository stashes"]');
  const lastStash = browser.$('button[aria-label="Select stash stash@{11}"]');
  await lastStash.waitForEnabled();
  const beforeScroll = await bounded(browser.execute(readVisualPageScroll), 2_000);
  await lastStash.scrollIntoView({ block: "end" });
  const afterScroll = await bounded(browser.execute(readVisualPageScroll), 2_000);
  if (beforeScroll.x !== afterScroll.x || beforeScroll.y !== afterScroll.y)
    throw new Error("Visual stash scroll escaped.");
  await capture("git-history-stashes");
  await click('[aria-label="Toggle repository stashes"]');

  step("visual-branches-open");
  await click('[aria-label="Choose branch"]');
  const branchFilter = browser.$('input[aria-label="Filter branches"]');
  await branchFilter.setValue("visual");
  await browser
    .$('button[aria-label="Check out remote branch origin/visual-held"]')
    .waitForDisplayed();
  await clearOwnedInput('input[aria-label="Filter branches"]');
  await focus('//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-held"]]', () =>
    browser.$('[aria-label="Branches"] [aria-label="Current branch"]').isDisplayed(),
  );
  await browser
    .$('//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-held"]]')
    .moveTo();
  await capture("git-branch-menu");
  step("visual-branches-close-escape");
  await browser.keys("Escape");
  step("visual-branches-close-hidden");
  await browser
    .$(
      '//*[@data-slot="popover-popup" and .//*[@aria-label="Branches"] and not(ancestor::*[@hidden])]',
    )
    .waitForDisplayed({ reverse: true });

  step("visual-files-open");
  // Card content intentionally receives pointer events above its sibling button.
  // Use standard button activation after the existing public focus admission.
  step("visual-files-card-focus");
  await focus(card);
  step("visual-files-card-enter");
  await browser.keys("Enter");
  step("visual-files-managed-identity");
  await input.verifyManaged();
  step("visual-files-panel-visible");
  if (!(await browser.$("[data-right-panel-tabbar]").isDisplayed()))
    await click('button[aria-label^="Toggle right panel"]', undefined, "right-panel");
  // The fresh owned thread has no right-panel surfaces. Missing empty-state controls refuse.
  await click(
    '//button[.//span[normalize-space()="Files"] and not(@aria-disabled="true")]',
    undefined,
    "open",
  );
  await click('[aria-label="Collapse all folders"]', undefined, "collapse");
  const tree = browser.$("[data-preview-panel-mode] file-tree-container");
  for (const [path, control] of [
    ["src/", "tree-src"],
    ["src/nested/", "tree-nested"],
    ["src/nested/visual-note.ts", "tree-file"],
  ] as const) {
    const entry = tree.shadow$(`[role="treeitem"][data-item-path="${path}"]`);
    step(`visual-files-${control}-displayed`);
    await entry.waitForDisplayed();
    step(`visual-files-${control}-click`);
    await entry.click();
  }
  const file = browser.$("[data-preview-panel-mode] diffs-container");
  const line = file.shadow$('[data-gutter] [data-column-number="1"]');
  step("visual-files-line-displayed");
  await line.waitForDisplayed();
  step("visual-files-line-click");
  await line.click();
  const comment = browser.$('textarea[aria-label="Comment on lines L1"]');
  step("visual-files-comment-input-displayed");
  await comment.waitForDisplayed();
  step("visual-files-comment-draft");
  await comment.setValue("Review this owned line");
  await click('//button[normalize-space()="Comment"]', undefined, "comment");
  await capture("files-editor-comment");

  step("visual-palette-open");
  await click('[data-testid="command-palette-trigger"]');
  const search = browser.$('[data-testid="command-palette"] [data-slot="autocomplete-input"]');
  await search.waitForDisplayed();
  await search.setValue("settings");
  // The query updates before deferred results. Navigate only the committed, focused result.
  await owner.until(async () => {
    if (
      (await browser.$$('[data-testid="command-palette"]').length) !== 1 ||
      (await browser.$$('[data-testid="command-palette"] [data-slot="command-item"]').length) !==
        1 ||
      (await search.getValue()) !== "settings" ||
      !(await search.isFocused())
    )
      return false;
    return browser
      .$(
        '//*[@data-testid="command-palette"]//*[@data-slot="command-item" and contains(normalize-space(.),"Open settings")]',
      )
      .isDisplayed();
  });
  await browser.keys("ArrowDown");
  await capture("command-palette");
  await browser.keys("Escape");
  await browser.$('[data-testid="command-palette"]').waitForDisplayed({ reverse: true });
  await input.verifyManaged();
  if ((await browser.$(composer).getText()).trim() !== "Owned visual review draft")
    throw new Error("Visual draft changed.");
  return {
    managedIdentityMatched: true,
    partialStageVerified: true,
    imageDiffInspected: true,
    dialogCancelled: true,
    draftRetained: true,
    noCommandExecuted: true,
    unpictured: ["files-context-menu", "workspace-terminal-and-other-chat"],
  };
}
