// @effect-diagnostics nodeBuiltinImport:off - Only closed private qualification receipts are projected here.
import * as NodeUtil from "node:util";
import type { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import { cursorQuestionFixturePrompt } from "./release-visual-cursor-question-fixture.ts";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import { validateCaptureWitness } from "./remote-ui-evidence.ts";

export interface CursorQuestionObservationInput {
  phase: "later" | "quiescent";
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}

const common = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
const laterFacts = ["providerMatched", "laterQuestion", "twoChoices", "explicitSubmit"] as const;

/** Public snapshot success bound to the privately retained original turn, never DOM quiescence. */
export function successfulCursorQuestionTurn(value: unknown, originalTurnId: string): boolean {
  const data = (object: unknown, key: string) => {
    if (
      !object ||
      typeof object !== "object" ||
      NodeUtil.types.isProxy(object) ||
      Array.isArray(object)
    )
      return undefined;
    const field = Object.getOwnPropertyDescriptor(object, key);
    return field?.enumerable && Object.hasOwn(field, "value") ? field.value : undefined;
  };
  try {
    const turn = data(value, "latestTurn"),
      completedAt = data(turn, "completedAt");
    return (
      typeof originalTurnId === "string" &&
      originalTurnId.length > 0 &&
      originalTurnId.length <= 128 &&
      data(turn, "turnId") === originalTurnId &&
      data(turn, "state") === "completed" &&
      typeof completedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(completedAt)
    );
  } catch {
    return false;
  }
}

export function validateCursorQuestionWitness(phase: "later" | "quiescent", value: unknown) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      throw new Error();
    const keys = [
      ...common,
      ...(phase === "later" ? laterFacts : ["providerMatched", "turnQuiescent"]),
    ];
    if (!["later", "quiescent"].includes(phase) || Reflect.ownKeys(value).length !== keys.length)
      throw new Error();
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, "value") || field.value !== true)
        throw new Error();
    }
    validateCaptureWitness(Object.fromEntries(common.map((key) => [key, true])));
    return Object.fromEntries(keys.map((key) => [key, true] as const));
  } catch {
    throw new Error("Owned Cursor question visual refused.");
  }
}

