import {
  projectBrowserTerminalGuard,
  type BrowserTerminalGuardReason,
} from "./release-visual-browser-followups-source.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type {
  BrowserFollowupScene,
  BrowserFollowupRow,
} from "./release-visual-browser-followups.ts";
import { browserFollowupRows } from "./release-visual-browser-followups.ts";
import { withBrowserFollowupResource } from "./release-visual-browser-followups-owner.ts";
import type {
  BrowserFollowupSlowReceipt,
  BrowserFollowupUploadReceipt,
  BrowserFollowupTerminalReceipt,
  BrowserFollowupDiffReceipt,
  BrowserFollowupHostedReceipt,
} from "./release-visual-browser-followups-source.ts";

export interface BrowserFollowupProducerInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  /** The existing controller's descriptor, snapshot and physical managed Git identity join. */
  verifyOwnedIdentity: () => Promise<void>;
  viewport: (
    browser: QualificationBrowser,
    width: 1280,
    height: 960,
    wait?: {
      row: "chat-staged-attachment" | "terminal-shared-size";
      step: (phase: string) => void;
    },
  ) => Promise<void>;
  capture: (
    scene: BrowserFollowupScene,
    browser: QualificationBrowser,
    verifySource: () => Promise<void>,
  ) => Promise<void>;
  upload: {
    withSlowTransport: (
      run: (scope: {
        path: string;
        verify: () => Promise<BrowserFollowupUploadReceipt>;
        verifyCancelled: () => Promise<void>;
      }) => Promise<void>,
    ) => Promise<void>;
  };
  terminal: {
    /** A second WebDriver window in the same owned browser/profile. Opens the existing exact thread and terminal. */
    withSecondWindow: (
      run: (scope: {
        browser: QualificationBrowser;
        label: string;
        verify: () => Promise<BrowserFollowupTerminalReceipt>;
        prepareOriginalSizeOwner: () => Promise<void>;
        verifyFit: () => Promise<void>;
      }) => Promise<void>,
    ) => Promise<void>;
  };
  sourceControl: { verify: () => Promise<BrowserFollowupDiffReceipt> };
  slow: {
    withHeldReply: (
      run: (scope: {
        arm: () => Promise<void>;
        verify: () => Promise<BrowserFollowupSlowReceipt>;
        release: () => Promise<void>;
      }) => Promise<void>,
    ) => Promise<void>;
  };
  hosted: {
    withOwnedEntry: (
      mode: "confirm" | "incomplete",
      run: (scope: {
        browser: QualificationBrowser;
        verify: () => Promise<BrowserFollowupHostedReceipt>;
      }) => Promise<void>,
    ) => Promise<void>;
  };
  step: (phase: string) => void;
  observeUnsafeCleanup: () => void;
  observeTerminalReceiptFailure?: (error: unknown, reason: BrowserTerminalGuardReason) => void;
}
const refused = () => new Error("Owned browser follow-up public producer refused.");
/** Public route only; Settings replaces the thread sidebar, while keeping the selected environment rail. */
export function readBrowserFollowupSettingsRoute() {
  if (location.origin !== "http://127.0.0.1:4885" || location.search || location.hash)
    return "other";
  return location.pathname.startsWith("/settings")
    ? "settings"
    : /^\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(location.pathname)
      ? "workspace"
      : "other";
}
async function click(browser: QualificationBrowser, selector: string) {
  const control = browser.$(selector);
  await control.waitForDisplayed();
  if ((await browser.$$(selector).length) !== 1) throw refused();
  await control.waitForEnabled();
  await control.click();
}
/** Matches the maintained pierre-diffs public entry, including an existing tab and empty-state action. */
export async function openBrowserFollowupRightPanel(
  browser: QualificationBrowser,
  label: "Source Control" | "Diff",
) {
  const bar = browser.$("[data-right-panel-tabbar]");
  if (!(await bar.isDisplayed())) {
    await click(browser, 'button[aria-label^="Toggle right panel"]');
    await bar.waitForDisplayed();
  }
  const tab = `//*[@data-right-panel-tab-list]//button[normalize-space()="${label}"]`;
  if (await browser.$(tab).isDisplayed()) return click(browser, tab);
  const empty = `//button[.//span[normalize-space()="${label}"] and not(@aria-disabled="true")]`;
  if (await browser.$(empty).isDisplayed()) return click(browser, empty);
  await click(browser, 'button[aria-label="Add panel surface"]');
  await click(browser, `//*[@role="menuitem" and normalize-space()="${label}"]`);
}
function requireReceipt(receipt: object, keys: readonly string[]) {
  for (const key of keys) {
    const own = Object.getOwnPropertyDescriptor(receipt, key);
    if (!own?.enumerable || !Object.hasOwn(own, "value") || own.value !== true) throw refused();
  }
}
/** Exactly six existing rows. Every renderer mutation is an ordinary public WebDriver action. */
export async function runBrowserFollowupScene(
  input: BrowserFollowupProducerInput,
  row: BrowserFollowupRow,
) {
  if (!browserFollowupRows.includes(row)) throw refused();
  input.step("visual-browser-followups-" + row);
  await input.verifyOwnedIdentity();
  await input.viewport(
    input.browser,
    1280,
    960,
    row === "chat-staged-attachment" || row === "terminal-shared-size"
      ? { row, step: input.step }
      : undefined,
  );
  const capture = async (
    scene: BrowserFollowupScene,
    browser: QualificationBrowser,
    verify: () => Promise<void>,
  ) => {
    input.step("visual-browser-followups-" + scene);
    let joins = 0;
    await input.capture(scene, browser, async () => {
      await input.verifyOwnedIdentity();
      await verify();
      joins++;
    });
    if (joins !== 2) throw refused();
  };
  switch (row) {
    case "chat-staged-attachment":
      await input.upload.withSlowTransport(async (scope) => {
        const browser = input.browser;
        const fileSelector = '[data-center-surface-host][data-visible="true"] input[type="file"]';
        const file = browser.$(fileSelector);
        await file.waitForEnabled();
        if ((await browser.$$(fileSelector).length) !== 1 || !(await file.elementId))
          throw refused();
        await browser.elementSendKeys(await file.elementId, scope.path);
        const editor =
          '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
        await browser.$(editor).waitForDisplayed();
        if ((await browser.$(editor).getText()).trim() !== "Owned visual review draft")
          throw refused();
        await browser.$(editor).click();
        await browser.keys(["Control", "a"]);
        await browser.keys("Backspace");
        await browser.$(editor).addValue("upload-browser-followup");
        await browser.keys("Enter");
        await browser.$(editor).addValue("Owned visual review draft");
        const verify = async () => {
          const value = await scope.verify();
          requireReceipt(value, [
            "originalPngMatched",
            "stagedBeginObserved",
            "appendObserved",
            "unfinished",
            "actualSlowTransport",
          ]);
          if (value.bytes !== 512 * 1024 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw refused();
        };
        input.step("visual-browser-followups-chat-staged-attachment-upload-receipt-wait");
        await input.owner.until(async () => {
          try {
            await verify();
            return true;
          } catch {
            return false;
          }
        });
        input.step("visual-browser-followups-chat-staged-attachment");
        await capture(row, browser, verify);
        await click(
          browser,
          '//p[@role="status" and starts-with(normalize-space(),"Uploading 1 attachment")]/parent::*//button[normalize-space()="Cancel"]',
        );
        await scope.verifyCancelled();
      });
      break;
    case "terminal-shared-size":
      await input.terminal.withSecondWindow(async (scope) => {
        if (!/^[A-Za-z0-9 -]{1,64}$/.test(scope.label)) throw refused();
        await input.viewport(scope.browser, 1280, 960, {
          row: "terminal-shared-size",
          step: input.step,
        });
        // The second window selects an existing tab. It never invokes Add Terminal.
        await click(
          scope.browser,
          `//*[@data-right-panel-tab-list]//button[normalize-space()="${scope.label}"]`,
        );
        const editor =
          '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
        await click(scope.browser, editor);
        const verify = async () => {
          requireReceipt(await scope.verify(), [
            "sameTerminalMatched",
            "twoAttachmentsObserved",
            "distinctSizeClaims",
            "originalOutputMatched",
            "sizeOwnerMatched",
          ]);
        };
        await scope.prepareOriginalSizeOwner();
        input.step("visual-browser-followups-terminal-shared-size-terminal-receipt-wait");
        let lastRefusal: BrowserTerminalGuardReason = "private-unknown";
        try {
          await input.owner.until(async () => {
            try {
              await verify();
              lastRefusal = "private-unknown";
              return true;
            } catch (error) {
              lastRefusal = projectBrowserTerminalGuard(error);
              return false;
            }
          });
        } catch (error) {
          try {
            input.observeTerminalReceiptFailure?.(error, lastRefusal);
          } catch {
            /* Optional guard evidence cannot replace the original wait rejection. */
          }
          throw error;
        }
        input.step("visual-browser-followups-terminal-shared-size");
        await capture(row, scope.browser, verify);
        await click(scope.browser, "button=Fit to this window");
        await scope.verifyFit();
      });
      break;
    case "source-control-panel": {
      const verify = async () => {
        requireReceipt(await input.sourceControl.verify(), [
          "ownedRepositoryMatched",
          "originalPatchMatched",
          "sourceHashMatched",
          "untruncated",
        ]);
      };
      // Establish the actual preview through the existing public Diff entry before its source receipt is required.
      await openBrowserFollowupRightPanel(input.browser, "Diff");
      await click(input.browser, 'button[aria-label^="Diff scope:"]');
      await click(
        input.browser,
        '//*[@role="menuitem" and .//*[normalize-space()="Working tree"]]',
      );
      await input.owner.until(async () => {
        try {
          await verify();
          return true;
        } catch {
          return false;
        }
      });
      await openBrowserFollowupRightPanel(input.browser, "Source Control");
      await click(input.browser, '[aria-label="Maximize panel"]');
      await withBrowserFollowupResource({
        run: async () => {
          await click(
            input.browser,
            '//*[@data-preview-panel-mode]//button[normalize-space()="Commits"]',
          );
          await capture("source-control-panel-overview", input.browser, verify);
          await click(
            input.browser,
            '//*[@data-preview-panel-mode]//*[@aria-label="Stage pierre-step5.ts"]/parent::*//button[@title="pierre-step5.ts"]',
          );
          await input.browser.$('[aria-label="Split diff view"]').waitForDisplayed();
          await click(input.browser, 'button[aria-label^="Diff scope:"]');
          await click(
            input.browser,
            '//*[@role="menuitem" and .//*[normalize-space()="Working tree"]]',
          );
          if (
            (await input.browser
              .$('[aria-label="Split diff view"]')
              .getAttribute("aria-pressed")) !== "true"
          )
            await click(input.browser, '[aria-label="Split diff view"]');
          await capture(row, input.browser, verify);
        },
        cleanup: () => click(input.browser, '[aria-label="Restore panel size"]'),
        observeUnsafeCleanup: input.observeUnsafeCleanup,
      });
      break;
    }
    case "slow-requests":
      await withBrowserFollowupResource({
        run: () =>
          input.slow.withHeldReply(async (scope) => {
            await click(input.browser, '[data-testid="environment-rail-manage"]');
            await click(input.browser, "button=About");
            await click(input.browser, "a=View diagnostics");
            await scope.arm();
            await click(input.browser, '[aria-label="Refresh trace diagnostics"]');
            const verify = async () => {
              const value = await scope.verify();
              requireReceipt(value, [
                "requestObserved",
                "originalReplyHeld",
                "elapsedBeyondThreshold",
              ]);
              if (value.method !== "server.getTraceDiagnostics" || value.thresholdMs !== 15000)
                throw refused();
            };
            // The real owner waits through the unchanged product 15-second threshold.
            await input.owner.until(async () => {
              try {
                await verify();
                return true;
              } catch {
                return false;
              }
            });
            await click(
              input.browser,
              '//*[@data-status-bar]//button[normalize-space()="1 slow request"]',
            );
            await capture(row, input.browser, verify);
            await scope.release();
            await input.browser
              .$('//*[@data-status-bar]//button[normalize-space()="1 slow request"]')
              .waitForDisplayed({ reverse: true });
          }),
        cleanup: async () => {
          for (
            let count = 0;
            count < 4 &&
            (await input.browser.execute(readBrowserFollowupSettingsRoute)) === "settings";
            count++
          )
            await click(input.browser, "button=Back");
          if ((await input.browser.execute(readBrowserFollowupSettingsRoute)) !== "workspace")
            throw refused();
        },
        observeUnsafeCleanup: input.observeUnsafeCleanup,
      });
      break;
    case "hosted-pair-confirm":
    case "hosted-pair-incomplete":
      await input.hosted.withOwnedEntry(
        row === "hosted-pair-confirm" ? "confirm" : "incomplete",
        async (scope) => {
          await input.viewport(scope.browser, 1280, 960);
          const verify = async () => {
            requireReceipt(await scope.verify(), [
              "genuineHostedBuild",
              "backendConfigAbsent",
              "sameSourceMatched",
              "validOwnedEntry",
              "consentUnsubmitted",
            ]);
          };
          await verify();
          await capture(row, scope.browser, verify);
          // Explicit consent is an observed enabled public control. Never activate it for this row.
        },
      );
      break;
  }
  await input.verifyOwnedIdentity();
  return {
    row,
    baseOriginals: 1,
    supplements: row === "source-control-panel" ? 1 : 0,
    sourceIdentityRetained: true,
    completeGroup: false,
  } as const;
}
