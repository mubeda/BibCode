// @effect-diagnostics nodeBuiltinImport:off - Finite original PNG evidence owned by the existing qualification controller.
import * as NodeUtil from "node:util";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { validateCaptureWitness } from "./remote-ui-evidence.ts";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import { providerChatFixturePrompts } from "./release-visual-provider-chat-fixture.ts";
import type { ProviderChatWorkspaceLossScope } from "./release-visual-provider-chat-loss.ts";

export const providerChatScenes = [
  "chat-held-workspace-loss",
  "chat-refused-model",
  "chat-markdown-plan",
  "activity-narrow",
  "question-multiselect",
  "context-popover",
  "mcp-popover",
  "composer-command-menu",
] as const;
export type ProviderChatScene = (typeof providerChatScenes)[number];
export interface ProviderChatInput {
  scene: ProviderChatScene;
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}

/** Public selection proof only; no text, option values or renderer state leaves the browser. */
export function readOwnedCodexVisualSelection(input: ProviderChatInput) {
  if (
    input.scene !== "chat-refused-model" ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.pathname !== "/local/" + input.threadId ||
    location.search ||
    location.hash ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
    !["light", "dark"].includes(input.theme) ||
    input.branch !== "codex/delivery-retry-" + input.theme ||
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
    ) ||
    document.getElementById("boot-shell") ||
    document.querySelector("vite-error-overlay")
  )
    return null;
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
  const card = one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`);
  const branchIds = (card?.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id.endsWith("-branch"));
  const surface = one('[data-center-surface-host][data-visible="true"]');
  const model = surface?.querySelector('[data-chat-provider-model-picker="true"]') ?? null;
  return {
    contextMatched:
      card !== null &&
      surface !== null &&
      branchIds.length === 1 &&
      document
        .getElementById(branchIds[0]!)
        ?.querySelector('[data-slot="tooltip-trigger"]')
        ?.textContent?.trim() === input.branch &&
      document.documentElement.classList.contains("dark") === (input.theme === "dark") &&
      one('[data-testid="environment-rail-local"]')?.getAttribute("aria-checked") === "true" &&
      one('[data-testid="environment-rail-local"] [data-status="connected"]') !== null &&
      Array.from(
        document.querySelectorAll('[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]'),
      ).filter(visible).length === 0,
    codexModelMatched:
      model !== null &&
      visible(model) &&
      surface?.querySelectorAll('[data-chat-provider-model-picker="true"]').length === 1 &&
      model.getAttribute("aria-label") === "Codex · GPT-5.4",
    highSelected:
      surface?.querySelectorAll('button[aria-label="Reasoning effort: High"]').length === 1 &&
      one(
        '[data-center-surface-host][data-visible="true"] button[aria-label="Reasoning effort: High"]',
      ) !== null,
  };
}

function ownedCodexSelection(input: unknown) {
  try {
    const keys = ["contextMatched", "codexModelMatched", "highSelected"];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      NodeUtil.types.isProxy(input) ||
      Reflect.ownKeys(input).length !== keys.length
    )
      return null;
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (
        !property?.enumerable ||
        !Object.hasOwn(property, "value") ||
        typeof property.value !== "boolean"
      )
        return null;
      result[key] = property.value;
    }
    return result.contextMatched === true && result.codexModelMatched === true ? result : null;
  } catch {
    return null;
  }
}

/** Selects the real supported High radio item before the separate catalog-refusal owner is armed. */
export async function selectOwnedCodexVisualHigh(
  input: ProviderChatInput & {
    browser: QualificationBrowser;
    owner: Pick<QualificationOwner, "until">;
    verifyOwnedIdentity: () => Promise<void>;
  },
) {
  const refused = () => new Error("Owned public Codex High selection refused.");
  const read = async () => {
    const result = ownedCodexSelection(
      await bounded(
        input.browser.execute(readOwnedCodexVisualSelection, {
          scene: input.scene,
          theme: input.theme,
          origin: input.origin,
          threadId: input.threadId,
          branch: input.branch,
        }),
        2_000,
      ),
    );
    if (!result) throw refused();
    return result;
  };
  await input.verifyOwnedIdentity();
  if (!(await read()).highSelected) {
    const click = async (selector: string) => {
      const node = input.browser.$(selector);
      await node.waitForDisplayed();
      if ((await input.browser.$$(selector).length) !== 1) throw refused();
      await node.waitForEnabled();
      await node.click();
    };
    await click(
      '[data-center-surface-host][data-visible="true"] button[aria-label^="Reasoning effort:"]',
    );
    await click(
      '//*[@role="menuitemradio"][.//span[@data-effort-title="true" and normalize-space()="High"]]',
    );
    await input.owner.until(async () => (await read()).highSelected === true);
  }
  await input.verifyOwnedIdentity();
}
const common = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
  "providerMatched",
  "unrelatedModalAbsent",
];
const sceneFacts: Record<ProviderChatScene, readonly string[]> = {
  "chat-held-workspace-loss": [
    "partialReply",
    "queueHeld",
    "workingEnded",
    "draftRetained",
    "worktreeWarning",
  ],
  "chat-refused-model": [
    "refusalNotice",
    "correctionGuidance",
    "queueHeld",
    "noRetry",
    "draftRetained",
    "instanceNamed",
  ],
  "chat-markdown-plan": [
    "markdownRendered",
    "codeControls",
    "tableControls",
    "planVisible",
    "planSteps",
    "changedFiles",
    "imageLoaded",
    "draftRetained",
  ],
  "activity-narrow": [
    "expandedDock",
    "actorVisible",
    "toolVisible",
    "elapsedVisible",
    "noComposerOverlap",
  ],
  "question-multiselect": ["laterQuestion", "twoChoices", "explicitSubmit"],
  "context-popover": ["usageCounts", "contextMeter", "instanceNamed"],
  "mcp-popover": ["longName", "statuses", "unavailableExplanation"],
  "composer-command-menu": ["selectedSuggestion", "suggestionDescription", "draftRetained"],
};
export function providerChatScreenshotName(scene: string, theme: string): string {
  if (!providerChatScenes.some((name) => name === scene) || !["light", "dark"].includes(theme))
    throw new Error("Owned provider visual filename refused.");
  return `${scene}-${theme}.png`;
}
export function providerChatViewport(scene: ProviderChatScene) {
  return scene === "activity-narrow" ? { width: 960, height: 800 } : { width: 1280, height: 960 };
}
/** Closed capture record for the existing root writer; missing/private/accessor fields refuse. */
export function projectProviderChatCapture(input: unknown) {
  try {
    const keys = ["scene", "theme", "file", "witness", "width", "height", "nonBlank", "sha256"];
    if (
      !input ||
      typeof input !== "object" ||
      NodeUtil.types.isProxy(input) ||
      Array.isArray(input) ||
      Reflect.ownKeys(input).length !== keys.length
    )
      throw new Error();
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new Error();
      row[key] = field.value;
    }
    if (
      typeof row.scene !== "string" ||
      typeof row.theme !== "string" ||
      row.file !== providerChatScreenshotName(row.scene, row.theme)
    )
      throw new Error();
    const scene = providerChatScenes.find((name) => name === row.scene);
    if (scene === undefined) throw new Error();
    const expected = providerChatViewport(scene);
    if (
      row.width !== expected.width ||
      row.height !== expected.height ||
      row.nonBlank !== true ||
      typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sha256)
    )
      throw new Error();
    return {
      scene,
      theme: row.theme,
      file: row.file,
      witness: validateProviderChatWitness(scene, row.witness),
      width: expected.width,
      height: expected.height,
      nonBlank: true,
      sha256: row.sha256,
    };
  } catch {
    throw new Error("Owned provider visual capture record refused.");
  }
}
/** Only exact enumerable all-true data fields enter a capture receipt. */
export function validateProviderChatWitness(
  scene: ProviderChatScene,
  input: unknown,
): Record<string, true> {
  try {
    if (
      !providerChatScenes.includes(scene) ||
      scene === "question-multiselect" ||
      !input ||
      typeof input !== "object" ||
      NodeUtil.types.isProxy(input) ||
      Array.isArray(input)
    )
      throw new Error();
    const keys = [...common, ...sceneFacts[scene]];
    if (Reflect.ownKeys(input).length !== keys.length) throw new Error();
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property?.enumerable || !Object.hasOwn(property, "value") || property.value !== true)
        throw new Error();
    }
    validateCaptureWitness(Object.fromEntries(common.slice(0, 6).map((key) => [key, true])));
    return Object.fromEntries(keys.map((key) => [key, true]));
  } catch {
    throw new Error("Owned provider visual witness refused.");
  }
}
/** Standalone serialized read-only observer; no page text, state or identity is returned. */
export function readProviderChatWitness(input: ProviderChatInput): Record<string, boolean> | null {
  const scenes = [
    "chat-held-workspace-loss",
    "chat-refused-model",
    "chat-markdown-plan",
    "activity-narrow",
    "question-multiselect",
    "context-popover",
    "mcp-popover",
    "composer-command-menu",
  ];
  if (
    !input ||
    !scenes.includes(input.scene) ||
    input.scene === "question-multiselect" ||
    !["light", "dark"].includes(input.theme) ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
    location.pathname !== "/local/" + input.threadId ||
    !/^codex\/delivery-retry-(light|dark)$/.test(input.branch)
  )
    return null;
  const visible = (node: Element | null): node is HTMLElement => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number.parseFloat(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const matches = all(selector);
    return matches.length === 1 ? matches[0]! : null;
  };
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const surface = one('[data-center-surface-host][data-visible="true"]');
  const message = (expected: string) => {
    const matches = all(
      '[data-center-surface-host][data-visible="true"] [data-message-role="user"], [data-center-surface-host][data-visible="true"] [data-queued-message-row]',
    ).filter((node) => text(node).includes(expected));
    return matches.length === 1 ? matches[0]! : null;
  };
  const editor = one(
    '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]',
  );
  const draft = text(editor) === "Owned visual review draft",
    surfaceText = text(surface);
  const provider = one(
    '[data-center-surface-host][data-visible="true"] [data-chat-provider-model-picker="true"]',
  );
  const requiredProvider = [
    "activity-narrow",
    "chat-held-workspace-loss",
    "chat-refused-model",
  ].includes(input.scene)
    ? "Codex"
    : "Claude";
  const providerMatched = (
    text(provider) +
    " " +
    (provider?.getAttribute("aria-label") ?? "")
  ).includes(requiredProvider);
  let target: Element | null = surface;
  const additionalTargets: Element[] = [];
  let facts: Record<string, boolean>;
  switch (input.scene) {
    case "chat-held-workspace-loss": {
      const held = message("Owned visual partial reply [[slow]]"),
        queued = message("Owned visual message waiting behind partial reply");
      const partial =
        all('[data-center-surface-host][data-visible="true"] [data-message-role="assistant"]').find(
          (node) =>
            held !== null &&
            queued !== null &&
            node.getBoundingClientRect().top >= held.getBoundingClientRect().bottom &&
            node.getBoundingClientRect().bottom <= queued.getBoundingClientRect().top &&
            text(node).includes("BiBCode deterministic streamed fixture response."),
        ) ?? null;
      if (held) additionalTargets.push(held);
      if (queued) additionalTargets.push(queued);
      if (partial) additionalTargets.push(partial);
      facts = {
        partialReply: partial !== null,
        queueHeld:
          queued !== null &&
          queued.hasAttribute("data-queued-message-row") &&
          text(queued).includes("Waiting for you"),
        workingEnded:
          all('[data-center-surface-host][data-visible="true"] [data-timeline-row-kind="working"]')
            .length === 0 &&
          all(
            '[data-center-surface-host][data-visible="true"] button[aria-label="Stop generation"]',
          ).length === 0,
        draftRetained: draft,
        worktreeWarning: text(
          one(`[data-testid="worktree-availability-${input.threadId}"]`),
        ).includes("The worktree directory is missing. Git registration remains."),
      };
      break;
    }
    case "chat-refused-model": {
      const refused = message("Owned visual refused option"),
        queued = message("Owned visual message waiting behind refusal");
      if (refused) additionalTargets.push(refused);
      if (queued) additionalTargets.push(queued);
      facts = {
        refusalNotice:
          text(refused).includes("Delivery failed") &&
          refused?.querySelector('button[aria-label="Dismiss and skip this message"]') !== null &&
          refused !== null,
        correctionGuidance: text(refused).includes("another model or without that option"),
        queueHeld:
          queued !== null &&
          (queued.hasAttribute("data-queued-message-row")
            ? text(queued).includes("Waiting for an earlier message") &&
              queued
                .querySelector("button[data-queued-message-send-now]")
                ?.getAttribute("aria-description") === "Dismiss the earlier message first"
            : text(queued).includes(
                "Waiting for an earlier message. Dismiss it to send this one.",
              )),
        noRetry:
          refused !== null &&
          refused.querySelector('button[aria-label="Retry message delivery"]') === null,
        draftRetained: draft,
        instanceNamed: text(refused).includes("Codex"),
      };
      break;
    }
    case "chat-markdown-plan": {
      const image = one('img[alt="Owned visual swatch"]'),
        plan = one('button[aria-label="Plan actions"]');
      const planPane = plan?.closest('div[class~="bg-card/50"]') ?? null;
      if (image) additionalTargets.push(image);
      if (planPane) additionalTargets.push(planPane);
      facts = {
        markdownRendered:
          surfaceText.includes("Owned visual response") &&
          all('button[aria-label="Toggle task"]').length > 0,
        codeControls:
          one('button[aria-label="Copy code"]') !== null &&
          one('button[aria-label="Wrap lines"]') !== null &&
          one('[aria-label="Language: typescript"]') !== null,
        tableControls:
          one('button[aria-label="Copy table"]') !== null &&
          one('button[aria-label="Expand table cells"]') !== null,
        planVisible:
          plan !== null && visible(planPane) && text(planPane).includes("Owned visual plan"),
        planSteps:
          text(planPane).includes("Observe the fixture") &&
          text(planPane).includes("Review the result"),
        changedFiles:
          surfaceText.includes("changed files") &&
          surfaceText.includes("visual-chat.ts") &&
          all("button").some((node) => text(node) === "View diff"),
        imageLoaded:
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth === 64 &&
          image.naturalHeight === 64,
        draftRetained: draft,
      };
      break;
    }
    case "activity-narrow": {
      target = one("[data-activity-panel]");
      const dock = one('[data-testid="activity-dock"]'),
        dockBox = dock?.getBoundingClientRect(),
        composerBox = editor?.getBoundingClientRect();
      if (dock) additionalTargets.push(dock);
      facts = {
        expandedDock:
          one('button[aria-label^="Collapse activity summary"][aria-expanded="true"]') !== null,
        actorVisible: text(one("[data-activity-detail-heading]")).includes("Fixture reviewer"),
        toolVisible: all('[data-activity-entry-kind="tool"]').some((node) => text(node).length > 0),
        elapsedVisible:
          all('[data-activity-section-metadata="subagents"]').some((node) =>
            /\d/.test(text(node)),
          ) && (target?.querySelectorAll("time[datetime]").length ?? 0) > 0,
        noComposerOverlap:
          !!dockBox &&
          !!composerBox &&
          (dockBox.bottom <= composerBox.top ||
            dockBox.top >= composerBox.bottom ||
            dockBox.right <= composerBox.left ||
            dockBox.left >= composerBox.right),
      };
      break;
    }
    case "context-popover": {
      target = one('[data-slot="popover-popup"]');
      const meters = Array.from(
        target?.querySelectorAll('[role="progressbar"][aria-label="Context window usage"]') ?? [],
      ).filter(visible);
      const meter = meters.length === 1 ? meters[0]! : null;
      facts = {
        usageCounts: text(target).includes("31k/200k") && text(target).includes("16%"),
        contextMeter: meter?.getAttribute("aria-valuenow") === "16",
        instanceNamed: text(target).includes("Claude automatically compacts"),
      };
      break;
    }
    case "mcp-popover":
      target = one('[data-slot="popover-popup"]');
      facts = {
        longName: text(target).includes("owned-visual-mcp-server-with-a-long-name-that-wraps"),
        statuses: text(target).includes("Connected") && text(target).includes("Error"),
        unavailableExplanation: text(target).includes("Owned fixture endpoint is unavailable."),
      };
      break;
    case "composer-command-menu": {
      target = one('[data-composer-menu="true"][data-composer-menu-loading="false"]');
      const active = one('[data-composer-menu="true"] [data-composer-item-active="true"]');
      facts = {
        selectedSuggestion: active !== null && text(active).includes("/compact"),
        suggestionDescription: text(active).includes("Compact the deterministic fixture context."),
        draftRetained: text(editor) === "/comp",
      };
      break;
    }
    default:
      return null;
  }
  const critical: Record<string, string[]> = {
    "chat-held-workspace-loss": [`[data-testid="worktree-availability-${input.threadId}"]`],
    "chat-refused-model": ['button[aria-label="Dismiss and skip this message"]'],
    "chat-markdown-plan": [
      'button[aria-label="Copy code"]',
      'button[aria-label="Wrap lines"]',
      'button[aria-label="Copy table"]',
      'button[aria-label="Expand table cells"]',
      'button[aria-label="Toggle task"]',
    ],
    "activity-narrow": [
      "[data-activity-detail-heading]",
      '[data-activity-entry-kind="tool"]',
      '[data-activity-section-metadata="subagents"]',
    ],
    "context-popover": ['[role="progressbar"][aria-label="Context window usage"]'],
    "mcp-popover": [],
    "composer-command-menu": ['[data-composer-item-active="true"]'],
  };
  let criticalTargetsPresent = true;
  for (const selector of critical[input.scene] ?? []) {
    const matches =
      input.scene === "context-popover"
        ? Array.from(target?.querySelectorAll(selector) ?? []).filter(visible)
        : all(selector);
    if (matches.length === 0 || (input.scene === "context-popover" && matches.length !== 1))
      criticalTargetsPresent = false;
    additionalTargets.push(...matches);
  }
  const width = input.scene === "activity-narrow" ? 960 : 1280,
    height = input.scene === "activity-narrow" ? 800 : 960;
  const inView = (node: Element | null) => {
    if (!visible(node)) return false;
    const box = node.getBoundingClientRect();
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
      return false;
    // Same ancestor clipping policy as the existing serialized settings witness.
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor),
        clip = ancestor.getBoundingClientRect();
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowX) &&
        (box.left < clip.left || box.right > clip.right)
      )
        return false;
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowY) &&
        (box.top < clip.top || box.bottom > clip.bottom)
      )
        return false;
    }
    return [
      [box.left + box.width / 2, box.top + 2],
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.bottom - 2],
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (node === hit || node.contains(hit));
    });
  };
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched:
      surface !== null &&
      one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`) !== null &&
      document
        .querySelector('[data-testid="environment-rail-local"]')
        ?.getAttribute("aria-checked") === "true" &&
      document.querySelector('[data-testid="environment-rail-local"] [data-status="connected"]') !==
        null,
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView:
      innerWidth === width &&
      innerHeight === height &&
      criticalTargetsPresent &&
      inView(target) &&
      additionalTargets.every(inView),
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    providerMatched,
    unrelatedModalAbsent: all('[role="dialog"],[role="alertdialog"]').every(
      (node) => node === target || target?.contains(node) === true,
    ),
    ...facts,
  };
}
export interface ProviderChatCaptureInput extends ProviderChatInput {
  browser: QualificationBrowser;
  owner: QualificationOwner;
  evidence: string;
  captured: Set<string>;
  verifyOwnedIdentity: () => Promise<void>;
}
/** Capture original pixels under the existing owner's budgets, rechecking DOM and managed identity. */
export async function captureProviderChatScene(input: ProviderChatCaptureInput) {
  if (input.scene === "question-multiselect")
    throw new Error("Owned multiselect protocol is unqualified.");
  const file = providerChatScreenshotName(input.scene, input.theme);
  if (input.captured.size >= 16) throw new Error("Owned provider visual capture refused.");
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    file,
    viewport: input.scene === "activity-narrow" ? "activity-narrow" : "standard",
    captured: input.captured,
    observation: (): ProviderChatInput => ({
      scene: input.scene,
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    }),
    read: (observation) => input.browser.execute(readProviderChatWitness, observation),
    verifyOwnedIdentity: input.verifyOwnedIdentity,
    validate: (value) => validateProviderChatWitness(input.scene, value),
    project: (value) =>
      projectProviderChatCapture({ scene: input.scene, theme: input.theme, ...value }),
    refused: () => new Error("Owned provider visual capture refused."),
  });
}
export interface ProviderChatDriver {
  browser: QualificationBrowser;
  /** Existing owner verifies real driver/config/protocol prerequisites; this is not a state injection port. */
  prepare: (scene: ProviderChatScene) => Promise<void>;
  verifyOwnedIdentity: () => Promise<void>;
  /** Existing public composer typing/send helpers. */
  send: (prompt: string) => Promise<void>;
  draft: (text: string) => Promise<void>;
  viewport: (width: number, height: number) => Promise<void>;
  /** The integrated caller binds controls to the exact owned visible surface. */
  click?: (selector: string) => Promise<void>;
  /** Root binds the exact opt-in Codex refusal owner after public High selection in prepare. */
  withRefusedModel: (sendAndCapture: () => Promise<void>) => Promise<void>;
  /** Existing verified managed-only rename/restore owner. */
  withManagedWorkspaceLoss: (
    capture: (scope: ProviderChatWorkspaceLossScope) => Promise<void>,
  ) => Promise<void>;
  /** Root binds to captureProviderChatScene and its closed evidence writer. */
  capture: (scene: ProviderChatScene, scope?: ProviderChatWorkspaceLossScope) => Promise<void>;
}
export async function runProviderChatScene(
  input: ProviderChatDriver,
  scene: ProviderChatScene,
): Promise<void> {
  if (!providerChatScenes.includes(scene)) throw new Error("Owned provider visual scene refused.");
  if (scene === "question-multiselect")
    throw new Error("Owned multiselect protocol is unqualified.");
  await input.prepare(scene);
  await input.verifyOwnedIdentity();
  const { width, height } = providerChatViewport(scene);
  await input.viewport(width, height);
  const click = async (selector: string) => {
    if (input.click) return input.click(selector);
    const control = input.browser.$(selector);
    await control.waitForDisplayed();
    await control.waitForEnabled();
    await control.click();
  };
  switch (scene) {
    case "activity-narrow":
      await input.send(providerChatFixturePrompts.activity);
      await click('button[aria-label^="Expand activity summary:"]');
      await click('button[aria-label^="Open Subagents:"]');
      await click('[data-activity-row$="bibcode-ui-reviewer-thread"]');
      break;
    case "composer-command-menu":
      await input.draft(providerChatFixturePrompts.command);
      break;
    case "context-popover":
      await input.send(providerChatFixturePrompts.context);
      await click('button[aria-label^="Context window "]');
      break;
    case "mcp-popover":
      await input.send(providerChatFixturePrompts.context);
      await click('button[aria-label="MCP servers"]');
      break;
    case "chat-markdown-plan":
      await input.send(providerChatFixturePrompts.markdown);
      await input.draft("Owned visual review draft");
      await click('button[aria-label^="Show "][aria-label$=" sidebar"]');
      break;
    case "chat-refused-model":
      await input.withRefusedModel(async () => {
        await input.send(providerChatFixturePrompts.refused);
        await input.send("Owned visual message waiting behind refusal");
        await input.draft("Owned visual review draft");
        await input.capture(scene);
      });
      await input.verifyOwnedIdentity();
      return;
    case "chat-held-workspace-loss":
      await input.send(providerChatFixturePrompts.held);
      await input.send("Owned visual message waiting behind partial reply");
      await input.draft("Owned visual review draft");
      await input.withManagedWorkspaceLoss(async (scope) => {
        await input.capture(scene, scope);
      });
      await input.verifyOwnedIdentity();
      return;
  }
  await input.capture(scene);
  await input.verifyOwnedIdentity();
}
