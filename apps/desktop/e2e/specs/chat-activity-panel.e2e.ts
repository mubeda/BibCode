// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests retain native acceptance artifacts.
import { installDesktopUiMotionGuard, setDesktopUiMotionMode } from "../support/motion-guard.ts";
import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  configureDesktopActivityCodexExecutable,
  materializeDesktopActivitySession,
  startDesktopActivityComposerFollowupTurn,
  startDesktopActivityFollowupTurn,
} from "../support/activity-session.ts";
import {
  desktopActivityAccessibleNames,
  desktopActivityFixture,
} from "../support/activity-events.ts";
import {
  describeDesktopUiFocus,
  type DesktopUiFocusedElement,
  type DesktopUiKeyboardResult,
  focusDesktopUiElement,
  sendFocusedKeyboardKey,
} from "../support/keyboard-input.ts";
import { mermaidFixturePrompts } from "../support/mermaid-fixture.ts";
import { clearDesktopActivityMarker } from "../support/test-project.ts";
import { ensureMainSidebarOpen, setDesktopUiWindowSize } from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const shimDirectory = process.env.BIBCODE_E2E_SHIM_DIRECTORY;
if (!artifactDirectory || !projectPath || !shimDirectory) {
  throw new Error("The packaged desktop UI fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const isWindowsE2e = process.env.BIBCODE_E2E_PLATFORM === "win";
const supportsCodexTerminalActivity = !isWindowsE2e;
const preparedCodexExecutable = NodePath.join(shimDirectory, isWindowsE2e ? "codex.cmd" : "codex");

afterEach(async () => {
  try {
    clearDesktopActivityMarker(preparedProjectPath);
  } finally {
    await restoreRuntimeMotionEmulation();
  }
});

interface RectSnapshot {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface ActivityGeometry {
  readonly chatSurface: RectSnapshot;
  readonly composer: RectSnapshot;
  readonly dock: RectSnapshot;
  readonly workspaceHeader: RectSnapshot;
  readonly inspector: RectSnapshot | null;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

interface TimelineScroll {
  readonly scrollTop: number;
  readonly distanceFromEnd: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

interface SurfacePresentation {
  readonly background: string;
  readonly foreground: string;
  readonly focusRing: string;
}

interface RuntimeMotionPresentation {
  readonly activeTransitionProperties: ReadonlyArray<string>;
  readonly countActiveTransitionProperties: ReadonlyArray<string>;
}

interface ProviderTerminalGeometry {
  readonly dock: RectSnapshot;
  readonly host: RectSnapshot;
  readonly owner: RectSnapshot;
  readonly toolbar: RectSnapshot;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}

function rectanglesOverlap(left: RectSnapshot, right: RectSnapshot): boolean {
  return (
    Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
    Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top)
  );
}

function isFullyContainedInViewport(
  rectangle: RectSnapshot,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  return (
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.top >= 0 &&
    rectangle.left >= 0 &&
    rectangle.bottom <= viewportHeight &&
    rectangle.right <= viewportWidth
  );
}

async function openMaterializedFixtureChat(): Promise<{
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly threadId: string;
}> {
  await ensureMainSidebarOpen();
  const materialized = await materializeDesktopActivitySession(preparedProjectPath);
  await configureDesktopActivityCodexExecutable(preparedCodexExecutable);
  expect(materialized.threadId).toBe(desktopActivityFixture.thread.id);
  expect(materialized.projectId).not.toBe("");
  expect(materialized.providerInstanceId).toBe("codex");
  NodeFS.writeFileSync(
    NodePath.join(preparedArtifactDirectory, "activity-materialization.json"),
    JSON.stringify(
      {
        ...materialized,
      },
      null,
      2,
    ),
  );
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  await browser.waitUntil(
    async () => {
      for (const project of await browser.$$(
        `//*[normalize-space()="${desktopActivityFixture.project.title}"]`,
      )) {
        if (await project.isDisplayed()) return true;
      }
      return false;
    },
    { timeoutMsg: "The RPC-materialized activity project did not enter the connected shell." },
  );
  const activityThreadSelector = `//*[starts-with(@data-testid, "thread-row-") and .//*[normalize-space()="${desktopActivityFixture.thread.title}"]]`;
  const activityProject = browser.$(
    `//button[@data-sidebar="menu-button" and .//*[normalize-space()="${desktopActivityFixture.project.title}"]]`,
  );
  if (!(await browser.$(activityThreadSelector).isDisplayed())) {
    await activityProject.waitForDisplayed();
    if ((await activityProject.getAttribute("aria-expanded")) !== "true") {
      await activityProject.click();
    }
    await browser.$(activityThreadSelector).waitForDisplayed({
      timeoutMsg: "The RPC-materialized activity thread did not expand in the main sidebar.",
    });
  }
  let openedActivityThread = false;
  for (const candidate of await browser.$$(activityThreadSelector)) {
    if (await candidate.isDisplayed()) {
      await candidate.click();
      openedActivityThread = true;
      break;
    }
  }
  if (!openedActivityThread) {
    throw new Error("The RPC-materialized activity thread was not visible in the main sidebar.");
  }
  const composer = browser.$('[data-testid="composer-editor"]');
  await composer.waitForExist();
  if (!(await composer.isDisplayed())) {
    const mainPanel = browser.$(
      '//*[@data-center-panel-tab-list]//button[.//span[normalize-space()="Codex"]]',
    );
    if (await mainPanel.isExisting()) {
      await mainPanel.click();
    }
  }
  await composer.waitForDisplayed({
    timeoutMsg: "The RPC-materialized activity thread route did not open.",
  });
  for (;;) {
    const closeTerminal = browser.$('button[aria-label="Close Codex Terminal"]');
    if (!(await closeTerminal.isExisting())) break;
    const previousCount = (await browser.$$('button[aria-label="Close Codex Terminal"]')).length;
    await closeTerminal.click();
    await browser.waitUntil(
      async () =>
        (await browser.$$('button[aria-label="Close Codex Terminal"]')).length < previousCount,
      { timeoutMsg: "A persisted Codex terminal panel did not close." },
    );
  }
  await expect(browser.$('[data-testid="activity-dock"]')).toBeDisplayed();
  return materialized;
}

async function readActivityGeometry(): Promise<ActivityGeometry> {
  return browser.execute(() => {
    const rectangle = (
      selector: string,
      required: boolean,
      allowModalInert = false,
    ): RectSnapshot | null => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        if (required) throw new Error(`Required geometry element is missing: ${selector}`);
        return null;
      }
      const style = getComputedStyle(element);
      if (
        element.hidden ||
        (!allowModalInert && element.closest("[hidden], [inert], [aria-hidden='true']")) ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        throw new Error(`Geometry element is not visibly rendered: ${selector}`);
      }
      const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    return {
      chatSurface: rectangle("[data-chat-surface]:has([data-activity-pane])", true, true)!,
      composer: rectangle('[data-chat-composer-form="true"]', true, true)!,
      dock: rectangle('[data-testid="activity-dock"]', true, true)!,
      workspaceHeader: rectangle("[data-center-panel-group-header]", true, true)!,
      inspector: rectangle("[data-activity-panel]", false),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

/** The chat timeline's scroll position: LegendList's scroller is the one without overflow anchoring. */
async function readTimelineScroll(): Promise<TimelineScroll> {
  return browser.execute((): TimelineScroll => {
    const scroller = document.querySelector<HTMLElement>(
      "[data-chat-surface]:has([data-activity-pane]) [class*='overflow-anchor']",
    );
    if (!scroller) throw new Error("The chat timeline scroller is missing.");
    return {
      scrollTop: Math.round(scroller.scrollTop),
      distanceFromEnd: Math.round(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      ),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(scroller.clientHeight),
    };
  });
}

/** Opening or closing the panel above the composer must not move what the user reads. */
function expectReadingPositionKept(before: TimelineScroll, after: TimelineScroll): void {
  const kept =
    before.distanceFromEnd <= 2
      ? after.distanceFromEnd <= 2
      : Math.abs(after.scrollTop - before.scrollTop) <= 1;
  if (!kept) {
    throw new Error(
      `Toggling the Activity panel moved the chat's reading position: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
    );
  }
}

async function readPersistedPanelState(): Promise<{
  readonly rightPanel: string | null;
  readonly activityPaneThreadKeys: ReadonlyArray<string>;
}> {
  return browser.execute(() => {
    const center = window.localStorage.getItem("bibcode:center-panel-state:v1");
    const decoded = center
      ? (JSON.parse(center) as { readonly state?: { readonly activityPanes?: object } })
      : null;
    return {
      rightPanel: window.localStorage.getItem("bibcode:right-panel-state:v2"),
      activityPaneThreadKeys: Object.keys(decoded?.state?.activityPanes ?? {}),
    };
  });
}

async function expectDockExpanded(expanded: boolean): Promise<void> {
  const dock = browser.$(
    `[data-chat-composer-overlay] button[aria-label="${desktopActivityAccessibleNames.dock}"]`,
  );
  await browser.waitUntil(
    async () => (await dock.getAttribute("aria-expanded")) === String(expanded),
    { timeoutMsg: `The Activity button did not report aria-expanded=${expanded}.` },
  );
  if (expanded) {
    const controls = await dock.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(
      await browser.execute(
        (id: string) =>
          document.getElementById(id)?.querySelector("[data-activity-panel]") !== null,
        controls!,
      ),
    ).toBe(true);
  }
}

async function assertBoundedActivityGeometry(
  width: 960 | 980 | 981 | 1_199 | 1_200,
  expectInspector: boolean,
): Promise<void> {
  await setDesktopUiWindowSize(width, 720);
  await browser.waitUntil(
    async () => {
      const candidate = await readActivityGeometry();
      return (
        candidate.viewportWidth === width &&
        [candidate.workspaceHeader, candidate.dock, candidate.composer].every((rectangle) =>
          isFullyContainedInViewport(rectangle, candidate.viewportWidth, candidate.viewportHeight),
        )
      );
    },
    {
      timeoutMsg: `The activity surface did not settle inside the ${width}px viewport after resize.`,
    },
  );
  const geometry = await readActivityGeometry();
  expect(geometry.viewportWidth).toBe(width);
  for (const [name, rectangle] of [
    ["workspace header", geometry.workspaceHeader],
    ["activity dock", geometry.dock],
    ["composer", geometry.composer],
  ] as const) {
    if (!isFullyContainedInViewport(rectangle, geometry.viewportWidth, geometry.viewportHeight)) {
      throw new Error(
        `${name} escaped the ${geometry.viewportWidth}x${geometry.viewportHeight} viewport: ${JSON.stringify(rectangle)}`,
      );
    }
  }
  expect(geometry.dock.top).toBeGreaterThanOrEqual(geometry.workspaceHeader.bottom);
  expect(rectanglesOverlap(geometry.dock, geometry.composer)).toBe(false);
  expect(geometry.dock.bottom).toBeLessThanOrEqual(geometry.composer.top + 1);
  if (expectInspector) {
    // Inline in the chat pane, directly above its own button and the composer,
    // never in a sheet or the right panel.
    const inspector = geometry.inspector;
    expect(inspector).not.toBeNull();
    expect(
      isFullyContainedInViewport(inspector!, geometry.viewportWidth, geometry.viewportHeight),
    ).toBe(true);
    expect(inspector!.left).toBeGreaterThanOrEqual(geometry.chatSurface.left - 1);
    expect(inspector!.right).toBeLessThanOrEqual(geometry.chatSurface.right + 1);
    expect(inspector!.top).toBeGreaterThanOrEqual(geometry.workspaceHeader.bottom - 1);
    expect(inspector!.bottom).toBeLessThanOrEqual(geometry.dock.top + 1);
    expect(rectanglesOverlap(geometry.dock, inspector!)).toBe(false);
    expect(rectanglesOverlap(geometry.composer, inspector!)).toBe(false);
    expect(geometry.composer.height).toBeGreaterThan(0);
  } else {
    expect(geometry.inspector).toBeNull();
  }
  await expectMissing('[role="dialog"] [data-activity-panel]');
}

async function assertActivityPresentation(width: 960 | 980 | 981 | 1_199 | 1_200): Promise<void> {
  await assertBoundedActivityGeometry(width, false);
  const readPresentation = () =>
    browser.execute(() => {
      const dock = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="activity-dock"]'),
      ].find((candidate) => candidate.closest("[data-provider-terminal-activity-host]") === null);
      const summary = dock?.querySelector<HTMLButtonElement>('button[aria-label^="Activity"]');
      if (!dock || !summary) throw new Error("The chat activity summary is missing.");
      return {
        activeCounts: [...summary.querySelectorAll('[data-activity-count="active"]')].map(
          (element) => element.textContent?.trim() ?? "",
        ),
        doneCounts: [...summary.querySelectorAll('[data-activity-count="done"]')].map(
          (element) => element.textContent?.trim() ?? "",
        ),
        glyphCount: summary.querySelectorAll("[data-activity-provider-glyph]").length,
        separatorCount: summary.querySelectorAll("[data-activity-count-separator]").length,
      };
    });
  // The compact layout separates the counts with a dot; the wide one does not.
  const expectedSeparators = width < 1_200 ? 1 : 0;
  await browser.waitUntil(
    async () => (await readPresentation()).separatorCount === expectedSeparators,
    { timeoutMsg: `Activity dock presentation did not settle at ${width}px.` },
  );
  const presentation = await readPresentation();
  expect(presentation.glyphCount).toBe(1);
  expect(presentation.activeCounts).toEqual(["Active 2"]);
  expect(presentation.doneCounts).toEqual(["Done 0"]);
}

async function openCodexProviderTerminal(): Promise<string> {
  const newPanel = browser.$('button[aria-label="New panel"]');
  await newPanel.waitForDisplayed();
  await newPanel.click();
  const codexTerminal = browser.$(
    '//*[@role="menuitem"][.//span[normalize-space()="Codex Terminal"]]',
  );
  await codexTerminal.waitForDisplayed();
  await codexTerminal.waitForEnabled();
  await codexTerminal.click();
  const host = browser.$("[data-provider-terminal-activity-host]");
  await host.waitForExist({
    timeoutMsg: "The eligible Codex provider terminal did not mount its activity host.",
  });
  const terminalId = await host.getAttribute("data-provider-terminal-activity-host");
  if (!terminalId) throw new Error("The provider terminal activity host has no terminal id.");
  const requestedExecutable = await browser.execute((id: string): string | null => {
    const persisted = window.localStorage.getItem("bibcode:center-panel-state:v1");
    if (!persisted) return null;
    const decoded = JSON.parse(persisted) as {
      readonly state?: {
        readonly byThreadKey?: Readonly<
          Record<
            string,
            {
              readonly surfaces?: ReadonlyArray<{
                readonly command?: { readonly executable?: unknown };
                readonly terminalId?: unknown;
              }>;
            }
          >
        >;
      };
    };
    for (const state of Object.values(decoded.state?.byThreadKey ?? {})) {
      const surface = state.surfaces?.find((candidate) => candidate.terminalId === id);
      if (typeof surface?.command?.executable === "string") {
        return surface.command.executable;
      }
    }
    return null;
  }, terminalId);
  expect(requestedExecutable).toBe(preparedCodexExecutable);
  const terminalDock = `[data-provider-terminal-activity-host="${terminalId}"] [data-testid="activity-dock"]`;
  if (supportsCodexTerminalActivity) {
    try {
      await browser.$(terminalDock).waitForDisplayed({
        timeout: 60_000,
        timeoutMsg: "The live Codex terminal activity dock did not become visible.",
      });
    } catch (error) {
      const diagnostics = await browser
        .execute(() => ({
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          elements: [
            ...document.querySelectorAll<HTMLElement>(
              "[data-center-panel-body-target], [data-center-surface-host], [data-provider-terminal-activity-host], [data-provider-terminal-activity-host] [data-testid='activity-dock']",
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              target: element.dataset.centerPanelBodyTarget,
              surface: element.dataset.centerSurfaceHost,
              activityHost: element.dataset.providerTerminalActivityHost,
              visible: element.dataset.visible,
              geometry: element.dataset.centerSurfaceGeometry,
              display: style.display,
              visibility: style.visibility,
              width: rect.width,
              height: rect.height,
            };
          }),
        }))
        .catch((diagnosticError: unknown) => ({ error: String(diagnosticError) }));
      throw new Error(
        `The live Codex terminal activity dock did not become visible. Diagnostics: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
  } else {
    await expectMissing(terminalDock);
  }
  return terminalId;
}

async function assertProviderTerminalGeometry(terminalId: string): Promise<void> {
  const geometry = await browser.execute((id: string): ProviderTerminalGeometry => {
    const visibleRectangle = (element: HTMLElement | null, label: string): RectSnapshot => {
      if (!element) throw new Error(`Missing ${label}.`);
      const style = getComputedStyle(element);
      if (
        element.hidden ||
        element.closest("[hidden], [inert], [aria-hidden='true']") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        throw new Error(`${label} is not visibly rendered.`);
      }
      const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    const host = document.querySelector<HTMLElement>(
      `[data-provider-terminal-activity-host="${CSS.escape(id)}"]`,
    );
    const owner = host?.closest<HTMLElement>("[data-terminal-owner]") ?? null;
    const toolbar = document.querySelector<HTMLElement>("[data-center-panel-group-header]");
    return {
      dock: visibleRectangle(
        host?.querySelector<HTMLElement>('[data-testid="activity-dock"]') ?? null,
        "provider terminal activity dock",
      ),
      host: visibleRectangle(host, "provider terminal activity host"),
      owner: visibleRectangle(owner, "provider terminal owner"),
      toolbar: visibleRectangle(toolbar, "provider terminal toolbar"),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }, terminalId);
  for (const rectangle of [geometry.owner, geometry.host, geometry.toolbar, geometry.dock]) {
    expect(
      isFullyContainedInViewport(rectangle, geometry.viewportWidth, geometry.viewportHeight),
    ).toBe(true);
  }
  expect(geometry.host.left).toBeGreaterThanOrEqual(geometry.owner.left);
  expect(geometry.host.right).toBeLessThanOrEqual(geometry.owner.right);
  expect(geometry.host.top).toBeGreaterThanOrEqual(geometry.toolbar.bottom - 1);
  expect(geometry.dock.left).toBeGreaterThanOrEqual(geometry.host.left);
  expect(geometry.dock.right).toBeLessThanOrEqual(geometry.host.right);
  expect(geometry.dock.top).toBeGreaterThanOrEqual(geometry.host.top);
  expect(rectanglesOverlap(geometry.dock, geometry.toolbar)).toBe(false);
}

async function expectMissing(selector: string): Promise<void> {
  const element = browser.$(selector);
  await element.waitForExist({ reverse: true });
  expect(await element.isExisting()).toBe(false);
}

async function tabTo(
  matches: (element: DesktopUiFocusedElement) => boolean,
  direction: "forward" | "backward" = "forward",
): Promise<DesktopUiFocusedElement> {
  const visited: DesktopUiKeyboardResult[] = [];
  for (let step = 0; step < 20; step += 1) {
    const result = await sendFocusedKeyboardKey("Tab", direction === "backward");
    visited.push(result);
    expect(result.after.tagName).not.toBeNull();
    if (matches(result.after)) return result.after;
  }
  throw new Error(`Tab navigation did not reach the expected control: ${JSON.stringify(visited)}`);
}

/**
 * The button follows the timeline in tab order, above the composer. The composer
 * editor keeps Tab for itself, so the walk starts at the timeline's last control.
 */
async function tabToDockSummary(): Promise<void> {
  const marked = await browser.execute(() => {
    document.querySelector("[data-e2e-tab-start]")?.removeAttribute("data-e2e-tab-start");
    const timeline = document.querySelector<HTMLElement>(
      "[data-chat-surface]:has([data-activity-pane]) [class*='overflow-anchor']",
    );
    const controls = [
      ...(timeline?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], [tabindex='0']",
      ) ?? []),
    ].filter((element) => element.getClientRects().length > 0);
    const last = controls.at(-1);
    last?.setAttribute("data-e2e-tab-start", "");
    return last !== undefined;
  });
  expect(marked).toBe(true);
  await focusDesktopUiElement("[data-e2e-tab-start]");
  const arrived = await tabTo(
    (element) => element.ariaLabel === desktopActivityAccessibleNames.dock,
  );
  expect(arrived).toEqual(
    expect.objectContaining({
      ariaLabel: desktopActivityAccessibleNames.dock,
      tagName: "BUTTON",
    }),
  );
}

async function openSubagentsWithKeyboard(): Promise<{
  readonly enterEvidence: {
    readonly click: number;
    readonly keydown: number;
    readonly keyup: number;
  };
}> {
  await tabToDockSummary();
  const enter = await sendFocusedKeyboardKey("Enter");
  expect(enter.before.ariaLabel).toBe(desktopActivityAccessibleNames.dock);
  const enterEvidence = enter.transport === "webdriver" ? enter.driver : enter.synthetic;
  expect(enterEvidence).toEqual(
    expect.objectContaining({
      click: 1,
      keydown: 1,
      keyup: 1,
    }),
  );
  if (enter.transport === "synthetic") {
    expect(enter.driver).toEqual({
      click: 0,
      focusChanged: false,
      keydown: 0,
      keyup: 0,
    });
  }
  // One press opens the panel on Subagents, the section with running work.
  await browser.$("[data-activity-panel]").waitForExist();
  await browser.$('section[aria-label="Subagents"]').waitForExist();
  return {
    enterEvidence: {
      click: enterEvidence!.click,
      keydown: enterEvidence!.keydown,
      keyup: enterEvidence!.keyup,
    },
  };
}

async function activityRowVisibility(actorId: string): Promise<{
  readonly hasArea: boolean;
  readonly intersectsViewport: boolean;
}> {
  return browser.execute((id: string) => {
    const row = document.querySelector<HTMLElement>(`[data-activity-row$="${id}"]`);
    if (!row) return { hasArea: false, intersectsViewport: false };
    const rectangle = row.getBoundingClientRect();
    return {
      hasArea: rectangle.width > 0 && rectangle.height > 0,
      intersectsViewport:
        rectangle.bottom > 0 &&
        rectangle.left < window.innerWidth &&
        rectangle.right > 0 &&
        rectangle.top < window.innerHeight,
    };
  }, actorId);
}

function rgbChannels(value: string): [number, number, number] {
  const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const color = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)/i);
  if (color) {
    return [Number(color[1]) * 255, Number(color[2]) * 255, Number(color[3]) * 255];
  }
  const oklch = value.match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+(none|[-\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+)?\)/i,
  );
  if (oklch) {
    const lightness = Number(oklch[1]);
    const chroma = Number(oklch[2]);
    const hue = oklch[3] === "none" ? 0 : (Number(oklch[3]) * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    return linear.map((channel) => {
      const clamped = Math.max(0, Math.min(1, channel));
      return 255 * (clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055);
    }) as [number, number, number];
  }
  throw new Error(`Unsupported computed color: ${value}`);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (value: string): number => {
    const channels = rgbChannels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const left = luminance(foreground);
  const right = luminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

async function selectActualTheme(
  theme: "Dark" | "Light",
  threadId: string,
): Promise<{ readonly dock: SurfacePresentation; readonly panel: SurfacePresentation }> {
  const origin = await browser.execute(() => window.location.origin);
  await browser.url(`${origin}/#/settings/general`);
  const themePreference = browser.$('[aria-label="Theme preference"]');
  await themePreference.waitForDisplayed();
  await themePreference.click();
  const option = browser.$(`//*[@role="option" and normalize-space()="${theme}"]`);
  await option.waitForDisplayed();
  await option.click();
  await browser.waitUntil(
    async () => {
      const rootClass = (await browser.$("html").getAttribute("class")) ?? "";
      return theme === "Dark" ? rootClass.includes("dark") : !rootClass.includes("dark");
    },
    { timeoutMsg: `The actual ${theme.toLowerCase()} theme did not become authoritative.` },
  );
  await browser.url(`${origin}/#/primary/${encodeURIComponent(threadId)}`);
  await browser.$('[data-testid="activity-dock"]').waitForDisplayed();
  await tabToDockSummary();
  const dock = await browser.execute((): SurfacePresentation => {
    const summary = document.activeElement;
    const card = summary?.closest<HTMLElement>('[data-testid="activity-dock"] > div') ?? null;
    if (!(summary instanceof HTMLElement) || !card) {
      throw new Error("Cannot inspect the focused activity theme surface.");
    }
    const cardStyle = getComputedStyle(card);
    const focusStyle = getComputedStyle(summary);
    return {
      background: cardStyle.backgroundColor,
      foreground: cardStyle.color,
      focusRing: `${focusStyle.outlineColor}|${focusStyle.boxShadow}`,
    };
  });
  await openSubagentsWithKeyboard();
  await browser.$("[data-activity-panel]").waitForDisplayed();
  await focusDesktopUiElement("[data-activity-panel] button:not([disabled])");
  const panel = await browser.execute((): SurfacePresentation => {
    const root = document.querySelector<HTMLElement>("[data-activity-panel]");
    const focused = document.activeElement;
    if (!root || !(focused instanceof HTMLElement) || !root.contains(focused)) {
      throw new Error("Cannot inspect the focused activity panel theme surface.");
    }
    const rootStyle = getComputedStyle(root);
    const focusStyle = getComputedStyle(focused);
    return {
      background: rootStyle.backgroundColor,
      foreground: rootStyle.color,
      focusRing: `${focusStyle.outlineColor}|${focusStyle.boxShadow}`,
    };
  });
  // Escape inside the panel collapses it; the next scenario starts collapsed.
  await sendFocusedKeyboardKey("Escape");
  await expectMissing("[data-activity-panel]");
  return { dock, panel };
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

async function installRuntimeMotionEmulation(initialMatches: boolean): Promise<void> {
  await browser.execute(
    (query: string, initial: boolean) => {
      interface RuntimeMotionEmulation {
        readonly nativeMatchMedia: typeof window.matchMedia;
        readonly mediaQuery: MediaQueryList;
        readonly restore: () => void;
        readonly set: (matches: boolean) => void;
      }
      const testWindow = window as Window & {
        __bibcodeDesktopUiReducedMotionEmulation?: RuntimeMotionEmulation;
      };
      testWindow.__bibcodeDesktopUiReducedMotionEmulation?.restore();
      const nativeMatchMedia = window.matchMedia;
      const listeners = new Set<EventListenerOrEventListenerObject>();
      let matches = initial;
      let onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
      const dispatch = (
        listener: EventListenerOrEventListenerObject,
        event: MediaQueryListEvent,
      ) => {
        if (typeof listener === "function") {
          listener.call(mediaQuery, event);
        } else {
          listener.handleEvent(event);
        }
      };
      const mediaQuery = {
        get matches() {
          return matches;
        },
        media: query,
        get onchange() {
          return onchange;
        },
        set onchange(listener) {
          onchange = listener;
        },
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (type === "change" && listener !== null) listeners.add(listener);
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
        ) => {
          if (type === "change" && listener !== null) listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener as EventListener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener as EventListener);
        },
        dispatchEvent: (event: Event) => {
          const mediaEvent = event as MediaQueryListEvent;
          for (const listener of listeners) dispatch(listener, mediaEvent);
          onchange?.call(mediaQuery, mediaEvent);
          return !event.defaultPrevented;
        },
      } as MediaQueryList;
      const state: RuntimeMotionEmulation = {
        nativeMatchMedia,
        mediaQuery,
        restore: () => {
          window.matchMedia = nativeMatchMedia;
          listeners.clear();
          onchange = null;
          delete testWindow.__bibcodeDesktopUiReducedMotionEmulation;
        },
        set: (nextMatches: boolean) => {
          if (matches === nextMatches) return;
          matches = nextMatches;
          mediaQuery.dispatchEvent(
            new MediaQueryListEvent("change", {
              matches: nextMatches,
              media: query,
            }),
          );
        },
      };
      testWindow.__bibcodeDesktopUiReducedMotionEmulation = state;
      window.matchMedia = (media: string) =>
        media === query ? mediaQuery : nativeMatchMedia.call(window, media);
    },
    REDUCED_MOTION_QUERY,
    initialMatches,
  );
}

async function restoreRuntimeMotionEmulation(): Promise<void> {
  await browser.execute(() => {
    const testWindow = window as Window & {
      __bibcodeDesktopUiReducedMotionEmulation?: {
        readonly restore: () => void;
      };
    };
    testWindow.__bibcodeDesktopUiReducedMotionEmulation?.restore();
  });
}

async function remountActivityDockWithRuntimeMotionEmulation(threadId: string): Promise<void> {
  await installRuntimeMotionEmulation(false);
  await browser.execute(() => {
    window.location.hash = "#/settings/general";
  });
  await browser.$('[aria-label="Theme preference"]').waitForDisplayed();
  await expectMissing('[data-testid="activity-dock"]');
  await browser.execute((nextThreadId: string) => {
    window.location.hash = `#/primary/${encodeURIComponent(nextThreadId)}`;
  }, threadId);
  await browser.$('[data-testid="activity-dock"]').waitForDisplayed();
}

async function setRuntimeMotionPreference(matches: boolean): Promise<void> {
  await browser.execute((nextMatches: boolean) => {
    const state = (
      window as Window & {
        __bibcodeDesktopUiReducedMotionEmulation?: {
          readonly set: (matches: boolean) => void;
        };
      }
    ).__bibcodeDesktopUiReducedMotionEmulation;
    if (!state) throw new Error("The reduced-motion emulation is not installed.");
    state.set(nextMatches);
  }, matches);
}

async function readRuntimeMotionPresentation(): Promise<RuntimeMotionPresentation> {
  return browser.execute(() => {
    const activeTransitionProperties = (element: Element): ReadonlyArray<string> => {
      const computed = getComputedStyle(element);
      const properties = computed.transitionProperty.split(",").map((value) => value.trim());
      const durations = computed.transitionDuration.split(",").map((value) => {
        const duration = Number.parseFloat(value);
        return value.trim().endsWith("ms") ? duration / 1_000 : duration;
      });
      return properties.filter(
        (_, index) => (durations[index % Math.max(1, durations.length)] ?? 0) > 0,
      );
    };
    const card = document.querySelector<HTMLElement>('[data-testid="activity-dock"] > div');
    if (!card) throw new Error("Activity card is missing for runtime motion inspection.");
    return {
      activeTransitionProperties: activeTransitionProperties(card),
      countActiveTransitionProperties: [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="activity-dock"] [data-activity-count], [data-testid="activity-dock"] .tabular-nums',
        ),
      ].flatMap(activeTransitionProperties),
    };
  });
}

// The pill has no expand step to animate since #143: it and its counts stay still under either
// motion preference.
async function assertRuntimeMotionState(reduced: boolean): Promise<void> {
  await setRuntimeMotionPreference(reduced);
  let presentation: RuntimeMotionPresentation | null = null;
  await browser.waitUntil(
    async () => {
      presentation = await readRuntimeMotionPresentation();
      return (
        presentation.activeTransitionProperties.length === 0 &&
        presentation.countActiveTransitionProperties.length === 0
      );
    },
    {
      timeoutMsg: `Activity animated under the ${reduced ? "reduced" : "normal"} motion preference.`,
    },
  );
  expect(presentation).not.toBeNull();
  expect(presentation!.activeTransitionProperties).toEqual([]);
  expect(presentation!.countActiveTransitionProperties).toEqual([]);
}

async function assertRuntimeMotionContract(): Promise<void> {
  await setDesktopUiMotionMode("native");
  try {
    await assertRuntimeMotionState(false);
    await assertRuntimeMotionState(true);
    await assertRuntimeMotionState(false);
  } finally {
    await setDesktopUiMotionMode("disabled");
  }
}

const DOCK_BUTTON = `[data-chat-composer-overlay] button[aria-label="${desktopActivityAccessibleNames.dock}"]`;

async function scrollTimelineTo(position: "history" | "end"): Promise<TimelineScroll> {
  await browser.execute((where: "history" | "end") => {
    const scroller = document.querySelector<HTMLElement>(
      "[data-chat-surface]:has([data-activity-pane]) [class*='overflow-anchor']",
    );
    if (!scroller) throw new Error("The chat timeline scroller is missing.");
    const max = scroller.scrollHeight - scroller.clientHeight;
    // The timeline stops following its end only when the reader navigates
    // (wheel, touch, or a press), so reading history starts with a wheel turn.
    if (where === "history") {
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -max }));
    }
    scroller.scrollTop = where === "end" ? max : 0;
  }, position);
  await browser.pause(300);
  return readTimelineScroll();
}

async function toggleChatPanelAndSettle(): Promise<TimelineScroll> {
  await focusDesktopUiElement(DOCK_BUTTON);
  await sendFocusedKeyboardKey("Enter");
  await browser.pause(300);
  return readTimelineScroll();
}

/**
 * With the panel closed, a short window makes the fixture thread scroll, so
 * opening and closing it is checked both mid-history and at the end.
 */
async function assertReadingPositionAcrossToggles(): Promise<void> {
  // The fixture thread's rows are shorter than the timeline, which only
  // scrolls by the composer's height. LegendList keeps the end of a list that
  // short in view, so a long reply gives the thread history to read.
  await setDesktopUiWindowSize(960, 640);
  const editor = browser.$('[data-testid="composer-editor"]');
  await editor.click();
  await editor.addValue(mermaidFixturePrompts.long);
  await expect(editor).toHaveText(mermaidFixturePrompts.long);
  await browser.keys("Enter");
  await expect(editor).toHaveText("");
  await browser
    .$(
      '//p[normalize-space()="Following reply paragraph 60 keeps the reading position measurable."]',
    )
    .waitForExist({ timeoutMsg: "The fixture's long reply never reached the chat." });
  let lastScroll: TimelineScroll | null = null;
  await browser
    .waitUntil(async () => {
      lastScroll = await readTimelineScroll();
      return lastScroll.scrollHeight > lastScroll.clientHeight * 2;
    })
    .catch(() => {
      throw new Error(
        `The fixture thread does not scroll with the panel closed, so the reading-position checks would prove nothing: ${JSON.stringify(lastScroll)}`,
      );
    });

  // LegendList treats a list within a tenth of its viewport of the end as at
  // the end and keeps the end in view, as it does for a growing composer. A
  // reader of earlier history must be outside that band.
  const middle = await scrollTimelineTo("history");
  expect(middle.distanceFromEnd).toBeGreaterThan(middle.clientHeight * 0.1 + 2);
  const opened = await toggleChatPanelAndSettle();
  await expect(browser.$("[data-chat-composer-overlay] [data-activity-panel]")).toBeDisplayed();
  expectReadingPositionKept(middle, opened);
  const closed = await toggleChatPanelAndSettle();
  await expectMissing("[data-activity-panel]");
  expectReadingPositionKept(opened, closed);

  const end = await scrollTimelineTo("end");
  expect(end.distanceFromEnd).toBeLessThanOrEqual(2);
  const openedAtEnd = await toggleChatPanelAndSettle();
  expectReadingPositionKept(end, openedAtEnd);
  const closedAtEnd = await toggleChatPanelAndSettle();
  expectReadingPositionKept(openedAtEnd, closedAtEnd);
  await setDesktopUiWindowSize(1_200, 720);
}

/**
 * Starts with the chat's panel just opened from the keyboard. Covers the
 * inline placement, the disclosure, Escape, the reading position, the
 * untouched right panel, the compact window, and keyboard detail navigation.
 */
async function assertInlineChatPanel(): Promise<void> {
  await expect(browser.$("[data-chat-composer-overlay] [data-activity-panel]")).toBeDisplayed();
  await assertBoundedActivityGeometry(1_200, true);
  await expectDockExpanded(true);

  // Escape inside the panel collapses it and gives focus back to its button.
  const rightPanelBefore = (await readPersistedPanelState()).rightPanel;
  expect(
    await browser.execute(() => document.activeElement?.closest("[data-activity-panel]") !== null),
  ).toBe(true);
  await sendFocusedKeyboardKey("Escape");
  await expectMissing("[data-activity-panel]");
  expect(await describeDesktopUiFocus()).toEqual(
    expect.objectContaining({ ariaLabel: desktopActivityAccessibleNames.dock, tagName: "BUTTON" }),
  );
  await expectDockExpanded(false);

  await assertReadingPositionAcrossToggles();

  // The button is a disclosure: Enter opens on Subagents, Enter again closes.
  await focusDesktopUiElement(DOCK_BUTTON);
  await sendFocusedKeyboardKey("Enter");
  await expect(browser.$('section[aria-label="Subagents"]')).toBeDisplayed();
  await expectDockExpanded(true);
  await focusDesktopUiElement(DOCK_BUTTON);
  await sendFocusedKeyboardKey("Enter");
  await expectMissing("[data-activity-panel]");
  await focusDesktopUiElement(DOCK_BUTTON);
  await sendFocusedKeyboardKey("Enter");
  await expect(browser.$("[data-activity-panel]")).toBeDisplayed();
  expect((await readPersistedPanelState()).rightPanel).toBe(rightPanelBefore);

  // A compact window keeps the panel in the pane, above the composer.
  await setDesktopUiWindowSize(960, 720);
  await assertBoundedActivityGeometry(960, true);

  const actor = browser.$(`[data-activity-row$="${desktopActivityFixture.actor.id}"]`);
  await actor.waitForExist();
  await browser.waitUntil(async () => {
    const visibility = await activityRowVisibility(desktopActivityFixture.actor.id);
    return visibility.hasArea && visibility.intersectsViewport;
  });
  await expect(actor).toHaveText(expect.stringContaining(desktopActivityFixture.actor.name));
  await expect(actor).toHaveText(expect.stringContaining("Running"));

  await focusDesktopUiElement('[data-activity-panel] [role="tab"][aria-selected="true"]');
  const focusedActor = await tabTo(
    (element) => element.activityRow?.endsWith(desktopActivityFixture.actor.id) === true,
  );
  expect(focusedActor.activityRow).toEqual(
    expect.stringContaining(desktopActivityFixture.actor.id),
  );
  await sendFocusedKeyboardKey("Enter");
  await expect(browser.$("[data-activity-detail-heading]")).toBeDisplayed();
  const back = await tabTo((element) => element.ariaLabel === "Back to Subagents", "backward");
  expect(back.ariaLabel).toBe("Back to Subagents");
  await sendFocusedKeyboardKey("Enter");
  await expectMissing("[data-activity-detail-heading]");
  expect(
    (await sendFocusedKeyboardKey("ArrowDown")).before.activityRow?.endsWith(
      desktopActivityFixture.actor.id,
    ),
  ).toBe(true);

  await assertReloadRestoresDetailWithoutFocus();
  await assertRetiredRightPanelActivityHydratesClosed();

  await focusDesktopUiElement('[data-activity-panel] [role="tab"][aria-selected="true"]');
  await sendFocusedKeyboardKey("Escape");
  await expectMissing("[data-activity-panel]");
}

/** A reload restores the open panel and its record, while the composer keeps focus. */
async function assertReloadRestoresDetailWithoutFocus(): Promise<void> {
  await browser.$(`[data-activity-row$="${desktopActivityFixture.actor.id}"]`).click();
  await expect(browser.$("[data-activity-detail-heading]")).toBeDisplayed();
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  await browser.$('[data-testid="composer-editor"]').waitForDisplayed();
  await focusDesktopUiElement('[data-testid="composer-editor"]');
  await expect(browser.$("[data-chat-composer-overlay] [data-activity-panel]")).toBeDisplayed();
  await expect(browser.$("[data-activity-detail-heading]")).toBeDisplayed();
  await expectDockExpanded(true);
  expect(await describeDesktopUiFocus()).toEqual(
    expect.objectContaining({ testId: "composer-editor" }),
  );
  const back = browser.$('button[aria-label="Back to Subagents"]');
  await back.click();
  await expectMissing("[data-activity-detail-heading]");
}

/**
 * Right-panel state saved before Activity moved inline (version 10, showing
 * Activity) hydrates closed and never opens the right panel for Activity.
 */
async function assertRetiredRightPanelActivityHydratesClosed(): Promise<void> {
  const [threadKey] = (await readPersistedPanelState()).activityPaneThreadKeys;
  expect(threadKey).toBeTruthy();
  await browser.execute((key: string) => {
    window.localStorage.setItem(
      "bibcode:right-panel-state:v2",
      JSON.stringify({
        version: 10,
        state: {
          byThreadKey: {
            [key]: {
              isOpen: true,
              activeSurfaceId: "activity",
              surfaces: [
                {
                  id: "activity",
                  kind: "activity",
                  scope: { _tag: "thread" },
                  section: "subagents",
                  selectedRecordKind: null,
                  selectedRecordId: null,
                },
                { id: "diff", kind: "diff" },
              ],
            },
          },
        },
      }),
    );
  }, threadKey!);
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  await browser.$('[data-testid="composer-editor"]').waitForDisplayed();
  await expect(browser.$("[data-chat-composer-overlay] [data-activity-panel]")).toBeDisplayed();
  const hydrated = await browser.execute((key: string) => {
    const persisted = window.localStorage.getItem("bibcode:right-panel-state:v2");
    const decoded = persisted
      ? (JSON.parse(persisted) as {
          readonly version?: number;
          readonly state?: {
            readonly byThreadKey?: Record<
              string,
              { readonly isOpen?: boolean; readonly surfaces?: ReadonlyArray<{ kind: string }> }
            >;
          };
        })
      : null;
    const thread = decoded?.state?.byThreadKey?.[key];
    return {
      version: decoded?.version ?? null,
      isOpen: thread?.isOpen ?? null,
      kinds: thread?.surfaces?.map((surface) => surface.kind) ?? [],
      activityPanels: document.querySelectorAll("[data-activity-panel]").length,
    };
  }, threadKey!);
  expect(hydrated).toEqual({ version: 11, isOpen: false, kinds: ["diff"], activityPanels: 1 });
}

/**
 * The size the Codex fixture's terminal mode last redrew at. It draws
 * `fixture-tui <cols>x<rows>` on start and on every SIGWINCH, and records each
 * size under the project's `.git`, since a WebGL terminal has no text in the DOM.
 */
async function readTerminalTuiSize(): Promise<{
  readonly rows: number;
  readonly drawn: string | null;
}> {
  const log = NodePath.join(preparedProjectPath, ".git", "bibcode-fixture-tui-sizes.log");
  const drawn = NodeFS.existsSync(log)
    ? (NodeFS.readFileSync(log, "utf8").trim().split("\n").at(-1) ?? null)
    : null;
  return { rows: Number(drawn?.split("x")[1] ?? Number.NaN), drawn: drawn || null };
}

/** The terminal's own panel takes rows from the PTY, and the TUI redraws at each size. */
async function assertTerminalPanelResizesTui(terminalId: string): Promise<void> {
  const host = `[data-provider-terminal-activity-host="${terminalId}"]`;
  // The TUI first draws at its launch size, then again once the terminal fits
  // its pane, so the baseline is the size that stays put.
  let settled: { readonly rows: number; readonly drawn: string | null } | null = null;
  await browser.waitUntil(
    async () => {
      const before = await readTerminalTuiSize();
      await browser.pause(400);
      const after = await readTerminalTuiSize();
      settled = after;
      return after.drawn !== null && after.drawn === before.drawn;
    },
    { timeoutMsg: "The Codex fixture TUI never settled on a terminal size." },
  );
  const collapsed = settled!;
  await browser.$(`${host} [data-testid="activity-dock"] button`).click();
  await expect(browser.$(`${host} [data-activity-panel]`)).toBeDisplayed();
  expect(await browser.$("[data-chat-composer-overlay] [data-activity-panel]").isExisting()).toBe(
    false,
  );
  await browser.waitUntil(async () => (await readTerminalTuiSize()).rows < collapsed.rows, {
    timeoutMsg: "Opening the terminal's Activity panel did not resize the TUI.",
  });
  expect((await readTerminalTuiSize()).rows).toBeGreaterThanOrEqual(5);
  await browser.$(`${host} [data-testid="activity-dock"] button`).click();
  await expectMissing(`${host} [data-activity-panel]`);
  await browser
    .waitUntil(async () => (await readTerminalTuiSize()).rows === collapsed.rows)
    .catch(async () => {
      throw new Error(
        `Closing the terminal's Activity panel did not give the TUI its rows back: collapsed at ${collapsed.drawn}, now ${(await readTerminalTuiSize()).drawn}.`,
      );
    });
}

/**
 * A narrow side-by-side split of the chat and its Codex terminal: each pane's
 * open panel stays inside that pane, the composer stays usable, and the
 * terminal keeps rows. Restored from a reload, so it also proves per-pane state.
 */
async function assertNarrowSplitUsability(terminalId: string): Promise<void> {
  const host = `[data-provider-terminal-activity-host="${terminalId}"]`;
  // The terminal tab is hidden behind the chat here, so both panes' open state is
  // saved with the split layout and must come back from the reload on its own.
  await browser.execute((id: string) => {
    const key = "bibcode:center-panel-state:v1";
    const persisted = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
      state: {
        byThreadKey: Record<
          string,
          { surfaces: ReadonlyArray<{ id: string }>; groups: unknown; layout: unknown }
        >;
        activityPanes?: Record<string, Record<string, unknown>>;
      };
    };
    const open = {
      expanded: true,
      section: "subagents",
      selectedRecordKind: null,
      selectedRecordId: null,
    };
    for (const [threadKey, thread] of Object.entries(persisted.state.byThreadKey)) {
      if (!thread.surfaces.some((surface) => surface.id === `terminal:${id}`)) continue;
      persisted.state.activityPanes = {
        ...persisted.state.activityPanes,
        [threadKey]: {
          ...persisted.state.activityPanes?.[threadKey],
          "chat:host": open,
          [`terminal:${id}`]: open,
        },
      };
      Object.assign(thread, {
        groups: [
          { id: "center:root", surfaceIds: ["chat:host"], activeSurfaceId: "chat:host" },
          {
            id: "center-group:activity-split",
            surfaceIds: [`terminal:${id}`],
            activeSurfaceId: `terminal:${id}`,
          },
        ],
        layout: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", groupId: "center:root" },
          second: { type: "leaf", groupId: "center-group:activity-split" },
        },
        focusedGroupId: "center:root",
      });
    }
    window.localStorage.setItem(key, JSON.stringify(persisted));
  }, terminalId);
  await setDesktopUiWindowSize(960, 720);
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  await browser.$('[data-testid="composer-editor"]').waitForDisplayed();
  await expect(browser.$(`${host} [data-activity-panel]`)).toBeDisplayed();
  await expect(browser.$("[data-chat-composer-overlay] [data-activity-panel]")).toBeDisplayed();
  const geometry = await browser.execute((id: string) => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    const terminalHost = document.querySelector(
      `[data-provider-terminal-activity-host="${CSS.escape(id)}"]`,
    );
    return {
      chatPane: rect(
        document
          .querySelector("[data-chat-composer-overlay]")
          ?.closest("[data-center-surface-host]") ?? null,
      ),
      chatPanel: rect(document.querySelector("[data-chat-composer-overlay] [data-activity-panel]")),
      composer: rect(document.querySelector('[data-chat-composer-form="true"]')),
      terminalPane: rect(terminalHost?.closest("[data-center-surface-host]") ?? null),
      terminalPanel: rect(terminalHost?.querySelector("[data-activity-panel]") ?? null),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  }, terminalId);
  for (const [pane, panel] of [
    [geometry.chatPane, geometry.chatPanel],
    [geometry.terminalPane, geometry.terminalPanel],
  ] as const) {
    expect(pane).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!.left).toBeGreaterThanOrEqual(pane!.left - 1);
    expect(panel!.right).toBeLessThanOrEqual(pane!.right + 1);
    expect(panel!.bottom).toBeLessThanOrEqual(pane!.bottom + 1);
  }
  expect(geometry.chatPane!.right).toBeLessThanOrEqual(geometry.terminalPane!.left + 1);
  expect(
    isFullyContainedInViewport(geometry.composer!, geometry.viewportWidth, geometry.viewportHeight),
  ).toBe(true);
  expect(geometry.composer!.height).toBeGreaterThan(0);
  expect(rectanglesOverlap(geometry.composer!, geometry.chatPanel!)).toBe(false);
  await browser.waitUntil(async () => (await readTerminalTuiSize()).rows >= 5, {
    timeoutMsg: "The narrow terminal pane kept fewer than five rows with its panel open.",
  });
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "chat-activity-narrow-split.png"),
  );
}

