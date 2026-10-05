// @effect-diagnostics nodeBuiltinImport:off - Closed failure facts are checked before reflection.
import * as NodeUtil from "node:util";
import { bounded, type QualificationBrowser } from "./qualification-owner.ts";

const flags = [
  "tabVisible",
  "tabEnabled",
  "tabInView",
  "tabHit",
  "tabSelected",
  "receiverEnding",
] as const;
const slots = [
  "target",
  "dialog-popup",
  "dialog-backdrop",
  "popover-popup",
  "toast-root",
  "toast-viewport",
  "toast-close",
  "menu-popup",
  "other",
] as const;
const failures = new WeakMap<
  object,
  { tab: string; facts: Readonly<Record<string, string | boolean | null>> }
>();

/** One two-second read on the original failed click; late diagnostics cannot replace it. */
export async function observeGitProjectTabFailure(
  error: unknown,
  input: Parameters<typeof readGitProjectTabFailure>[0] & { browser: QualificationBrowser },
): Promise<void> {
  if (!error || typeof error !== "object" || NodeUtil.types.isProxy(error)) return;
  failures.delete(error);
  try {
    if (!["changes", "history", "tags"].includes(input.tab)) return;
    const value = await bounded(
      input.browser.execute(readGitProjectTabFailure, {
        origin: input.origin,
        theme: input.theme,
        tab: input.tab,
        selection: input.selection,
      }),
      2000,
    );
    const facts = projectGitProjectTabFailure(value);
    if (facts) failures.set(error, { tab: input.tab, facts });
  } catch {
    // The failed click and its owner retain the original outcome.
  }
}

/** Retrieve only the same error's exact tab-click sample, never another phase or error. */
export function gitProjectTabFailureFacts(error: unknown, phase: unknown) {
  if (!error || typeof error !== "object" || NodeUtil.types.isProxy(error)) return null;
  const saved = failures.get(error);
  return saved && phase === `visual-git-project-tab-${saved.tab}-click` ? saved.facts : null;
}

/** A closed projection only; unknown or executable metadata cannot enter receipts. */
export function projectGitProjectTabFailure(value: unknown) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      return null;
    const keys: readonly string[] = ["tabCount", ...flags, "receiverSlot"];
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const result: Record<string, string | boolean | null> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      const field: unknown = descriptor.value;
      if (key === "tabCount") {
        if (field !== "none" && field !== "one" && field !== "many") return null;
      } else if (key === "receiverSlot") {
        if (field !== null && !slots.some((slot) => slot === field)) return null;
      } else if (field !== null && typeof field !== "boolean") return null;
      result[key] = field as string | boolean | null;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

/** One import-free serialized failure read; sampled paint/hits are not a cause verdict. */
export function readGitProjectTabFailure(input: {
  origin: string;
  theme: "light" | "dark";
  tab: "changes" | "history" | "tags";
  selection: { environmentId: string; projectId: string; threadId: string; cwd: string };
}) {
  try {
    const selection = input.selection;
    if (
      input.origin !== "http://127.0.0.1:4885" ||
      location.origin !== input.origin ||
      location.search ||
      location.hash ||
      (input.theme !== "light" && input.theme !== "dark") ||
      document.documentElement.classList.contains("dark") !== (input.theme === "dark") ||
      selection.environmentId !== "local" ||
      ![selection.projectId, selection.threadId].every(
        (id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id),
      ) ||
      location.pathname !== "/project/local/" + selection.projectId + "/git" ||
      typeof selection.cwd !== "string" ||
      !selection.cwd.startsWith("/") ||
      selection.cwd.length > 4096 ||
      !["changes", "history", "tags"].includes(input.tab) ||
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) ||
      document.getElementById("boot-shell") ||
      document.querySelector("vite-error-overlay")
    )
      return null;
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      if (![box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)
        return false;
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const opacity = Number.parseFloat(style.opacity);
        if (
          style.display === "none" ||
          style.visibility !== "visible" ||
          !Number.isFinite(opacity) ||
          opacity <= 0 ||
          parent.hasAttribute("hidden") ||
          parent.hasAttribute("inert")
        )
          return false;
      }
      return true;
    };
    const cards = document.querySelectorAll(
      `[data-testid="primary-card-button-${selection.projectId}"]`,
    );
    const rails = document.querySelectorAll(
      '[data-testid="environment-rail-local"][aria-checked="true"]',
    );
    const headers = document.querySelectorAll("header[data-environment-id][data-project-id]");
    const projects = document.querySelectorAll('[data-testid="git-manager-project"]');
    if (
      cards.length !== 1 ||
      !visible(cards[0]!) ||
      headers.length !== 1 ||
      !visible(headers[0]!) ||
      headers[0]!.getAttribute("data-environment-id") !== "local" ||
      headers[0]!.getAttribute("data-project-id") !== selection.projectId ||
      projects.length !== 1 ||
      !visible(projects[0]!) ||
      projects[0]!.getAttribute("title") !== selection.cwd ||
      rails.length !== 1 ||
      !visible(rails[0]!) ||
      rails[0]!.querySelectorAll('[data-status="connected"]').length !== 1
    )
      return null;
    const label =
      input.tab === "changes" ? "Changes" : input.tab === "history" ? "History" : "Tags";
    const matches = Array.from(document.querySelectorAll('button[role="tab"]')).filter(
      (node) => node.textContent?.trim() === label,
    );
    const tab = matches.length === 1 ? matches[0]! : null;
    const box = tab?.getBoundingClientRect();
    const inView =
      box !== undefined &&
      [box.x, box.y, box.width, box.height, box.right, box.bottom].every(Number.isFinite) &&
      box.width > 0 &&
      box.height > 0 &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.right <= innerWidth &&
      box.bottom <= innerHeight;
    const hit =
      tab && inView
        ? document.elementFromPoint(box!.x + box!.width / 2, box!.y + box!.height / 2)
        : null;
    const received = hit !== null && tab !== null && (hit === tab || tab.contains(hit));
    const receiver = hit?.closest("[data-slot]") ?? hit;
    const slot = receiver?.getAttribute("data-slot");
    const receiverSlot = received
      ? "target"
      : hit === null
        ? null
        : [
              "dialog-popup",
              "dialog-backdrop",
              "popover-popup",
              "toast-root",
              "toast-viewport",
              "toast-close",
              "menu-popup",
            ].includes(slot ?? "")
          ? slot!
          : "other";
    return {
      tabCount: matches.length === 0 ? "none" : matches.length === 1 ? "one" : "many",
      tabVisible: tab ? visible(tab) : null,
      tabEnabled: tab ? !tab.matches(':disabled,[aria-disabled="true"]') : null,
      tabInView: tab ? inView : null,
      tabHit: tab && inView ? received : null,
      tabSelected: tab ? tab.getAttribute("aria-selected") === "true" : null,
      receiverSlot,
      receiverEnding: receiver ? receiver.hasAttribute("data-ending-style") : null,
    };
  } catch {
    return null;
  }
}
