// @effect-diagnostics nodeBuiltinImport:off - Writes only finite original PNG evidence in the owned root.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { projectCoreBranchCaptureFailureWitness } from "./release-visual-core-capture-facts.ts";
export {
  projectCoreBranchCaptureFailureWitness,
  createCoreBranchCaptureFailureObserver,
  readCoreBranchCaptureFailureFacts,
  type CoreBranchCaptureFailureRecord,
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
  readVisualImageLoaded,
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
}
export async function captureVisualScene(input: VisualCaptureInput): Promise<object> {
  let latestFailureFacts: Readonly<Record<string, boolean>> | null = null;
  try {
    const file = visualScreenshotName(input.scene, input.theme);
    if (input.captured.has(file) || (await input.browser.isAlertOpen()))
      throw new Error("Visual capture refused.");
    const observation: VisualObservationInput = {
      scene: input.scene,
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    };
    let witness: Record<string, true> | undefined;
    await input.owner.until(async () => {
      const value = await bounded(input.browser.execute(readVisualWitness, observation), 2_000);
      if (input.scene === "git-branch-menu")
        latestFailureFacts = projectCoreBranchCaptureFailureWitness(value);
      try {
        witness = validateVisualWitness(input.scene, value);
        return true;
      } catch {
        return false;
      }
    });
    const bytes = Buffer.from(await bounded(input.browser.takeScreenshot(), 5_000), "base64");
    const finalWitness = await bounded(
      input.browser.execute(readVisualWitness, observation),
      2_000,
    );
    if (input.scene === "git-branch-menu")
      latestFailureFacts = projectCoreBranchCaptureFailureWitness(finalWitness);
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
  recordClearObservation?: (value: ReturnType<typeof projectVisualNameClearObservation>) => void;
}
/** One fixed eight-scene sequence. Every UI mutation is an ordinary WebDriver action. */
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
  const click = async (selector: string, control?: PartialStageControl) => {
    const element = browser.$(selector);
    if (control) observePartialAwait(control, "displayed");
    await element.waitForDisplayed();
    if (control) observePartialAwait(control, "enabled");
    await element.waitForEnabled();
    if (control) observePartialAwait(control, "click");
    await element.click();
  };
  const focus = async (selector: string) => {
    if ((await browser.$$(selector).length) !== 1)
      throw new Error("Visual public control refused.");
    const element = browser.$(selector);
    await owner.until(async () => {
      if (await element.isFocused()) return true;
      await browser.keys("Tab");
      return element.isFocused();
    });
    await element.waitForDisplayed();
    await element.waitForEnabled();
    if ((await browser.$$(selector).length) !== 1 || !(await element.isFocused()))
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
  await click('//button[@role="tab" and normalize-space()="History"]');
  await click('//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]');
  await click(
    '[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]',
  );
  await owner.until(async () => bounded(browser.execute(readVisualImageLoaded), 2_000));
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
  await browser
    .$('//*[@aria-label="Branches"]//button[.//span[normalize-space()="visual-held"]]')
    .moveTo();
  await capture("git-branch-menu");
  await browser.keys("Escape");

  step("visual-files-open");
  await click(card);
  await input.verifyManaged();
  if (!(await browser.$("[data-right-panel-tabbar]").isDisplayed()))
    await click('button[aria-label^="Toggle right panel"]');
  // The fresh owned thread has no right-panel surfaces. Missing empty-state controls refuse.
  await click('//button[.//span[normalize-space()="Files"] and not(@aria-disabled="true")]');
  await click('[aria-label="Collapse all folders"]');
  const tree = browser.$("[data-preview-panel-mode] file-tree-container");
  for (const path of ["src/", "src/nested/", "src/nested/visual-note.ts"]) {
    const entry = tree.shadow$(`[role="treeitem"][data-item-path="${path}"]`);
    await entry.waitForDisplayed();
    await entry.click();
  }
  const file = browser.$("[data-preview-panel-mode] diffs-container");
  const line = file.shadow$('[data-gutter] [data-column-number="1"]');
  await line.waitForDisplayed();
  await line.click();
  const comment = browser.$('textarea[aria-label="Comment on lines 1"]');
  await comment.waitForDisplayed();
  await comment.setValue("Review this owned line");
  await click('//button[normalize-space()="Comment"]');
  await capture("files-editor-comment");

  step("visual-palette-open");
  await click('[data-testid="command-palette-trigger"]');
  const search = browser.$('[data-testid="command-palette"] [data-slot="autocomplete-input"]');
  await search.waitForDisplayed();
  await search.setValue("settings");
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
    unpictured: ["git-image-diff", "files-context-menu", "workspace-terminal-and-other-chat"],
  };
}