describe("packaged responsive activity experience", () => {
  it("keeps activity responsive, keyboard-operable, and focus-stable in the packaged app", async () => {
    clearDesktopActivityMarker(preparedProjectPath);
    await setDesktopUiWindowSize(1_200, 720);
    const materialized = await openMaterializedFixtureChat();

    const liveRegions = await browser.$$(
      '[data-testid="activity-dock"] [role="status"][aria-live="polite"][aria-atomic="true"]',
    );
    expect(liveRegions).toHaveLength(1);
    await expect(liveRegions[0]!).toHaveText(
      "Activity update: 1 active subagent, 0 done subagents, 1 active background task, 0 done background tasks",
    );

    const light = await selectActualTheme("Light", materialized.threadId);
    expect(contrastRatio(light.dock.foreground, light.dock.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.panel.foreground, light.panel.background)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(light.dock.focusRing).not.toBe("rgba(0, 0, 0, 0)|none");
    expect(light.panel.focusRing).not.toBe("rgba(0, 0, 0, 0)|none");
    const dark = await selectActualTheme("Dark", materialized.threadId);
    expect(contrastRatio(dark.dock.foreground, dark.dock.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.panel.foreground, dark.panel.background)).toBeGreaterThanOrEqual(4.5);
    expect(dark.dock.focusRing).not.toBe("rgba(0, 0, 0, 0)|none");
    expect(dark.panel.focusRing).not.toBe("rgba(0, 0, 0, 0)|none");
    expect(dark.dock.background).not.toBe(light.dock.background);
    expect(dark.dock.foreground).not.toBe(light.dock.foreground);
    expect(dark.panel.background).not.toBe(light.panel.background);
    expect(dark.panel.foreground).not.toBe(light.panel.foreground);
    await remountActivityDockWithRuntimeMotionEmulation(materialized.threadId);
    await assertRuntimeMotionContract();

    for (const width of [960, 980, 981, 1_199, 1_200] as const) {
      await assertActivityPresentation(width);
    }

    const inlineKeyboard = await openSubagentsWithKeyboard();
    expect(inlineKeyboard.enterEvidence).toEqual({
      click: 1,
      keydown: 1,
      keyup: 1,
    });
    await assertInlineChatPanel();
    await setDesktopUiWindowSize(1_200, 720);
    const terminalId = await openCodexProviderTerminal();
    if (supportsCodexTerminalActivity) {
      await assertProviderTerminalGeometry(terminalId);
      await assertTerminalPanelResizesTui(terminalId);
    }
    const terminalInput =
      '[data-terminal-owner="center-panel"] .xterm-helper-textarea, [data-terminal-owner="right-panel"] .xterm-helper-textarea';
    expect(await focusDesktopUiElement(terminalInput)).toEqual(
      expect.objectContaining({ tagName: "TEXTAREA" }),
    );
    await startDesktopActivityFollowupTurn();
    const followupMessage = browser.$(
      '//*[normalize-space()="publish deterministic live activity update"]',
    );
    await followupMessage.waitForExist({
      timeoutMsg: "The deterministic follow-up turn did not reach the active chat.",
    });
    expect(await describeDesktopUiFocus()).toEqual(
      expect.objectContaining({ tagName: "TEXTAREA" }),
    );
    // The chat tabbed away behind its terminal mounts no Activity, so it
    // neither reads nor announces it until it is in front again.
    expect(await browser.$$(DOCK_BUTTON).length).toBe(0);
    if (supportsCodexTerminalActivity) {
      await assertProviderTerminalGeometry(terminalId);
    }
    const mainPanel = browser.$(
      '//*[@data-center-panel-tab-list]//button[.//span[normalize-space()="Codex"]]',
    );
    await mainPanel.click();
    const updatedSummary = browser.$(
      `[data-chat-composer-overlay] button[aria-label^="Activity: Subagents 1 active, 0 done; Background tasks 0 active, 1 done"]`,
    );
    await updatedSummary.waitForExist({
      timeoutMsg: "The provider follow-up did not materially update activity counts.",
    });
    const updatedAnnouncement =
      "Activity update: 1 active subagent, 0 done subagents, 0 active background tasks, 1 done background task";
    await browser.waitUntil(
      async () =>
        browser.execute((announcement: string) => {
          const liveRegions = document.querySelectorAll<HTMLElement>(
            '[data-testid="activity-dock"] [role="status"][aria-live="polite"]',
          );
          return [...liveRegions].some(
            (liveRegion) =>
              liveRegion.closest("[data-provider-terminal-activity-host]") === null &&
              liveRegion.textContent?.trim() === announcement,
          );
        }, updatedAnnouncement),
      { timeoutMsg: "The coalesced live announcement did not publish updated exact status." },
    );
    await browser.$('[data-testid="composer-editor"]').waitForDisplayed();
    expect(await focusDesktopUiElement('[data-testid="composer-editor"]')).toEqual(
      expect.objectContaining({ testId: "composer-editor" }),
    );
    await browser.execute(() => {
      const composer = document.activeElement;
      if (!(composer instanceof HTMLElement) || composer.dataset.testid !== "composer-editor") {
        throw new Error("The composer must own focus before the second activity update.");
      }
      const state = {
        composer,
        lost: false,
        onFocusIn: () => {
          if (document.activeElement !== composer) state.lost = true;
        },
      };
      (
        window as Window & {
          __bibcodeActivityComposerFocusGuard?: typeof state;
        }
      ).__bibcodeActivityComposerFocusGuard = state;
      document.addEventListener("focusin", state.onFocusIn, true);
    });
    await startDesktopActivityComposerFollowupTurn();
    const composerUpdateAnnouncement =
      "Activity update: 2 active subagents, 0 done subagents, 0 active background tasks, 1 done background task";
    await browser.waitUntil(
      async () =>
        browser.execute((announcement: string) => {
          const summary = document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Activity: Subagents 2 active, 0 done"]',
          );
          const liveRegion = document.querySelector<HTMLElement>(
            '[data-testid="activity-dock"] [role="status"][aria-live="polite"]',
          );
          return summary !== null && liveRegion?.textContent?.trim() === announcement;
        }, composerUpdateAnnouncement),
      {
        timeoutMsg:
          "The composer-focused activity revision did not update counts and announcement.",
      },
    );
    const composerFocus = await browser.execute(() => {
      const guardedWindow = window as Window & {
        __bibcodeActivityComposerFocusGuard?: {
          readonly composer: HTMLElement;
          lost: boolean;
          readonly onFocusIn: () => void;
        };
      };
      const state = guardedWindow.__bibcodeActivityComposerFocusGuard;
      if (!state) throw new Error("The composer focus guard was lost.");
      document.removeEventListener("focusin", state.onFocusIn, true);
      delete guardedWindow.__bibcodeActivityComposerFocusGuard;
      return {
        focused: document.activeElement === state.composer,
        lost: state.lost,
      };
    });
    expect(composerFocus).toEqual({ focused: true, lost: false });

    if (supportsCodexTerminalActivity) {
      await assertNarrowSplitUsability(terminalId);
    }

    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "chat-activity-responsive.png"),
    );
  });
});
