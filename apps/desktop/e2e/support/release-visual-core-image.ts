// @effect-diagnostics nodeBuiltinImport:off - Closed admission for one owned image original.
import * as NodeUtil from "node:util";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { validateCaptureWitness } from "./remote-ui-evidence.ts";

export const coreImageSceneFacts = [
  "selectedBaseline",
  "selectedImage",
  "loadedImages",
  "beforeAfterVisible",
  "twoUpMode",
] as const;
const common = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
export const coreImageWitnessKeys = [...common, ...coreImageSceneFacts] as const;
export interface CoreImageObservation {
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}
export interface CoreImageOriginalInput extends CoreImageObservation {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until" | "cleanup">;
  /** Existing immutable owned Git identity; this must not substitute a chat-route check. */
  verifyOwnedSource: () => Promise<void>;
  /** The existing original-PNG owner, including source and witness checks around screenshot. */
  capture: () => Promise<void>;
  step: (phase: string) => void;
}

export function coreImageScreenshotName(theme: string): string {
  if (theme !== "light" && theme !== "dark") throw new Error("Unknown image visual capture.");
  return "git-image-diff-" + theme + ".png";
}
/** Plain exact true data only. Refuse proxies before reflection, and never invoke an accessor. */
export function validateCoreImageDiffWitness(input: unknown): Record<string, true> {
  const refused = () => new Error("Image visual precondition failed.");
  if (!input || typeof input !== "object" || NodeUtil.types.isProxy(input) || Array.isArray(input))
    throw refused();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== coreImageWitnessKeys.length ||
    !keys.every(
      (key) => typeof key === "string" && coreImageWitnessKeys.some((allowed) => allowed === key),
    )
  )
    throw refused();
  for (const key of coreImageWitnessKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value !== true)
      throw refused();
  }
  validateCaptureWitness(Object.fromEntries(common.map((key) => [key, true])));
  return Object.fromEntries(coreImageWitnessKeys.map((key) => [key, true]));
}

