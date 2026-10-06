import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";

export const browserFollowupRows = [
  "chat-staged-attachment",
  "terminal-shared-size",
  "source-control-panel",
  "slow-requests",
  "hosted-pair-confirm",
  "hosted-pair-incomplete",
] as const;
export const browserFollowupScenes = [
  ...browserFollowupRows,
  "source-control-panel-overview",
] as const;
export type BrowserFollowupRow = (typeof browserFollowupRows)[number];
export type BrowserFollowupScene = (typeof browserFollowupScenes)[number];
export const browserFollowupHostedOrigin = "http://127.0.0.1:4893";
export interface BrowserFollowupObservation {
  scene: BrowserFollowupScene;
  theme: "light" | "dark";
  origin: "http://127.0.0.1:4885" | typeof browserFollowupHostedOrigin;
  environmentId: string;
  threadId: string;
  projectId: string;
  terminalId: string;
  terminalLabel: string;
  environmentLabel: string;
  hostedHost: string;
}
/** Close the WebDriver observation packet before serialization; private source credentials stay in owner closures. */
export function admitBrowserFollowupObservation(input: unknown): BrowserFollowupObservation {
  const keys = [
    "scene",
    "theme",
    "origin",
    "environmentId",
    "threadId",
    "projectId",
    "terminalId",
    "terminalLabel",
    "environmentLabel",
    "hostedHost",
  ];
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    throw new Error("Owned browser follow-up observation refused.");
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const own = Object.getOwnPropertyDescriptor(input, key);
    if (!own?.enumerable || !Object.hasOwn(own, "value"))
      throw new Error("Owned browser follow-up observation refused.");
    values[key] = own.value;
  }
  const scene = values.scene as BrowserFollowupScene;
  if (
    !browserFollowupScenes.includes(scene) ||
    !["light", "dark"].includes(values.theme as string) ||
    values.origin !==
      (scene.startsWith("hosted-pair-") ? browserFollowupHostedOrigin : "http://127.0.0.1:4885") ||
    ![values.environmentId, values.threadId, values.projectId, values.terminalId].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    ![values.terminalLabel, values.environmentLabel].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9 -]{1,64}$/.test(value),
    ) ||
    values.hostedHost !== "127.0.0.1:4887"
  )
    throw new Error("Owned browser follow-up observation refused.");
  return values as unknown as BrowserFollowupObservation;
}
const common = [
  "themeMatched",
  "viewportMatched",
  "routeMatched",
  "selectedMatched",
  "credentialAbsent",
  "bootShellAbsent",
  "unrelatedModalAbsent",
  "targetInView",
];
const sceneFacts: Record<BrowserFollowupScene, readonly string[]> = {
  "chat-staged-attachment": ["uploadProgressMatched", "cancelMatched", "draftMatched"],
  "terminal-shared-size": [
    "sameTerminalMounted",
    "sizeNoticeMatched",
    "fitMatched",
    "terminalRendererMatched",
    "terminalTabMatched",
  ],
  "source-control-panel": [
    "rightPanelMatched",
    "sourceControlTabMatched",
    "diffTabMatched",
    "workingTreeMatched",
    "splitMatched",
    "originalPatchRendered",
  ],
  "source-control-panel-overview": [
    "rightPanelMatched",
    "sourceControlTabMatched",
    "commitControlMatched",
    "changeRowMatched",
    "changeActionMatched",
    "commitsMatched",
  ],
  "slow-requests": [
    "indicatorMatched",
    "requestMatched",
    "thresholdMatched",
    "startedTimeMatched",
    "persistentToastAbsent",
  ],
  "hosted-pair-confirm": [
    "confirmMatched",
    "hostMatched",
    "explicitConsentMatched",
    "manualFieldsAbsent",
    "tokenAbsent",
  ],
  "hosted-pair-incomplete": [
    "missingGuidanceMatched",
    "submitAbsent",
    "manualFieldsAbsent",
    "tokenAbsent",
  ],
};
export function browserFollowupFacts(scene: BrowserFollowupScene): readonly string[] {
  if (!browserFollowupScenes.includes(scene))
    throw new Error("Owned browser follow-up scene refused.");
  return [...common, ...sceneFacts[scene]];
}
export function validateBrowserFollowupWitness(
  scene: BrowserFollowupScene,
  value: unknown,
): Record<string, true> {
  const keys = browserFollowupFacts(scene);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new Error("Owned browser follow-up witness refused.");
  const result: Record<string, true> = {};
  for (const key of keys) {
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (!own?.enumerable || !Object.hasOwn(own, "value") || own.value !== true)
      throw new Error("Owned browser follow-up witness refused.");
    result[key] = true;
  }
  return result;
}
/** Serialized read-only observer: no runtime imports, URL erasure, renderer state, or synthetic event. */
export function readBrowserFollowupWitness(
  input: BrowserFollowupObservation,
): Record<string, boolean> | null {
  const scenes = [
    "chat-staged-attachment",
    "terminal-shared-size",
    "source-control-panel",
    "slow-requests",
    "hosted-pair-confirm",
    "hosted-pair-incomplete",
    "source-control-panel-overview",
  ];
  const hosted = input.scene.startsWith("hosted-pair-");
  if (
    !scenes.includes(input.scene) ||
    !["light", "dark"].includes(input.theme) ||
    input.origin !== (hosted ? "http://127.0.0.1:4893" : "http://127.0.0.1:4885") ||
    location.origin !== input.origin ||
    ![input.environmentId, input.threadId, input.projectId, input.terminalId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    !/^[A-Za-z0-9 -]{1,64}$/.test(input.environmentLabel) ||
    !/^[A-Za-z0-9 -]{1,64}$/.test(input.terminalLabel) ||
    !/^127\.0\.0\.1:[0-9]{4}$/.test(input.hostedHost)
  )
    return null;
  const all = (selector: string, scope: ParentNode = document): Element[] =>
    Array.from(scope.querySelectorAll(selector));
  const one = (selector: string, scope: ParentNode = document): Element | null => {
    const values = all(selector, scope);
    return values.length === 1 ? values[0]! : null;
  };
  const text = (node: Element | null) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const byText = (selector: string, value: string, scope: ParentNode = document) => {
    const values = all(selector, scope).filter((node) => text(node) === value);
    return values.length === 1 ? values[0]! : null;
  };
  const visible = (node: Element | null) => {
    if (!node || node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const box = node.getBoundingClientRect(),
      style = getComputedStyle(node);
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      style.display === "none" ||
      style.visibility !== "visible" ||
      Number(style.opacity) === 0 ||
      box.left < 0 ||
      box.top < 0 ||
      box.right > innerWidth ||
      box.bottom > innerHeight
    )
      return false;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const clip = ancestor.getBoundingClientRect(),
        computed = getComputedStyle(ancestor);
      if (
        computed.display === "none" ||
        computed.visibility !== "visible" ||
        Number(computed.opacity) === 0
      )
        return false;
      if (
        ["auto", "scroll", "hidden", "clip"].includes(computed.overflowX) &&
        (box.left < clip.left || box.right > clip.right)
      )
        return false;
      if (
        ["auto", "scroll", "hidden", "clip"].includes(computed.overflowY) &&
        (box.top < clip.top || box.bottom > clip.bottom)
      )
        return false;
    }
    return [
      [box.left + box.width / 2, box.top + 1],
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.bottom - 1],
    ].every(([x, y]) => {
      let hit = document.elementFromPoint(x!, y!);
      for (let depth = 0; hit?.shadowRoot && depth < 8; depth++) {
        const next = hit.shadowRoot.elementFromPoint(x!, y!);
        if (next === null || next === hit) break;
        hit = next;
      }
      return hit !== null && (hit === node || node.contains(hit));
    });
  };
  const panel = one("[data-preview-panel-mode]");
  const tabs = one("[data-right-panel-tab-list]");
  const sourceTab = tabs && byText("button", "Source Control", tabs);
  const diffTab = tabs && byText("button", "Diff", tabs);
  const active = (node: Element | null) =>
    node?.closest('[data-active-tab="true"]') !== null && node !== null;
  const railId =
    input.environmentId === "local"
      ? "environment-rail-local"
      : "environment-rail-entry-" + input.environmentId;
  const cardSelected =
    one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`) ||
    one(`[data-testid="primary-card-button-${input.projectId}"][aria-current="page"]`);
  const rail = one(`[data-testid="${railId}"][aria-checked="true"]`);
  const section = hosted ? one("section") : null;
  const parameters = new URLSearchParams(location.search);
  const secret =
    parameters.has("token") ||
    parameters.has("code") ||
    new URLSearchParams(location.hash.replace(/^#/, "")).has("token") ||
    new URLSearchParams(location.hash.replace(/^#/, "")).has("code");
  const manualFieldsAbsent =
    document.querySelector("#pairing-token") === null &&
    document.querySelector(
      'input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
    ) === null;
  const facts: Record<string, boolean> = {};
  const targets: Array<Element | null> = [];
  switch (input.scene) {
    case "chat-staged-attachment": {
      const notices = all('p[role="status"]').filter((node) =>
        /^Uploading 1 attachment — [0-9.]+ of 512 KiB$/.test(text(node)),
      );
      const notice = notices.length === 1 ? notices[0]! : null;
      const cancel = notice?.parentElement
        ? byText("button", "Cancel", notice.parentElement)
        : null;
      const editor = one(
        '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]',
      );
      facts.uploadProgressMatched = notice !== null;
      facts.cancelMatched = cancel instanceof HTMLButtonElement && !cancel.disabled;
      facts.draftMatched = text(editor) === "Owned visual review draft";
      targets.push(notice, cancel, editor);
      break;
    }
    case "terminal-shared-size": {
      const mount = one(`[data-terminal-xterm-mount="${input.terminalId}"]`);
      const frame = mount?.parentElement ?? null;
      const fit = frame && byText("button", "Fit to this window", frame);
      const notice = frame && byText("span", "Sized for another window.", frame);
      const renderer = mount && one(".xterm-screen", mount);
      const tab = tabs && byText("button", input.terminalLabel, tabs);
      facts.sameTerminalMounted = mount !== null;
      facts.sizeNoticeMatched = notice !== null;
      facts.fitMatched = fit instanceof HTMLButtonElement && !fit.disabled;
      facts.terminalRendererMatched =
        renderer !== null &&
        (all("canvas", renderer).some(
          (canvas) => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0,
        ) ||
          renderer.querySelector(".xterm-rows") !== null);
      facts.terminalTabMatched = active(tab);
      targets.push(notice, fit, renderer, tab);
      break;
    }
    case "source-control-panel": {
      const split = one('[aria-label="Split diff view"]');
      const scope = one('button[aria-label="Diff scope: Working tree"]');
      const hosts = panel ? all("diffs-container", panel) : [];
      const diff = hosts.flatMap((host) =>
        host.shadowRoot ? all("pre[data-diff-type]", host.shadowRoot) : [],
      );
      facts.rightPanelMatched = panel !== null;
      facts.sourceControlTabMatched = sourceTab !== null;
      facts.diffTabMatched = active(diffTab);
      facts.workingTreeMatched = scope !== null;
      facts.splitMatched = split?.getAttribute("aria-pressed") === "true";
      const original = diff.filter(
        (node) => text(node).includes("changed one") && text(node).includes("original one"),
      );
      facts.originalPatchRendered = original.length === 1;
      targets.push(
        panel,
        sourceTab,
        diffTab,
        split,
        scope,
        original.length === 1 ? original[0]! : null,
      );
      break;
    }
    case "source-control-panel-overview": {
      const commit = panel && one('[aria-label="Commit message"]', panel);
      const stage = panel && one('[aria-label="Stage pierre-step5.ts"]', panel);
      const row = stage?.parentElement
        ? one('button[title="pierre-step5.ts"]', stage.parentElement)
        : null;
      const commitRows = panel
        ? all("span", panel).filter((node) => text(node) === "Visual qualification baseline")
        : [];
      facts.rightPanelMatched = panel !== null;
      facts.sourceControlTabMatched = active(sourceTab);
      facts.commitControlMatched = commit !== null;
      facts.changeRowMatched = row !== null;
      facts.changeActionMatched =
        stage instanceof HTMLElement &&
        stage.getAttribute("aria-disabled") !== "true" &&
        !(stage instanceof HTMLButtonElement && stage.disabled);
      facts.commitsMatched = commitRows.length === 1;
      targets.push(sourceTab, commit, row, stage, commitRows[0] ?? null);
      break;
    }
    case "slow-requests": {
      const bar = one("[data-status-bar]");
      const indicator = bar && byText("button", "1 slow request", bar);
      const title = byText("h2,[data-slot=popover-title]", "Slow requests");
      const popup = title?.closest('[data-slot="popover-popup"]') ?? null;
      const request =
        popup && byText("li div", "server.getTraceDiagnostics · " + input.environmentLabel, popup);
      const started = popup && one("time[datetime]", popup);
      facts.indicatorMatched = indicator?.getAttribute("aria-expanded") === "true";
      facts.requestMatched = request !== null;
      facts.thresholdMatched = text(popup).includes("Waiting more than 15 seconds for a response.");
      facts.startedTimeMatched =
        started !== null &&
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(started.getAttribute("datetime") ?? "");
      facts.persistentToastAbsent = !all('[data-slot="toast-content"],[role="alert"]').some(
        (node) => /slow request|waiting.*response/i.test(text(node)),
      );
      targets.push(indicator, popup, request, started);
      break;
    }
    case "hosted-pair-confirm": {
      const heading = section && byText("h1", "Pair this backend", section);
      const submit = section && byText("button", "Pair this backend", section);
      const host = section && byText("span", input.hostedHost, section);
      facts.confirmMatched = heading !== null;
      facts.hostMatched = host !== null;
      facts.explicitConsentMatched =
        submit instanceof HTMLButtonElement &&
        !submit.disabled &&
        text(section).includes(
          "Review the backend address before submitting this one-time pairing token.",
        );
      facts.manualFieldsAbsent =
        manualFieldsAbsent && document.querySelector("input,textarea") === null;
      facts.tokenAbsent = !secret;
      targets.push(section, heading, submit, host);
      break;
    }
    case "hosted-pair-incomplete": {
      const heading = section && byText("h1", "Pairing failed", section);
      const message =
        section &&
        byText(
          "p",
          "This pairing link is missing its backend host or token. Open the complete link again, or create a new pairing link on the backend.",
          section,
        );
      facts.missingGuidanceMatched = heading !== null && message !== null;
      facts.submitAbsent = document.querySelector("button") === null;
      facts.manualFieldsAbsent =
        manualFieldsAbsent && document.querySelector("input,textarea") === null;
      facts.tokenAbsent = !secret;
      targets.push(section, heading, message);
      break;
    }
  }
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    viewportMatched: innerWidth === 1280 && innerHeight === 960,
    routeMatched: hosted
      ? location.pathname === "/pair" &&
        parameters.get("host") === "http://" + input.hostedHost &&
        [...parameters.keys()].every((key) => ["host", "label"].includes(key)) &&
        location.hash === ""
      : input.scene === "slow-requests"
        ? location.pathname === "/settings/diagnostics" && !location.search && !location.hash
        : location.pathname ===
            "/" +
              encodeURIComponent(input.environmentId) +
              "/" +
              encodeURIComponent(input.threadId) &&
          !location.search &&
          !location.hash,
    selectedMatched: hosted
      ? cardSelected === null && Reflect.get(window, "desktopBridge") === undefined
      : rail !== null &&
        rail.getAttribute("aria-label") ===
          (input.environmentId === "local" ? "Local — this machine" : input.environmentLabel) &&
        rail.querySelector('[data-status="connected"]') !== null &&
        (input.scene === "slow-requests" || cardSelected !== null),
    credentialAbsent: manualFieldsAbsent && !secret,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    unrelatedModalAbsent: document.querySelector('[role="dialog"],[role="alertdialog"]') === null,
    targetInView: targets.length > 0 && targets.every(visible),
    ...facts,
  };
}

export function projectBrowserFollowupCapture(input: unknown) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Owned browser follow-up capture refused.");
  const keys = ["scene", "theme", "file", "width", "height", "nonBlank", "sha256", "witness"];
  if (Reflect.ownKeys(input).length !== keys.length)
    throw new Error("Owned browser follow-up capture refused.");
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const own = Object.getOwnPropertyDescriptor(input, key);
    if (!own?.enumerable || !Object.hasOwn(own, "value"))
      throw new Error("Owned browser follow-up capture refused.");
    values[key] = own.value;
  }
  const scene = values.scene as BrowserFollowupScene;
  if (
    !browserFollowupScenes.includes(scene) ||
    !["light", "dark"].includes(values.theme as string) ||
    values.file !== scene + "-" + values.theme + ".png" ||
    values.width !== 1280 ||
    values.height !== 960 ||
    values.nonBlank !== true ||
    typeof values.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(values.sha256)
  )
    throw new Error("Owned browser follow-up capture refused.");
  return {
    scene,
    parentRow: scene === "source-control-panel-overview" ? "source-control-panel" : scene,
    theme: values.theme as "light" | "dark",
    file: values.file as string,
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: values.sha256,
    witness: validateBrowserFollowupWitness(scene, values.witness),
    baseOriginal: scene !== "source-control-panel-overview",
  } as const;
}
export function validateBrowserFollowupJoins(
  input: readonly ReturnType<typeof projectBrowserFollowupCapture>[],
) {
  const keys = [
    "scene",
    "parentRow",
    "theme",
    "file",
    "width",
    "height",
    "nonBlank",
    "sha256",
    "witness",
    "baseOriginal",
  ];
  if (
    !Array.isArray(input) ||
    input.some(
      (value) =>
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Reflect.ownKeys(value).length !== keys.length ||
        keys.some((key) => {
          const own = Object.getOwnPropertyDescriptor(value, key);
          return !own?.enumerable || !Object.hasOwn(own, "value");
        }),
    )
  )
    throw new Error("Owned browser follow-up joins refused.");
  if (input.length !== 14 || new Set(input.map((value) => value.file)).size !== 14)
    throw new Error("Owned browser follow-up joins refused.");
  for (const theme of ["light", "dark"] as const)
    for (const scene of browserFollowupScenes) {
      const entries = input.filter((value) => value.scene === scene && value.theme === theme);
      if (entries.length !== 1) throw new Error("Owned browser follow-up joins refused.");
      const value = entries[0]!;
      const checked = projectBrowserFollowupCapture({
        scene: value.scene,
        theme: value.theme,
        file: value.file,
        width: value.width,
        height: value.height,
        nonBlank: value.nonBlank,
        sha256: value.sha256,
        witness: value.witness,
      });
      if (value.parentRow !== checked.parentRow || value.baseOriginal !== checked.baseOriginal)
        throw new Error("Owned browser follow-up joins refused.");
    }
  return { rows: 6, baseOriginals: 12, supplements: 2, completeGroup: false } as const;
}
export async function captureBrowserFollowupScene(input: {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  evidence: string;
  captured: Set<string>;
  observation: BrowserFollowupObservation;
  verifySource: () => Promise<void>;
}) {
  const observation = admitBrowserFollowupObservation(input.observation);
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    captured: input.captured,
    file: observation.scene + "-" + observation.theme + ".png",
    observation: () => observation,
    read: (value) => input.browser.execute(readBrowserFollowupWitness, value),
    verifyOwnedIdentity: input.verifySource,
    validate: (value) => validateBrowserFollowupWitness(observation.scene, value),
    project: (value) =>
      projectBrowserFollowupCapture({
        scene: observation.scene,
        theme: observation.theme,
        ...value,
      }),
    refused: () => new Error("Owned browser follow-up capture refused."),
  });
}
