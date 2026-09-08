import { correctDesktopUiOuterSize } from "./window-size.ts";

export async function mockDesktopUiFolderPicker(projectPath: string): Promise<void> {
  const picker = await browser.tauri.mock("desktop_bridge_pick_folder");
  await picker.mockReturnValue(projectPath);
}

export async function setDesktopUiWindowSize(width: number, height: number): Promise<void> {
  const devicePixelRatio = await browser.execute(() => window.devicePixelRatio);
  const requestedViewportSize = { width, height };
  const readViewport = () =>
    browser.execute(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readViewport();
    if (before.width === width && before.height === height) return;
    const outerBefore = await browser.getWindowSize();
    const requestedOuter = correctDesktopUiOuterSize(
      outerBefore,
      requestedViewportSize,
      before,
      scale,
    );
    await browser.setWindowSize(requestedOuter.width, requestedOuter.height);
    const outerAfter = await browser.getWindowSize();
    const expected = {
      width: Math.round(before.width + (outerAfter.width - outerBefore.width) / scale),
      height: Math.round(before.height + (outerAfter.height - outerBefore.height) / scale),
    };
    // Native resize completion can precede the webview resize. Observe that
    // transition before correcting again, without requiring paint callbacks.
    await browser.waitUntil(
      async () => {
        const observed = await readViewport();
        return observed.width === expected.width && observed.height === expected.height;
      },
      { timeoutMsg: "The webview did not reach the native window geometry after resize." },
    );
    // The host display can cap large requests; preserve that native constraint.
    if (outerAfter.width === outerBefore.width && outerAfter.height === outerBefore.height) return;
  }
}

export async function ensureMainSidebarOpen(): Promise<void> {
  await setDesktopUiWindowSize(1_000, 720);
  const wrapper = browser.$('[data-slot="sidebar-wrapper"]');
  await expect(wrapper).toBeDisplayed();

  if ((await wrapper.getAttribute("data-sidebar-state")) === "collapsed") {
    const toggle = browser.$('button[aria-label="Toggle main sidebar"]');
    await expect(toggle).toBeDisplayed();
    await toggle.click();
  }

  await expect(wrapper).toHaveAttribute("data-sidebar-state", "expanded");
}

export async function getMainSidebarVisibilityDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const trigger = document.querySelector<HTMLElement>(
      '[data-testid="sidebar-add-project-trigger"]',
    );
    const ancestry: Array<Record<string, unknown>> = [];
    let current: HTMLElement | null = trigger;
    while (current && ancestry.length < 8) {
      const style = window.getComputedStyle(current);
      const rect = current.getBoundingClientRect();
      ancestry.push({
        tag: current.tagName,
        dataSlot: current.dataset.slot ?? null,
        dataState: current.dataset.state ?? null,
        className: current.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        transform: style.transform,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      });
      current = current.parentElement;
    }
    return {
      innerWidth: window.innerWidth,
      outerWidth: window.outerWidth,
      devicePixelRatio: window.devicePixelRatio,
      desktopMediaQuery: window.matchMedia("(min-width: 48rem)").matches,
      ancestry,
    };
  });
}

export async function getAddProjectDialogVisibilityDiagnostics(): Promise<unknown> {
  return browser.execute(() => {
    const describe = (element: HTMLElement | null): Record<string, unknown> | null => {
      if (!element) return null;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        dataStartingStyle: element.hasAttribute("data-starting-style"),
        dataOpen: element.hasAttribute("data-open"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        position: style.position,
        transform: style.transform,
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
      };
    };
    const browse = [...document.querySelectorAll<HTMLElement>("[data-add-project-action]")].find(
      (element) => element.textContent?.includes("Browse folder"),
    );
    const popup = document.querySelector<HTMLElement>('[role="dialog"]');
    const motionRules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules]
          .map((rule) => rule.cssText)
          .filter(
            (rule) =>
              rule.includes("[data-open][data-starting-style]") || rule.includes("[data-closed]"),
          );
      } catch {
        return [];
      }
    });
    return {
      popup: describe(popup),
      viewport: describe(document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')),
      browse: describe(browse ?? null),
      popupMatchesOpenStarting: popup?.matches("[data-open][data-starting-style]") ?? false,
      motionStyleInstalled: document.documentElement.dataset.bibcodeDesktopUiMotion === "disabled",
      motionSheetActive: motionRules.length === 2,
      motionRules,
    };
  });
}
