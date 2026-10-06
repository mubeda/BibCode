import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { ThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
import type { prepareBrowserFollowupPng } from "./release-visual-browser-followups-fixture.ts";
import type {
  BrowserFollowupUploadReceipt,
  BrowserFollowupHostedReceipt,
  BrowserFollowupTerminalReceipt,
} from "./release-visual-browser-followups-source.ts";
import { buildBrowserFollowupHostedEntry } from "./release-visual-browser-followups-fixture.ts";
import { browserFollowupHostedOrigin } from "./release-visual-browser-followups.ts";
import type { startBrowserFollowupTransport } from "./release-visual-browser-followups-network.ts";
const refused = () => new Error("Owned browser follow-up resource refused.");
/** Current public helper compiled into the separately owned immutable hosted application. */
export async function readBrowserFollowupHostedMode() {
  if (
    location.origin !== "http://127.0.0.1:4893" ||
    Reflect.get(window, "desktopBridge") !== undefined
  )
    return false;
  try {
    const publicModule = "/qualified-hosted-mode.js";
    const source = await import(publicModule);
    return typeof source.isHostedStaticApp === "function" && source.isHostedStaticApp() === true;
  } catch {
    return false;
  }
}
/** Credential absence only. The product owns its delayed URL/history operation and its DOM. */
export function readBrowserFollowupHostedScrub(token: string) {
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 16384 ||
    location.origin !== "http://127.0.0.1:4893" ||
    location.pathname !== "/pair"
  )
    return false;
  const encoded = encodeURIComponent(token),
    url = new URL(location.href);
  const query = url.searchParams,
    hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (
    query.has("token") ||
    query.has("code") ||
    hash.has("token") ||
    hash.has("code") ||
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
    )
  )
    return false;
  return (
    !(document.body.textContent ?? "").includes(token) &&
    !Array.from(document.querySelectorAll("*")).some((node) =>
      Array.from(node.attributes).some(
        (attribute) => attribute.value.includes(token) || attribute.value.includes(encoded),
      ),
    )
  );
}
/** Cleanup never overwrites a primary failure, and an unsafe cleanup never earns an assertion. */
export async function withBrowserFollowupResource<A>(input: {
  run: () => Promise<A>;
  cleanup: () => Promise<void>;
  observeUnsafeCleanup: () => void;
}): Promise<A> {
  let failed = false,
    original: unknown,
    result: A | undefined;
  try {
    result = await input.run();
  } catch (error) {
    failed = true;
    original = error;
  }
  let unsafe = false;
  try {
    await input.cleanup();
  } catch {
    unsafe = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Preserve original outcomes. */
    }
  }
  if (failed) throw original;
  if (unsafe) throw refused();
  return result as A;
}
/** Uses the maintained actual HTTP/TCP throttle owner. No network or product runtime is created by this adapter. */
export async function withBrowserFollowupSlowUpload<A>(
  input: {
    png: ReturnType<typeof prepareBrowserFollowupPng>;
    proxy: ThrottleProxy;
    readProtocolReceipt: () => BrowserFollowupUploadReceipt;
    verifyCancelled: () => Promise<void>;
    cancelOwnedStage: () => Promise<void>;
    observeUnsafeCleanup: () => void;
  },
  run: (scope: {
    path: string;
    verify: () => Promise<BrowserFollowupUploadReceipt>;
    verifyCancelled: () => Promise<void>;
  }) => Promise<A>,
) {
  const original = input.proxy.settings();
  if (original.up !== 0 || original.down !== 0 || original.frozen) throw refused();
  input.png.verify();
  input.proxy.update({ up: 4096, down: 0, frozen: false });
  return withBrowserFollowupResource({
    run: () =>
      run({
        path: input.png.path,
        verify: async () => {
          input.png.verify();
          const state = input.proxy.settings(),
            receipt = input.readProtocolReceipt();
          if (
            state.up !== 4096 ||
            state.down !== 0 ||
            state.frozen ||
            receipt.bytes !== input.png.bytes ||
            receipt.sha256 !== input.png.sha256
          )
            throw refused();
          return receipt;
        },
        verifyCancelled: input.verifyCancelled,
      }),
    cleanup: async () => {
      // Unblock the real cancellation request before waiting for its joined receipt.
      input.proxy.update(original);
      await input.cancelOwnedStage();
      const final = input.proxy.settings();
      if (
        final.up !== original.up ||
        final.down !== original.down ||
        final.frozen !== original.frozen
      )
        throw refused();
      input.png.verify();
    },
    observeUnsafeCleanup: input.observeUnsafeCleanup,
  });
}
/** An actual second owned WebDriver window. Existing handles are retained and never closed on another owner's behalf. */
export async function withBrowserFollowupWindow<A>(
  input: {
    browser: QualificationBrowser;
    entry: string;
    observeUnsafeCleanup: () => void;
  },
  run: (browser: QualificationBrowser) => Promise<A>,
) {
  const { browser } = input;
  const url = new URL(input.entry);
  if (
    url.username ||
    url.password ||
    !["http://127.0.0.1:4885", "http://127.0.0.1:4893"].includes(url.origin) ||
    (url.origin.endsWith(":4885")
      ? !/^\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(url.pathname) || !!url.search || !!url.hash
      : url.pathname === "/settings/general"
        ? !!url.search || !!url.hash
        : url.pathname !== "/pair" ||
          url.searchParams.get("host") !== "http://127.0.0.1:4887" ||
          url.searchParams.get("label") !== "Owned hosted backend" ||
          [...url.searchParams.keys()].some((key) => !["host", "label"].includes(key)))
  )
    throw refused();
  const handles = await browser.getWindowHandles(),
    original = await browser.getWindowHandle();
  if (!handles.includes(original) || handles.length !== 1) throw refused();
  let created: string | undefined;
  return withBrowserFollowupResource({
    run: async () => {
      const value = await browser.newWindow(input.entry, { type: "window" });
      if (!value?.handle || handles.includes(value.handle)) throw refused();
      created = value.handle;
      const current = await browser.getWindowHandles();
      if (
        current.length !== handles.length + 1 ||
        !handles.every((handle) => current.includes(handle)) ||
        !current.includes(created)
      )
        throw refused();
      await browser.switchToWindow(created);
      return run(browser);
    },
    cleanup: async () => {
      const current = await browser.getWindowHandles();
      const allocated = current.filter((handle) => !handles.includes(handle));
      if (!created && allocated.length === 1) created = allocated[0];
      if (created && current.includes(created)) {
        await browser.switchToWindow(created);
        await browser.closeWindow();
      }
      await browser.switchToWindow(original);
      const restored = await browser.getWindowHandles();
      if (
        restored.length !== handles.length ||
        !handles.every((handle) => restored.includes(handle)) ||
        (await browser.getWindowHandle()) !== original
      )
        throw refused();
    },
    observeUnsafeCleanup: input.observeUnsafeCleanup,
  });
}
/** Bootstrap comes from the separate current-source hosted build, never a local /pair route or renderer injection. */
export async function withBrowserFollowupHostedEntry<A>(
  input: {
    mode: "confirm" | "incomplete";
    theme: "light" | "dark";
    browser: QualificationBrowser;
    owner: Pick<QualificationOwner, "until">;
    token: string;
    verifyHostedBuild: () => Promise<{
      genuineHostedBuild: true;
      backendConfigAbsent: true;
      sameSourceMatched: true;
    }>;
    verifyOwnedUnsubmittedLink: () => Promise<void>;
    revokeOwnedUnsubmittedLink: () => Promise<void>;
    observeUnsafeCleanup: () => void;
  },
  run: (scope: {
    browser: QualificationBrowser;
    verify: () => Promise<BrowserFollowupHostedReceipt>;
  }) => Promise<A>,
) {
  return withBrowserFollowupResource({
    run: async () => {
      await input.verifyHostedBuild();
      await input.verifyOwnedUnsubmittedLink();
      return withBrowserFollowupWindow(
        {
          browser: input.browser,
          entry: browserFollowupHostedOrigin + "/settings/general",
          observeUnsafeCleanup: input.observeUnsafeCleanup,
        },
        async (browser) => {
          if (!["light", "dark"].includes(input.theme)) throw refused();
          const theme = browser.$('[aria-label="Theme preference"]');
          await theme.waitForDisplayed();
          await theme.waitForEnabled();
          if ((await browser.$$('[aria-label="Theme preference"]').length) !== 1) throw refused();
          await theme.click();
          const option = browser.$(
            `//*[@role="option" and normalize-space()="${input.theme === "dark" ? "Dark" : "Light"}"]`,
          );
          await option.waitForDisplayed();
          await option.waitForEnabled();
          await option.click();
          await input.owner.until(async () =>
            browser.execute(
              (dark: boolean) => document.documentElement.classList.contains("dark") === dark,
              input.theme === "dark",
            ),
          );
          await browser.url(buildBrowserFollowupHostedEntry(input.mode, input.token));
          await browser.$("h1").waitForDisplayed();
          const sourceFence = async () => {
            const build = await input.verifyHostedBuild();
            await input.verifyOwnedUnsubmittedLink();
            if (
              build.genuineHostedBuild !== true ||
              build.backendConfigAbsent !== true ||
              build.sameSourceMatched !== true
            )
              throw refused();
            return build;
          };
          const ready = async () => {
            await sourceFence();
            return (
              (await browser.execute(readBrowserFollowupHostedMode)) === true &&
              (await browser.execute(readBrowserFollowupHostedScrub, input.token)) === true
            );
          };
          // A visible heading can precede the product's passive scrub effect. Wait only on actual read-only observations.
          await input.owner.until(ready);
          const verify = async (): Promise<BrowserFollowupHostedReceipt> => {
            const build = await sourceFence();
            if (
              (await browser.execute(readBrowserFollowupHostedMode)) !== true ||
              (await browser.execute(readBrowserFollowupHostedScrub, input.token)) !== true
            )
              throw refused();
            return { ...build, validOwnedEntry: true, consentUnsubmitted: true };
          };
          return run({ browser, verify });
        },
      );
    },
    cleanup: input.revokeOwnedUnsubmittedLink,
    observeUnsafeCleanup: input.observeUnsafeCleanup,
  });
}
export async function withBrowserFollowupHeldReply<A>(
  input: {
    transport: Awaited<ReturnType<typeof startBrowserFollowupTransport>>;
    owner: Pick<QualificationOwner, "until">;
    observeUnsafeCleanup: () => void;
  },
  run: (scope: {
    arm: () => Promise<void>;
    verify: () => Promise<
      import("./release-visual-browser-followups-source.ts").BrowserFollowupSlowReceipt
    >;
    release: () => Promise<void>;
  }) => Promise<A>,
) {
  let armed = false,
    released = false;
  const release = async () => {
    input.transport.release();
    released = true;
  };
  return withBrowserFollowupResource({
    run: () =>
      run({
        arm: async () => {
          input.transport.arm();
          armed = true;
        },
        verify: async () => input.transport.verifyHeld(),
        release,
      }),
    cleanup: async () => {
      if (!armed || released) return;
      await input.owner.until(async () => {
        const value = input.transport.observation();
        if (value.closed || value.failed || value.heldReplies > 1) throw refused();
        return value.heldReplies === 1;
      });
      await release();
    },
    observeUnsafeCleanup: input.observeUnsafeCleanup,
  });
}
/** Both windows attach to one existing terminal. A smaller original window supplies the genuine foreign size. */
export async function withBrowserFollowupSecondWindow<A>(
  input: {
    browser: QualificationBrowser;
    owner: Pick<QualificationOwner, "until">;
    threadRoute: string;
    label: string;
    readTerminalReceipt: () => BrowserFollowupTerminalReceipt;
    verifyFit: () => void;
    verifyRestored: () => void;
    observeUnsafeCleanup: () => void;
  },
  run: (scope: {
    browser: QualificationBrowser;
    label: string;
    verify: () => Promise<BrowserFollowupTerminalReceipt>;
    verifyFit: () => Promise<void>;
  }) => Promise<A>,
) {
  if (
    !/^http:\/\/127\.0\.0\.1:4885\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(input.threadRoute) ||
    !/^[A-Za-z0-9 -]{1,64}$/.test(input.label)
  )
    throw refused();
  const original = await input.browser.getWindowSize();
  return withBrowserFollowupResource({
    run: async () => {
      await input.browser.setWindowSize(1280, 800);
      // Resizing the active original renderer updates the actual owner claim through its public lifecycle.
      return withBrowserFollowupWindow(
        {
          browser: input.browser,
          entry: input.threadRoute,
          observeUnsafeCleanup: input.observeUnsafeCleanup,
        },
        (browser) =>
          run({
            browser,
            label: input.label,
            verify: async () => input.readTerminalReceipt(),
            verifyFit: async () => {
              await input.owner.until(async () => {
                try {
                  input.verifyFit();
                  return true;
                } catch {
                  return false;
                }
              });
            },
          }),
      );
    },
    cleanup: async () => {
      await input.browser.setWindowSize(original.width, original.height);
      const fit = input.browser.$("button=Fit to this window");
      if (await fit.isDisplayed()) {
        await fit.waitForEnabled();
        await fit.click();
      }
      await input.owner.until(async () => {
        try {
          input.verifyRestored();
          return true;
        } catch {
          return false;
        }
      });
    },
    observeUnsafeCleanup: input.observeUnsafeCleanup,
  });
}