/** Standalone serialized public DOM observation; no input, text, identity or geometry leaves the page. */
export function readCursorQuestionObservation(
  input: CursorQuestionObservationInput,
): Record<string, boolean> | null {
  if (
    !input ||
    !["later", "quiescent"].includes(input.phase) ||
    !["light", "dark"].includes(input.theme) ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
    location.pathname !== "/local/" + input.threadId ||
    input.branch !== "codex/delivery-retry-" + input.theme
  )
    return null;
  const visible = (node: Element | null): node is HTMLElement => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    if (
      ![box.x, box.y, box.width, box.height, box.right, box.bottom].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    )
      return false;
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const found = all(selector);
    return found.length === 1 ? found[0]! : null;
  };
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const inView = (node: Element | null) => {
    if (!visible(node)) return false;
    const box = node.getBoundingClientRect();
    if (box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!top || (top !== node && !node.contains(top))) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        clip = parent.getBoundingClientRect();
      if (
        (["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
          (box.x < clip.x || box.right > clip.right)) ||
        (["hidden", "clip", "auto", "scroll"].includes(style.overflowY) &&
          (box.y < clip.y || box.bottom > clip.bottom))
      )
        return false;
    }
    return true;
  };
  const surface = one('[data-center-surface-host][data-visible="true"]');
  const form = surface
    ? Array.from(surface.querySelectorAll('[data-chat-composer-form="true"]')).filter(visible)
    : [];
  if (form.length !== 1) return null;
  const currentForm = form[0]!;
  const providers = Array.from(
    currentForm.querySelectorAll('[data-chat-provider-model-picker="true"]'),
  ).filter(visible);
  const providerMatched =
    providers.length === 1 &&
    providers[0]!.getAttribute("aria-label") === "Cursor · Cursor Fixture";
  let target: Element | null = currentForm;
  let facts: Record<string, boolean>;
  const critical: Element[] = [];
  if (input.phase === "later") {
    const question = Array.from(currentForm.querySelectorAll("p")).filter(
      (node) => visible(node) && text(node) === "Choose the later checks.",
    );
    target = question.length === 1 ? question[0]!.parentElement : null;
    const choices = target ? Array.from(target.querySelectorAll("button")).filter(visible) : [];
    const progress = target
      ? Array.from(target.querySelectorAll("span")).filter(
          (node) => visible(node) && text(node) === "2/2",
        )
      : [];
    const instructions = target
      ? Array.from(target.querySelectorAll("p")).filter(
          (node) => visible(node) && text(node) === "Select one or more options.",
        )
      : [];
    const labels = choices.map((node) => node.querySelector("span"));
    const selected = (label: string) => {
      const matching = choices.filter(
        (node) => visible(node.querySelector("span")) && text(node.querySelector("span")) === label,
      );
      return (
        matching.length === 1 &&
        !matching[0]!.disabled &&
        inView(matching[0]!.querySelector("svg.lucide-check"))
      );
    };
    const submits = Array.from(currentForm.querySelectorAll('button[type="submit"]')).filter(
      visible,
    );
    critical.push(
      ...choices,
      ...submits,
      ...question,
      ...progress,
      ...instructions,
      ...labels.filter((node): node is HTMLSpanElement => node !== null),
    );
    facts = {
      providerMatched,
      laterQuestion: !!target && progress.length === 1 && instructions.length === 1,
      twoChoices:
        choices.length === 3 &&
        selected("Tests") &&
        selected("Docs") &&
        !selected("Types") &&
        ["Tests", "Docs", "Types"].every(
          (label) =>
            choices.filter((node) => text(node.querySelector("span")) === label).length === 1,
        ) &&
        choices.filter((node) => node.querySelector("svg.lucide-check") !== null).length === 2,
      explicitSubmit:
        submits.length === 1 &&
        !(submits[0] as HTMLButtonElement).disabled &&
        ["Submit", "Submit answers"].includes(text(submits[0]!)),
    };
  } else {
    facts = {
      providerMatched,
      turnQuiescent:
        !Array.from(currentForm.querySelectorAll("p")).some(
          (node) =>
            text(node) === "Choose the later checks." || text(node) === "Choose the first scope.",
        ) &&
        all('[data-center-surface-host][data-visible="true"] [data-timeline-row-kind="working"]')
          .length === 0 &&
        all('[data-center-surface-host][data-visible="true"] button[aria-label="Stop generation"]')
          .length === 0 &&
        all('[data-center-surface-host][data-visible="true"] [data-message-role="user"]').some(
          (node) => text(node).includes("Owned later multiselect question"),
        ),
    };
  }
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched:
      one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`) !== null &&
      document
        .querySelector('[data-testid="environment-rail-local"]')
        ?.getAttribute("aria-checked") === "true" &&
      document.querySelector('[data-testid="environment-rail-local"] [data-status="connected"]') !==
        null,
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView:
      innerWidth === 1280 &&
      innerHeight === 960 &&
      inView(target) &&
      critical.every(inView) &&
      all('[role="dialog"],[role="alertdialog"]').every(
        (node) => node === target || target?.contains(node) === true,
      ),
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    ...facts,
  };
}

export function projectCursorQuestionCapture(value: unknown) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      throw new Error();
    const names = ["scene", "theme", "file", "witness", "width", "height", "nonBlank", "sha256"];
    if (Reflect.ownKeys(value).length !== names.length) throw new Error();
    const row: Record<string, unknown> = {};
    for (const name of names) {
      const field = Object.getOwnPropertyDescriptor(value, name);
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new Error();
      row[name] = field.value;
    }
    if (
      row.scene !== "question-multiselect" ||
      !["light", "dark"].includes(row.theme as string) ||
      row.file !== "question-multiselect-" + row.theme + ".png" ||
      row.width !== 1280 ||
      row.height !== 960 ||
      row.nonBlank !== true ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw new Error();
    return {
      scene: "question-multiselect",
      theme: row.theme,
      file: row.file,
      witness: validateCursorQuestionWitness("later", row.witness),
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: row.sha256,
    };
  } catch {
    throw new Error("Owned Cursor question visual refused.");
  }
}

export async function captureCursorQuestionVisual(
  input: Omit<CursorQuestionObservationInput, "phase"> & {
    browser: QualificationBrowser;
    owner: Pick<QualificationOwner, "until">;
    evidence: string;
    captured: Set<string>;
    verifyOwnedIdentity: () => Promise<void>;
  },
) {
  if (!["light", "dark"].includes(input.theme))
    throw new Error("Owned Cursor question visual refused.");
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    file: "question-multiselect-" + input.theme + ".png",
    captured: input.captured,
    observation: (): CursorQuestionObservationInput => ({
      phase: "later",
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    }),
    read: (observation) => input.browser.execute(readCursorQuestionObservation, observation),
    verifyOwnedIdentity: input.verifyOwnedIdentity,
    validate: (value) => validateCursorQuestionWitness("later", value),
    project: (record) =>
      projectCursorQuestionCapture({
        scene: "question-multiselect",
        theme: input.theme,
        ...record,
      }),
    refused: () => new Error("Owned Cursor question visual refused."),
  });
}

export interface CursorQuestionVisualDriver {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until" | "cleanup">;
  verifyOwnedIdentity: () => Promise<void>;
  selectCursor: () => Promise<void>;
  restoreOriginal: () => Promise<void>;
  verifyRestoredIdentity: () => Promise<void>;
  send: (prompt: string) => Promise<void>;
  capture: () => Promise<void>;
  waitOriginalTurnCompleted: () => Promise<void>;
  step: (phase: string) => void;
  /** Failure-only attribution before restore cleanup; cannot replace the original exception. */
  observeFailure?: (error: unknown) => void;
}

const formXPath =
  '//*[@data-center-surface-host and @data-visible="true"]//*[@data-chat-composer-form="true"]';
export function cursorQuestionOptionSelector(label: "Workspace" | "Tests" | "Docs") {
  if (!["Workspace", "Tests", "Docs"].includes(label))
    throw new Error("Owned Cursor question visual refused.");
  return `${formXPath}//button[.//span[normalize-space()="${label}"]]`;
}
export const cursorQuestionSubmitSelector =
  '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] button[type="submit"]';