/** Serialized standalone reader; only eleven booleans leave the owned page. */
export function readCoreImageDiffWitness(
  input: CoreImageObservation,
): Record<string, boolean> | null {
  try {
    const route = /^\/project\/local\/([A-Za-z0-9._:-]{1,128})\/git$/.exec(location.pathname);
    if (
      input.origin !== "http://127.0.0.1:4885" ||
      location.origin !== input.origin ||
      location.search !== "" ||
      location.hash !== "" ||
      route === null ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
      (input.theme !== "light" && input.theme !== "dark") ||
      document.documentElement.classList.contains("dark") !== (input.theme === "dark") ||
      input.branch !== "codex/delivery-retry-" + input.theme ||
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) !== null ||
      document.getElementById("boot-shell") !== null ||
      document.querySelector("vite-error-overlay") !== null
    )
      return null;
    const headers = document.querySelectorAll("header[data-environment-id][data-project-id]");
    const rails = document.querySelectorAll('[data-testid="environment-rail-local"]');
    const worktrees = document.querySelectorAll('[aria-label="Worktree"]');
    const branches = document.querySelectorAll('[aria-label="Choose branch"]');
    const cards = document.querySelectorAll(
      '[data-testid="thread-card-button-' + input.threadId + '"]',
    );
    const rows = document.querySelectorAll('[data-testid="thread-row-' + input.threadId + '"]');
    if (
      headers.length !== 1 ||
      headers[0]!.getAttribute("data-environment-id") !== "local" ||
      headers[0]!.getAttribute("data-project-id") !== route[1] ||
      rails.length !== 1 ||
      rails[0]!.getAttribute("aria-checked") !== "true" ||
      rails[0]!.querySelector('[data-status="connected"]') === null ||
      worktrees.length !== 1 ||
      branches.length !== 1 ||
      !headers[0]!.contains(worktrees[0]!) ||
      !headers[0]!.contains(branches[0]!) ||
      worktrees[0]!.textContent?.trim() !== input.branch ||
      branches[0]!.textContent?.trim() !== input.branch ||
      cards.length !== 1 ||
      rows.length !== 1 ||
      !rows[0]!.contains(cards[0]!)
    )
      return null;
    const visible = (element: Element | null): element is HTMLElement => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (
        ![rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(
          Number.isFinite,
        ) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        return false;
      let ancestor: Element | null = element;
      for (let inspected = 0; ancestor !== null && inspected < 32; inspected++) {
        if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert")) return false;
        const style = getComputedStyle(ancestor);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        )
          return false;
        ancestor = ancestor.parentElement;
      }
      return ancestor === null;
    };
    if (![headers[0]!, rails[0]!, worktrees[0]!, branches[0]!, cards[0]!, rows[0]!].every(visible))
      return null;
    const inView = (element: Element | null): boolean => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight)
        return false;
      for (
        let ancestor = element.parentElement;
        ancestor !== null;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor),
          clip = ancestor.getBoundingClientRect();
        const clipsX = [style.overflowX, style.overflow].some((value) =>
          ["auto", "scroll", "hidden", "clip"].includes(value),
        );
        const clipsY = [style.overflowY, style.overflow].some((value) =>
          ["auto", "scroll", "hidden", "clip"].includes(value),
        );
        if (
          (clipsX &&
            (![clip.left, clip.right].every(Number.isFinite) ||
              rect.left < clip.left ||
              rect.right > clip.right)) ||
          (clipsY &&
            (![clip.top, clip.bottom].every(Number.isFinite) ||
              rect.top < clip.top ||
              rect.bottom > clip.bottom))
        )
          return false;
      }
      return true;
    };
    const single = (scope: ParentNode, selector: string): Element | null => {
      const values = scope.querySelectorAll(selector);
      return values.length === 1 ? values[0]! : null;
    };
    const history = single(document, 'section[aria-label="Repository history"]');
    const pane = history ? single(history, 'section[aria-label="Image diff"]') : null;
    if (
      !history ||
      !pane ||
      document.querySelectorAll('section[aria-label="Image diff"]').length !== 1
    )
      return null;
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(
      (node) => node.textContent?.trim() === "History",
    );
    const selectedCommits = history.querySelectorAll(
      '[aria-label="Commit history"] button[role="option"][aria-selected="true"]',
    );
    const selectedBaseline =
      tabs.length === 1 &&
      tabs[0]!.getAttribute("aria-selected") === "true" &&
      selectedCommits.length === 1 &&
      selectedCommits[0]!.getAttribute("aria-label")?.includes("Visual qualification baseline") ===
        true &&
      visible(selectedCommits[0]!);
    const changedLists = history.querySelectorAll('[aria-label="Changed files"][role="listbox"]');
    const selectedFiles =
      changedLists.length === 1
        ? changedLists[0]!.querySelectorAll('button[role="option"][aria-selected="true"]')
        : [];
    const selectedImage =
      selectedFiles.length === 1 &&
      selectedFiles[0]!.getAttribute("data-changed-file-path") === "visual-swatch.png" &&
      visible(selectedFiles[0]!);
    const images = Array.from(pane.querySelectorAll("img"));
    const before = images.filter((node) => node.alt === "Before image"),
      after = images.filter((node) => node.alt === "After image");
    const sources = images.map((node) => node.getAttribute("src"));
    const loadedImages =
      images.length === 2 &&
      before.length === 1 &&
      after.length === 1 &&
      sources.every(
        (value) =>
          typeof value === "string" &&
          value.length <= 2048 &&
          /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value),
      ) &&
      sources[0] !== sources[1] &&
      images.every(
        (node) => node.complete && node.naturalWidth === 64 && node.naturalHeight === 64,
      );
    const figures = Array.from(pane.querySelectorAll("figure"));
    const beforeAfterVisible =
      figures.length === 2 &&
      ["Before", "After"].every((label) => {
        const matches = figures.filter(
          (figure) => figure.querySelector("figcaption")?.textContent?.trim() === label,
        );
        return (
          matches.length === 1 &&
          matches[0]!.querySelectorAll('img[alt="' + label + ' image"]').length === 1 &&
          inView(matches[0]!) &&
          inView(matches[0]!.querySelector("figcaption")) &&
          inView(matches[0]!.querySelector("img"))
        );
      });
    const groups = pane.querySelectorAll('[role="group"][aria-label="Image diff mode"]');
    const modes = groups.length === 1 ? Array.from(groups[0]!.querySelectorAll("button")) : [];
    const twoUpMode =
      modes.length === 4 &&
      ["2-up", "Swipe", "Onion-skin", "Difference"].every((label) => {
        const matches = modes.filter((node) => node.textContent?.trim() === label);
        return (
          matches.length === 1 &&
          !matches[0]!.disabled &&
          matches[0]!.getAttribute("aria-pressed") === (label === "2-up" ? "true" : "false")
        );
      });
    const rect = pane.getBoundingClientRect();
    const unobstructed = [
      [rect.left + rect.width / 2, rect.top + 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.bottom - 2],
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (hit === pane || pane.contains(hit));
    });
    const noOtherDialog = !Array.from(
      document.querySelectorAll('[data-slot="dialog-popup"][role="dialog"]'),
    ).some(visible);
    const targetInView =
      innerWidth === 1280 &&
      innerHeight === 960 &&
      inView(pane) &&
      images.every(inView) &&
      modes.every(inView) &&
      unobstructed &&
      noOtherDialog;
    return {
      themeMatched: true,
      selectedMatched: true,
      expectedTextMatched:
        selectedBaseline && selectedImage && loadedImages && beforeAfterVisible && twoUpMode,
      targetInView,
      credentialAbsent: true,
      bootShellAbsent: true,
      selectedBaseline,
      selectedImage,
      loadedImages,
      beforeAfterVisible,
      twoUpMode,
    };
  } catch {
    return null;
  }
}

/** One original through actual public controls, with immutable source verified on both outcomes. */
export async function runCoreImageDiffOriginal(input: CoreImageOriginalInput): Promise<void> {
  await input.verifyOwnedSource();
  let sourceMatched = false;
  try {
    const click = async (selector: string) => {
      if ((await input.browser.$$(selector).length) !== 1)
        throw new Error("Owned image control refused.");
      const element = input.browser.$(selector);
      await element.waitForDisplayed();
      await element.waitForEnabled();
      await element.click();
    };
    input.step("visual-image-history");
    await click('//button[@role="tab" and normalize-space()="History"]');
    await click(
      '//*[@aria-label="Commit history"]//button[@role="option" and contains(@aria-label,"Visual qualification baseline")]',
    );
    await click(
      '[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]',
    );
    await click('//*[@aria-label="Image diff mode"]//button[normalize-space()="2-up"]');
    const observation: CoreImageObservation = {
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    };
    await input.owner.until(async () => {
      const value = await bounded(
        input.browser.execute(readCoreImageDiffWitness, observation),
        2_000,
      );
      try {
        validateCoreImageDiffWitness(value);
        return true;
      } catch {
        return false;
      }
    });
    input.step("visual-git-image-diff");
    await input.capture();
  } finally {
    await input.owner.cleanup("visual-owned-image-source", async () => {
      await input.verifyOwnedSource();
      sourceMatched = true;
    });
  }
  if (!sourceMatched) throw new Error("Owned image source verification failed.");
}
