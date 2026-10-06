// @effect-diagnostics nodeBuiltinImport:off - Untrusted closed observations are refused before reflection.
import * as NodeUtil from "node:util";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
export const settingsFollowupRows = [
  "settings-diagnostics",
  "usage-detail",
  "remote-rename",
  "remote-receiving-settings",
] as const;
export const settingsFollowupScenes = [
  "settings-diagnostics",
  "diagnostics-live-processes",
  "diagnostics-unknown-duration",
  "usage-detail-available",
  "usage-detail",
  "remote-rename",
  "remote-rename-applied",
  "receiving-settings-row",
  "remote-receiving-settings",
] as const;
export type SettingsFollowupScene = (typeof settingsFollowupScenes)[number];
export const settingsFollowupParentRow: Record<
  SettingsFollowupScene,
  (typeof settingsFollowupRows)[number]
> = {
  "settings-diagnostics": "settings-diagnostics",
  "diagnostics-live-processes": "settings-diagnostics",
  "diagnostics-unknown-duration": "settings-diagnostics",
  "usage-detail": "usage-detail",
  "usage-detail-available": "usage-detail",
  "remote-rename": "remote-rename",
  "remote-rename-applied": "remote-rename",
  "remote-receiving-settings": "remote-receiving-settings",
  "receiving-settings-row": "remote-receiving-settings",
};
export const settingsFollowupFacts: Record<SettingsFollowupScene, readonly string[]> = {
  "settings-diagnostics": [
    "traceCountsVisible",
    "failedCauseWrapped",
    "durationVisible",
    "fixtureLabelsOnly",
  ],
  "diagnostics-live-processes": ["liveProcessTable", "ownedProcessesOnly", "resourceCountsVisible"],
  "diagnostics-unknown-duration": ["unknownDurationVisible", "countVisible", "noFalseZeroTiming"],
  "usage-detail": ["selectedServerNamed", "usageUnavailable", "formerUsageAbsent"],
  "usage-detail-available": [
    "selectedServerNamed",
    "usageWindowsVisible",
    "usagePercentMatched",
    "resetNeverConsumed",
  ],
  "remote-rename": [
    "renameDialog",
    "currentNameRetained",
    "deviceOnlyCopy",
    "saveAndCancelVisible",
  ],
  "remote-rename-applied": ["savedNameCoherent", "sameSelection", "connectionRetained"],
  "remote-receiving-settings": [
    "receivingNotice",
    "cachedProjectRetained",
    "noFalseEmpty",
    "composerDisabled",
  ],
  "receiving-settings-row": ["receivingNotice", "rowNamed", "reasonVisible", "sameSelection"],
};
export const settingsFollowupCommonFacts = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
  "unrelatedModalAbsent",
] as const;
function dataFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const refused = () => new Error("Owned settings follow-up record refused.");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    NodeUtil.types.isProxy(value) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    result[key] = field.value;
  }
  return result;
}
export function validateSettingsFollowupWitness(
  scene: SettingsFollowupScene,
  value: unknown,
): Record<string, true> {
  if (!settingsFollowupScenes.includes(scene))
    throw new Error("Owned settings follow-up scene refused.");
  const data = dataFields(value, [...settingsFollowupCommonFacts, ...settingsFollowupFacts[scene]]);
  const result: Record<string, true> = {};
  for (const key of Object.keys(data)) {
    if (data[key] !== true) throw new Error("Owned settings follow-up witness refused.");
    result[key] = true;
  }
  return result;
}
export function projectSettingsFollowupCapture(value: unknown) {
  const data = dataFields(value, [
    "scene",
    "parentRow",
    "theme",
    "file",
    "width",
    "height",
    "nonBlank",
    "sha256",
    "witness",
  ]);
  const scene = settingsFollowupScenes.find((name) => name === data.scene),
    theme = data.theme;
  if (
    !scene ||
    !["light", "dark"].some((name) => name === theme) ||
    data.parentRow !== settingsFollowupParentRow[scene] ||
    data.file !== scene + "-" + theme + ".png" ||
    data.width !== 1280 ||
    data.height !== 960 ||
    data.nonBlank !== true ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256)
  )
    throw new Error("Owned settings follow-up capture refused.");
  return {
    scene,
    parentRow: settingsFollowupParentRow[scene],
    theme,
    file: data.file,
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: data.sha256,
    witness: validateSettingsFollowupWitness(scene, data.witness),
  };
}
function dataArray(value: unknown, expectedLength: number): readonly unknown[] {
  const refused = () => new Error("Owned settings sequence refused.");
  if (!Array.isArray(value) || NodeUtil.types.isProxy(value)) throw refused();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    length.value !== expectedLength ||
    Reflect.ownKeys(value).length !== expectedLength + 1
  )
    throw refused();
  const result: unknown[] = [];
  for (let index = 0; index < expectedLength; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    result.push(field.value);
  }
  return result;
}
export function projectSettingsFollowupAssertion(theme: "light" | "dark", value: unknown) {
  const keys = [
    "theme",
    "rows",
    "files",
    "completeGroup",
    "sourceIdentityRetained",
    "originalContextRestored",
    "originalLabelRestored",
    "originalConfigurationReleased",
    "unavailableUsageDidNotBorrow",
  ];
  const data = dataFields(value, keys),
    rows = dataArray(data.rows, 4),
    files = dataArray(data.files, 9);
  if (
    !["light", "dark"].includes(theme) ||
    data.theme !== theme ||
    data.completeGroup !== false ||
    rows.some((row, index) => row !== settingsFollowupRows[index]) ||
    files.some((file, index) => file !== settingsFollowupScenes[index] + "-" + theme + ".png") ||
    keys.slice(4).some((key) => data[key] !== true)
  )
    throw new Error("Owned settings assertion refused.");
  return {
    theme,
    rows: [...settingsFollowupRows],
    files: settingsFollowupScenes.map((scene) => scene + "-" + theme + ".png"),
    completeGroup: false,
    sourceIdentityRetained: true,
    originalContextRestored: true,
    originalLabelRestored: true,
    originalConfigurationReleased: true,
    unavailableUsageDidNotBorrow: true,
  } as const;
}
export function validateSettingsFollowupJoins(captures: unknown, assertions: unknown) {
  const values = dataArray(captures, 18).map(projectSettingsFollowupCapture),
    reports = dataArray(assertions, 2);
  const themes = ["light", "dark"] as const;
  const files = themes.flatMap((theme) =>
    settingsFollowupScenes.map((scene) => scene + "-" + theme + ".png"),
  );
  if (
    new Set(values.map((value) => value.file)).size !== 18 ||
    files.some((file) => !values.some((value) => value.file === file))
  )
    throw new Error("Owned settings join refused.");
  for (const [index, theme] of themes.entries())
    projectSettingsFollowupAssertion(theme, reports[index]);
}
export interface SettingsFollowupObservation {
  scene: SettingsFollowupScene;
  theme: "light" | "dark";
  origin: "http://127.0.0.1:4885";
  environmentId: string;
  environmentLabel: string;
  projectTitle: string;
  threadId: string;
  projectId: string;
  workspaceKind: "primary" | "worktree";
  originalLabel: string;
  reportedLabel: string;
  spanCount: number;
  failureCount: number;
  usageLabels: readonly string[];
  formerUsageLabels: readonly string[];
  processLabels: readonly string[];
  unmeasuredSpanName: "agent_activity_enabled" | "agent_activity_disabled";
  unmeasuredCount: number;
  failureCause: string;
}
/** Serialized read-only public witness; physical/server/session joins stay in the source owner. */
export function readSettingsFollowup(
  input: SettingsFollowupObservation,
): Record<string, boolean> | null {
  const scenes = [
    "settings-diagnostics",
    "diagnostics-live-processes",
    "diagnostics-unknown-duration",
    "usage-detail-available",
    "usage-detail",
    "remote-rename",
    "remote-rename-applied",
    "receiving-settings-row",
    "remote-receiving-settings",
  ];
  const diagnostics = [
      "settings-diagnostics",
      "diagnostics-live-processes",
      "diagnostics-unknown-duration",
    ].includes(input.scene),
    remoteSettings = input.scene === "remote-rename" || input.scene === "receiving-settings-row";
  const expectedPath = diagnostics
    ? "/settings/diagnostics"
    : remoteSettings
      ? "/settings/remote-servers"
      : "/" + encodeURIComponent(input.environmentId) + "/" + encodeURIComponent(input.threadId);
  if (
    !scenes.includes(input.scene) ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.pathname !== expectedPath ||
    location.search ||
    location.hash ||
    ![input.environmentId, input.threadId, input.projectId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    !["primary", "worktree"].includes(input.workspaceKind) ||
    ![input.environmentLabel, input.originalLabel, input.reportedLabel, input.projectTitle].every(
      (value) => /^[A-Za-z0-9 -]{1,80}$/.test(value),
    ) ||
    ![input.spanCount, input.failureCount, input.unmeasuredCount].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 1_000_000,
    ) ||
    ![input.usageLabels, input.formerUsageLabels].every(
      (values) =>
        Array.isArray(values) &&
        values.length <= 3 &&
        values.every(
          (value) => typeof value === "string" && /^\d{1,3}% (remaining|used)$/.test(value),
        ),
    ) ||
    !Array.isArray(input.processLabels) ||
    input.processLabels.length > 64 ||
    input.processLabels.some(
      (value) => typeof value !== "string" || value.length === 0 || value.length > 256,
    ) ||
    !["agent_activity_enabled", "agent_activity_disabled"].includes(input.unmeasuredSpanName) ||
    typeof input.failureCause !== "string" ||
    input.failureCause.length > 4096
  )
    return null;
  const visible = (node: Element | null): node is HTMLElement => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0 ||
        current.hasAttribute("hidden")
      )
        return false;
    }
    return true;
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const values = all(selector);
    return values.length === 1 ? values[0]! : null;
  };
  const text = (node: Element | null) => node?.textContent?.trim() ?? "";
  const section = (title: string) => {
    const titles = all("section h2").filter((value) => text(value) === title);
    return titles.length === 1 ? titles[0]!.closest("section") : null;
  };
  const button = (root: Element | null, label: string) => {
    const values = Array.from(root?.querySelectorAll("button") ?? []).filter(
      (value) => visible(value) && text(value) === label,
    );
    return values.length === 1 ? values[0]! : null;
  };
  const rail = one(
      `[data-testid="${input.environmentId === "local" ? "environment-rail-local" : "environment-rail-entry-" + input.environmentId}"][aria-checked="true"]`,
    ),
    receiving =
      input.scene === "receiving-settings-row" || input.scene === "remote-receiving-settings";
  const connected = rail?.querySelector('[data-status="connected"]') ?? null;
  const connectedOrConfiguring = receiving
    ? (rail?.querySelector('[data-status="disconnected"]') ?? null)
    : connected;
  let target: Element | null = null,
    facts: Record<string, boolean> = {};
  const critical: Element[] = [];
  const passive: Element[] = [];
  // The owned rename modal intentionally blocks pointer hits on its background rail.
  // Its selected context stays fully visible and source-bound; dialog controls must remain hit-testable.
  if (rail) (input.scene === "remote-rename" ? passive : critical).push(rail);
  if (input.scene === "settings-diagnostics") {
    target = section("Trace Diagnostics");
    const failures = section("Latest Failures"),
      rows = Array.from(failures?.querySelectorAll("tbody tr") ?? []).filter(visible),
      matching = rows.filter(
        (value) =>
          text(value.querySelector("td")) === "gitManager.getRefs" &&
          text(value.querySelector("td:nth-child(2) div > div")) === input.failureCause,
      ),
      row = matching.length === 1 ? matching[0]! : null;
    if (failures) critical.push(failures);
    const cause = row?.querySelector("td:nth-child(2) div > div") ?? null,
      duration = row?.querySelector("td:nth-child(3)") ?? null;
    if (cause) critical.push(cause);
    if (duration) critical.push(duration);
    facts = {
      traceCountsVisible:
        target !== null &&
        text(target).includes(new Intl.NumberFormat().format(input.spanCount)) &&
        text(target).includes(new Intl.NumberFormat().format(input.failureCount)),
      failedCauseWrapped:
        visible(cause) &&
        getComputedStyle(cause).whiteSpace === "pre-wrap" &&
        cause.getBoundingClientRect().height >=
          2 * Number.parseFloat(getComputedStyle(cause).lineHeight) &&
        cause.scrollWidth <= cause.clientWidth,
      durationVisible:
        visible(duration) &&
        /ms| s/.test(text(duration)) &&
        !text(duration).includes("Not recorded"),
      fixtureLabelsOnly:
        row !== null &&
        input.failureCause.length > 0 &&
        rows.every(
          (value) =>
            text(value.querySelector("td")) === "gitManager.getRefs" &&
            text(value.querySelector("td:nth-child(2) div > div")) === input.failureCause,
        ),
    };
  } else if (input.scene === "diagnostics-live-processes") {
    target = section("Live Processes");
    const rows = Array.from(target?.querySelectorAll("tbody tr") ?? []).filter(visible);
    const summary = target?.querySelector('[data-resource-card="combined"]') ?? null,
      metrics = Array.from(summary?.querySelectorAll(":scope > div:nth-child(2) > div") ?? []),
      count = metrics.find((value) => text(value.firstElementChild) === "Processes") ?? null;
    if (summary) critical.push(summary);
    for (const row of rows) {
      const label = row.querySelector("td:nth-child(3) span");
      if (label) critical.push(label);
    }
    facts = {
      liveProcessTable: rows.length > 0,
      ownedProcessesOnly:
        rows.length > 0 &&
        input.processLabels.length > 0 &&
        rows.every((row) =>
          input.processLabels.includes(text(row.querySelector("td:nth-child(3) span"))),
        ),
      resourceCountsVisible:
        visible(summary) &&
        metrics.length === 3 &&
        metrics.every((value) => text(value.lastElementChild).length > 0) &&
        text(count?.lastElementChild ?? null) === String(input.processLabels.length),
    };
  } else if (input.scene === "diagnostics-unknown-duration") {
    target = section("Top Span Names");
    const rows = Array.from(target?.querySelectorAll("tbody tr") ?? []).filter(visible),
      row =
        rows.find((value) => text(value.querySelector("td")) === input.unmeasuredSpanName) ?? null;
    if (row) critical.push(row);
    facts = {
      unknownDurationVisible: text(row).includes("Not recorded"),
      countVisible:
        row?.querySelector("td:nth-child(2)") !== null &&
        input.unmeasuredCount > 0 &&
        Array.from(row?.querySelector("td:nth-child(2)")?.childNodes ?? [])
          .filter((value) => value.nodeType === Node.TEXT_NODE)
          .map((value) => value.textContent ?? "")
          .join("")
          .trim() === new Intl.NumberFormat().format(input.unmeasuredCount),
      noFalseZeroTiming:
        row !== null &&
        Array.from(row.querySelectorAll("td"))
          .slice(-2)
          .every((value) => text(value) === "Not recorded"),
    };
  } else if (input.scene === "usage-detail" || input.scene === "usage-detail-available") {
    target = one('[data-slot="popover-popup"][aria-label="Codex usage details"]');
    const detail = target?.querySelector('[data-testid="provider-usage-detail"]') ?? null;
    const meters = Array.from(detail?.querySelectorAll('[role="progressbar"]') ?? []).filter(
      visible,
    );
    if (detail) critical.push(detail);
    for (const meter of meters) critical.push(meter);
    facts =
      input.scene === "usage-detail"
        ? {
            selectedServerNamed: rail !== null,
            usageUnavailable: text(detail).includes("Codex not signed in."),
            formerUsageAbsent:
              meters.length === 0 &&
              !input.formerUsageLabels.some((label) => text(detail).includes(label)),
          }
        : {
            selectedServerNamed: rail !== null,
            usageWindowsVisible: meters.length === input.usageLabels.length && meters.length > 0,
            usagePercentMatched: input.usageLabels.every((label) => text(detail).includes(label)),
            resetNeverConsumed: detail?.querySelector('button[aria-label^="Reset"]') === null,
          };
  } else if (input.scene === "remote-rename") {
    target = one('[data-slot="dialog-popup"][role="dialog"]');
    const field = target?.querySelector('input[aria-label="Server name"]') ?? null,
      save = button(target, "Save"),
      cancel = button(target, "Cancel");
    if (field) critical.push(field);
    if (save) critical.push(save);
    if (cancel) critical.push(cancel);
    facts = {
      renameDialog: text(target).includes("Rename server"),
      currentNameRetained: field instanceof HTMLInputElement && field.value === input.originalLabel,
      deviceOnlyCopy: text(target).includes("The new name shows on this device only."),
      saveAndCancelVisible:
        save !== null &&
        cancel !== null &&
        !save.hasAttribute("disabled") &&
        !cancel.hasAttribute("disabled"),
    };
  } else if (input.scene === "receiving-settings-row") {
    const names = all("h3").filter((value) => text(value) === input.environmentLabel);
    target =
      names.length === 1 ? (names[0]!.parentElement?.parentElement?.parentElement ?? null) : null;
    const reasons = Array.from(target?.querySelectorAll('[role="status"]') ?? []).filter(visible);
    if (names[0]) critical.push(names[0]);
    if (reasons.length === 1) critical.push(reasons[0]!);
    facts = {
      receivingNotice: text(target).includes(
        "Receiving settings from " + input.environmentLabel + " over a slow connection",
      ),
      rowNamed: names.length === 1,
      reasonVisible: target !== null && reasons.length === 1,
      sameSelection: rail !== null,
    };
  } else {
    target = one('[data-center-surface-host][data-visible="true"]');
    const projects = all('[data-testid="sidebar-project-list"]').filter((value) =>
      text(value).includes(input.projectTitle),
    );
    if (input.scene === "remote-receiving-settings") {
      const banners = Array.from(target?.querySelectorAll('[role="alert"]') ?? []).filter(visible),
        banner =
          banners.find((value) =>
            text(value).includes(
              "Receiving settings from " + input.environmentLabel + " over a slow connection",
            ),
          ) ?? null;
      if (banner) critical.push(banner);
      const cards = all(
          `[data-testid="${input.workspaceKind === "primary" ? "primary-card-button-" + input.projectId : "thread-card-button-" + input.threadId}"][aria-current="page"]`,
        ),
        editors = Array.from(
          target?.querySelectorAll(
            '[data-chat-composer-form="true"] [data-testid="composer-editor"]',
          ) ?? [],
        ).filter(visible);
      if (cards.length === 1) critical.push(cards[0]!);
      if (editors.length === 1) critical.push(editors[0]!);
      facts = {
        receivingNotice: banner !== null,
        cachedProjectRetained: projects.length === 1 && cards.length === 1,
        noFalseEmpty: !all("body").some((value) => text(value).includes("No projects yet")),
        composerDisabled:
          editors.length === 1 &&
          editors[0]!.getAttribute("contenteditable") === "false" &&
          editors[0]!.getAttribute("role") === "textbox",
      };
    } else {
      const context = one('[data-testid="environment-context-card"]');
      if (context) critical.push(context);
      // The unchanged reported server name is a mandatory decoded-source join,
      // while this reader proves only the public local alias/selection state.
      facts = {
        savedNameCoherent: text(context).includes(input.environmentLabel),
        sameSelection: rail !== null,
        connectionRetained: visible(connected),
      };
    }
  }
  const inView = (node: Element | null, requireHit = true) => {
    if (!visible(node)) return false;
    const box = node.getBoundingClientRect();
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
      return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent),
        bounds = parent.getBoundingClientRect();
      if (
        (["auto", "scroll", "hidden", "clip"].includes(style.overflowX) &&
          (box.left < bounds.left || box.right > bounds.right)) ||
        (["auto", "scroll", "hidden", "clip"].includes(style.overflowY) &&
          (box.top < bounds.top || box.bottom > bounds.bottom))
      )
        return false;
    }
    if (!requireHit) return true;
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
      rail !== null &&
      rail.getAttribute("aria-label") ===
        (input.environmentId === "local" ? "Local — this machine" : input.environmentLabel) &&
      visible(connectedOrConfiguring),
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView:
      innerWidth === 1280 &&
      innerHeight === 960 &&
      inView(target) &&
      critical.every((node) => inView(node)) &&
      passive.every((node) => inView(node, false)),
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    unrelatedModalAbsent: all('[role="dialog"],[role="alertdialog"]').every(
      (node) => node === target || target?.contains(node) === true,
    ),
    ...facts,
  };
}
export async function captureSettingsFollowup(
  input: SettingsFollowupObservation & {
    browser: QualificationBrowser;
    owner: Pick<QualificationOwner, "until">;
    evidence: string;
    captured: Set<string>;
    verifyOwnedIdentity: () => Promise<void>;
  },
) {
  const { browser, owner, evidence, captured, verifyOwnedIdentity, ...observation } = input;
  if (captured.size >= 18) throw new Error("Owned settings follow-up capture refused.");
  return captureOwnedVisualScene({
    browser,
    owner,
    evidence,
    captured,
    file: input.scene + "-" + input.theme + ".png",
    observation: () => observation,
    read: (value) => browser.execute(readSettingsFollowup, value),
    verifyOwnedIdentity,
    validate: (value) => validateSettingsFollowupWitness(input.scene, value),
    project: (value) =>
      projectSettingsFollowupCapture({
        ...value,
        scene: input.scene,
        parentRow: settingsFollowupParentRow[input.scene],
        theme: input.theme,
      }),
    refused: () => new Error("Owned settings follow-up capture refused."),
  });
}