/** One additional fixed row; never part of the bounded nine-scene core sequence. */
export async function runCursorQuestionVisual(input: CursorQuestionVisualDriver) {
  let restored = false;
  const click = async (selector: string) => {
    const control = input.browser.$(selector);
    await control.waitForDisplayed();
    if ((await (await input.browser.$$(selector)).length) !== 1)
      throw new Error("Owned Cursor question visual refused.");
    await control.waitForEnabled();
    await control.click();
  };
  await input.verifyOwnedIdentity();
  try {
    input.step("visual-cursor-question-select");
    await input.selectCursor();
    await input.verifyOwnedIdentity();
    input.step("visual-cursor-question-send");
    await input.send(cursorQuestionFixturePrompt);
    input.step("visual-cursor-question-first-choice");
    await click(cursorQuestionOptionSelector("Workspace"));
    input.step("visual-cursor-question-later-tests");
    await click(cursorQuestionOptionSelector("Tests"));
    input.step("visual-cursor-question-later-docs");
    await click(cursorQuestionOptionSelector("Docs"));
    input.step("visual-cursor-question-capture");
    await input.capture();
    input.step("visual-cursor-question-submit");
    await click(cursorQuestionSubmitSelector);
    await input.waitOriginalTurnCompleted();
    await input.verifyOwnedIdentity();
  } catch (error) {
    try {
      input.observeFailure?.(error);
    } catch {
      // Optional attribution cannot replace the original failure or restore cleanup.
    }
    throw error;
  } finally {
    await input.owner.cleanup("cursor-question-model-restore", async () => {
      await input.restoreOriginal();
      await input.verifyRestoredIdentity();
      restored = true;
    });
  }
  if (!restored) throw new Error("Owned Cursor question visual refused.");
  return {
    completeGroup: false,
    twoOrderedQuestions: true,
    twoSelectedLabels: true,
    explicitSubmit: true,
    originalTurnCompleted: true,
    providerRestored: true,
  } as const;
}

export interface PendingCursorQuestionBinding {
  readonly threadId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly requestSequence: number;
}
function cursorData(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field?.enumerable && Object.hasOwn(field, "value") ? field.value : undefined;
}
function cursorQuestionArray(value: unknown): boolean {
  if (!Array.isArray(value) || NodeUtil.types.isProxy(value) || value.length !== 2) return false;
  const expected = [
    {
      id: "first",
      question: "Choose the first scope.",
      multiSelect: false,
      labels: ["Workspace", "Project"],
    },
    {
      id: "later",
      question: "Choose the later checks.",
      multiSelect: true,
      labels: ["Tests", "Docs", "Types"],
    },
  ];
  return expected.every((shape, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, "value")) return false;
    const question = item.value;
    if (
      cursorData(question, "id") !== shape.id ||
      cursorData(question, "question") !== shape.question ||
      cursorData(question, "multiSelect") !== shape.multiSelect
    )
      return false;
    const options = cursorData(question, "options");
    if (
      !Array.isArray(options) ||
      NodeUtil.types.isProxy(options) ||
      options.length !== shape.labels.length
    )
      return false;
    return shape.labels.every((label, option) => {
      const field = Object.getOwnPropertyDescriptor(options, String(option));
      return field && Object.hasOwn(field, "value") && cursorData(field.value, "label") === label;
    });
  });
}
export function bindPendingCursorQuestion(
  thread: OrchestrationThread,
  before: { readonly messageIds: readonly string[]; readonly activityIds: readonly string[] },
): PendingCursorQuestionBinding | null {
  try {
    if (
      thread.modelSelection.instanceId !== "cursor" ||
      thread.modelSelection.model !== "cursor-fixture" ||
      thread.session?.providerName !== "cursor" ||
      thread.session.threadId !== thread.id ||
      thread.session.providerInstanceId !== "cursor" ||
      thread.session.status === "error" ||
      thread.session.lastError !== null
    )
      return null;
    const messages = thread.messages.filter(
      (message) =>
        !before.messageIds.includes(message.id) &&
        message.role === "user" &&
        message.text === cursorQuestionFixturePrompt,
    );
    if (messages.length !== 1) return null;
    const message = messages[0]!;
    if (
      message.delivery?.provider !== "cursor" ||
      message.delivery.providerInstanceId !== "cursor" ||
      !["pending", "sending"].includes(message.delivery.state)
    )
      return null;
    const requests = thread.activities.filter(
      (activity) =>
        !before.activityIds.includes(activity.id) &&
        activity.kind === "user-input.requested" &&
        cursorData(activity.payload, "eventType") === "user-input.requested",
    );
    if (requests.length !== 1) return null;
    const requested = requests[0]!,
      requestId = cursorData(requested.payload, "requestId");
    if (
      requested.turnId === null ||
      typeof requestId !== "string" ||
      requestId.length < 1 ||
      requestId.length > 256 ||
      requested.sequence === undefined ||
      !cursorQuestionArray(cursorData(requested.payload, "questions"))
    )
      return null;
    const starts = thread.activities.filter(
      (activity) =>
        !before.activityIds.includes(activity.id) &&
        activity.turnId === requested.turnId &&
        activity.kind === "provider.turn" &&
        cursorData(activity.payload, "eventType") === "turn.started" &&
        activity.sequence !== undefined &&
        activity.sequence < requested.sequence!,
    );
    if (
      starts.length !== 1 ||
      thread.activities.some(
        (activity) =>
          activity.turnId === requested.turnId &&
          ["turn.completed", "user-input.resolved"].includes(
            String(cursorData(activity.payload, "eventType")),
          ),
      )
    )
      return null;
    return Object.freeze({
      threadId: thread.id,
      messageId: message.id,
      turnId: requested.turnId,
      requestId,
      requestSequence: requested.sequence,
    });
  } catch {
    return null;
  }
}
export function completedPendingCursorQuestion(
  thread: OrchestrationThread,
  binding: PendingCursorQuestionBinding,
): boolean {
  try {
    if (
      thread.id !== binding.threadId ||
      thread.modelSelection.instanceId !== "cursor" ||
      thread.session?.providerName !== "cursor" ||
      thread.session.threadId !== thread.id ||
      thread.session.providerInstanceId !== "cursor" ||
      !["ready", "idle"].includes(thread.session.status) ||
      thread.session.activeTurnId !== null ||
      thread.session.lastError !== null
    )
      return false;
    const messages = thread.messages.filter(
      (message) =>
        message.id === binding.messageId &&
        message.role === "user" &&
        message.text === cursorQuestionFixturePrompt &&
        message.turnId === null &&
        message.delivery?.mode === "start" &&
        message.delivery?.state === "delivered" &&
        message.delivery.provider === "cursor" &&
        message.delivery.providerInstanceId === "cursor",
    );
    if (messages.length !== 1) return false;
    const resolved = thread.activities.filter(
      (activity) =>
        activity.turnId === binding.turnId &&
        activity.kind === "user-input.resolved" &&
        cursorData(activity.payload, "eventType") === "user-input.resolved" &&
        cursorData(activity.payload, "requestId") === binding.requestId &&
        activity.sequence !== undefined &&
        activity.sequence > binding.requestSequence,
    );
    const completed = thread.activities.filter(
      (activity) =>
        activity.turnId === binding.turnId &&
        activity.kind === "provider.turn" &&
        cursorData(activity.payload, "eventType") === "turn.completed" &&
        cursorData(activity.payload, "state") === "completed" &&
        cursorData(activity.payload, "stopReason") === "end_turn" &&
        activity.sequence !== undefined &&
        activity.sequence > binding.requestSequence,
    );
    if (resolved.length !== 1 || completed.length !== 1) return false;
    const answers = cursorData(resolved[0]!.payload, "answers"),
      later = cursorData(answers, "later");
    if (
      cursorData(answers, "first") !== "Workspace" ||
      !Array.isArray(later) ||
      NodeUtil.types.isProxy(later) ||
      later.length !== 2 ||
      !later.every((label) => label === "Tests" || label === "Docs") ||
      new Set(later).size !== 2
    )
      return false;
    return !thread.activities.some(
      (activity) =>
        activity.turnId === binding.turnId &&
        (activity.kind === "provider.error" ||
          (cursorData(activity.payload, "eventType") === "turn.completed" &&
            cursorData(activity.payload, "state") !== "completed")),
    );
  } catch {
    return false;
  }
}
