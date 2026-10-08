import { expect, it } from "vite-plus/test";
import { browserFollowupRows } from "./release-visual-browser-followups.ts";
import {
  runBrowserFollowupScene,
  type BrowserFollowupProducerInput,
} from "./release-visual-browser-followups-producer.ts";
import { withBrowserFollowupResource } from "./release-visual-browser-followups-owner.ts";
function fixture(failCapture = false) {
  const actions: string[] = [],
    captures: string[] = [];
  let cleaned = 0,
    identity = 0;
  const original = new Error("Inert original capture failure");
  const browser = {
    $$: () => ({ length: 1 }),
    $: (selector: string) => ({
      elementId: "inert-element",
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      isDisplayed: async () => true,
      getText: async () => "Owned visual review draft",
      getAttribute: async () => "false",
      click: async () => {
        actions.push(selector);
      },
      addValue: async () => {},
    }),
    keys: async () => {},
    execute: async () => "workspace",
    elementSendKeys: async () => {
      actions.push("native-file-entry");
    },
  } as unknown as BrowserFollowupProducerInput["browser"];
  const scope = async <A>(run: () => Promise<A>) =>
    withBrowserFollowupResource({
      run,
      cleanup: async () => {
        cleaned++;
      },
      observeUnsafeCleanup: () => {},
    });
  const input: BrowserFollowupProducerInput = {
    browser,
    owner: {
      until: async (predicate) => {
        if (!(await predicate())) throw new Error("Inert source did not become ready");
      },
    },
    verifyOwnedIdentity: async () => {
      identity++;
    },
    viewport: async () => {},
    step: () => {},
    observeUnsafeCleanup: () => {},
    capture: async (scene, _, verify) => {
      await verify();
      if (failCapture) throw original;
      await verify();
      captures.push(scene);
    },
    upload: {
      withSlowTransport: (run) =>
        scope(() =>
          run({
            path: "/owned/upload-browser-followup.png",
            verify: async () => ({
              originalPngMatched: true,
              stagedBeginObserved: true,
              appendObserved: true,
              unfinished: true,
              actualSlowTransport: true,
              bytes: 512 * 1024,
              sha256: "a".repeat(64),
            }),
            verifyCancelled: async () => {
              actions.push("cancel-joined");
            },
          }),
        ),
    },
    terminal: {
      withSecondWindow: (run) =>
        scope(() =>
          run({
            browser,
            label: "Terminal 1",
            prepareOriginalSizeOwner: async () => {
              actions.push("original-size-owner");
            },
            verify: async () => ({
              sameTerminalMatched: true,
              twoAttachmentsObserved: true,
              distinctSizeClaims: true,
              originalOutputMatched: true,
              sizeOwnerMatched: true,
            }),
            verifyFit: async () => {
              actions.push("fit-joined");
            },
          }),
        ),
    },
    sourceControl: {
      verify: async () => ({
        ownedRepositoryMatched: true,
        originalPatchMatched: true,
        sourceHashMatched: true,
        untruncated: true,
      }),
    },
    slow: {
      withHeldReply: (run) =>
        scope(() =>
          run({
            arm: async () => {
              actions.push("actual-reply-arm");
            },
            verify: async () => ({
              requestObserved: true,
              originalReplyHeld: true,
              elapsedBeyondThreshold: true,
              method: "server.getTraceDiagnostics",
              thresholdMs: 15000,
            }),
            release: async () => {
              actions.push("original-reply-release");
            },
          }),
        ),
    },
    hosted: {
      withOwnedEntry: (_, run) =>
        scope(() =>
          run({
            browser,
            verify: async () => ({
              genuineHostedBuild: true,
              backendConfigAbsent: true,
              sameSourceMatched: true,
              validOwnedEntry: true,
              consentUnsubmitted: true,
            }),
          }),
        ),
    },
  };
  return { input, actions, captures, original, read: () => ({ cleaned, identity }) };
}
it.each(browserFollowupRows)(
  "binds %s only to its actual public entry and two source joins",
  async (row) => {
    const value = fixture();
    const receipt = await runBrowserFollowupScene(value.input, row);
    expect(receipt.completeGroup).toBe(false);
    expect(value.captures).toEqual(
      row === "source-control-panel" ? ["source-control-panel-overview", row] : [row],
    );
    expect(value.read().identity).toBeGreaterThanOrEqual(4);
    if (row.startsWith("hosted")) expect(value.actions).toEqual([]);
    if (row === "terminal-shared-size") {
      expect(value.actions).toContain("fit-joined");
      expect(value.actions.some((value) => value.includes("Add Terminal"))).toBe(false);
    }
    if (row === "source-control-panel")
      expect(value.actions.at(-1)).toBe('[aria-label="Restore panel size"]');
    if (row === "slow-requests")
      expect(value.actions.indexOf("actual-reply-arm")).toBeLessThan(
        value.actions.indexOf('[aria-label="Refresh trace diagnostics"]'),
      );
  },
);
it.each(browserFollowupRows)(
  "keeps an original %s capture failure and joins its owner cleanup",
  async (row) => {
    const value = fixture(true);
    await expect(runBrowserFollowupScene(value.input, row)).rejects.toBe(value.original);
    expect(value.captures).toEqual([]);
    if (row === "source-control-panel")
      expect(value.actions.at(-1)).toBe('[aria-label="Restore panel size"]');
    else expect(value.read().cleaned).toBe(1);
  },
);
it("refuses source-less or partially joined captures before issuing a success assertion", async () => {
  const value = fixture();
  value.input.capture = async (_, __, verify) => {
    await verify();
  };
  await expect(runBrowserFollowupScene(value.input, "hosted-pair-confirm")).rejects.toThrow();
  expect(value.read().cleaned).toBe(1);
});

it.each(
  browserFollowupRows.flatMap((row) =>
    (["identity", "viewport"] as const).map((boundary) => [row, boundary] as const),
  ),
)("records admitted row %s before a %s preparation failure", async (row, boundary) => {
  const value = fixture();
  const original = Object.freeze(new Error("Inert exact preparation failure."));
  const events: string[] = [];
  const phases: string[] = [];
  let admitted = 0;
  value.input.step = (phase) => {
    phases.push(phase);
    events.push("phase");
  };
  value.input.verifyOwnedIdentity = async () => {
    events.push("identity");
    if (boundary === "identity") throw original;
  };
  value.input.viewport = async () => {
    events.push("viewport");
    throw original;
  };
  value.input.upload.withSlowTransport = async () => {
    admitted++;
    throw new Error("Unexpected upload admission.");
  };
  value.input.terminal.withSecondWindow = async () => {
    admitted++;
    throw new Error("Unexpected second-window admission.");
  };
  value.input.slow.withHeldReply = async () => {
    admitted++;
    throw new Error("Unexpected held-reply admission.");
  };
  value.input.hosted.withOwnedEntry = async () => {
    admitted++;
    throw new Error("Unexpected hosted admission.");
  };
  await expect(runBrowserFollowupScene(value.input, row)).rejects.toBe(original);
  expect(phases).toEqual(["visual-browser-followups-" + row]);
  expect(events).toEqual(
    boundary === "identity" ? ["phase", "identity"] : ["phase", "identity", "viewport"],
  );
  expect(value.captures).toEqual([]);
  expect(value.actions).toEqual([]);
  expect(admitted).toBe(0);
  expect(value.read().cleaned).toBe(0);
});

const firstRowPhase = "visual-browser-followups-chat-staged-attachment";
it.each(browserFollowupRows)(
  "nominates only the existing chat and terminal viewport waits: %s",
  async (row) => {
    const value = fixture();
    const phases: string[] = [];
    value.input.step = (phase) => phases.push(phase);
    let nominated: unknown;
    value.input.viewport = async (_browser, _width, _height, step) => {
      nominated = step;
    };
    await runBrowserFollowupScene(value.input, row);
    expect(nominated).toEqual(
      row === "chat-staged-attachment" || row === "terminal-shared-size"
        ? { row, step: value.input.step }
        : undefined,
    );
    if (row !== "chat-staged-attachment")
      expect(phases.some((phase) => phase.startsWith(firstRowPhase))).toBe(false);
  },
);
it.each([new Error("Inert original receipt deadline."), undefined])(
  "retains receipt wait and the exact thrown value through unsafe cleanup",
  async (original) => {
    const value = fixture();
    const phases: string[] = [];
    let cleanup = 0,
      unsafe = 0;
    value.input.step = (phase) => phases.push(phase);
    value.input.owner.until = async (predicate) => {
      expect(await predicate()).toBe(true);
      throw original;
    };
    const upload = value.input.upload.withSlowTransport;
    value.input.upload.withSlowTransport = (run) =>
      withBrowserFollowupResource({
        run: () => upload(run),
        cleanup: async () => {
          cleanup++;
          throw new Error("Inert secondary cleanup failure.");
        },
        observeUnsafeCleanup: () => {
          unsafe++;
        },
      });
    let failed = false,
      caught: unknown;
    try {
      await runBrowserFollowupScene(value.input, "chat-staged-attachment");
    } catch (error) {
      failed = true;
      caught = error;
    }
    expect(failed).toBe(true);
    expect(caught).toBe(original);
    expect(phases.at(-1)).toBe(firstRowPhase + "-upload-receipt-wait");
    expect(value.captures).toEqual([]);
    expect(cleanup).toBe(1);
    expect(unsafe).toBe(1);
  },
);
it("clears the receipt wait only on success without changing original capture binding", async () => {
  const value = fixture();
  const phases: string[] = [];
  value.input.step = (phase) => phases.push(phase);
  const result = await runBrowserFollowupScene(value.input, "chat-staged-attachment");
  expect(phases).toEqual([
    firstRowPhase,
    firstRowPhase + "-upload-receipt-wait",
    firstRowPhase,
    firstRowPhase,
  ]);
  expect(value.captures).toEqual(["chat-staged-attachment"]);
  expect(result).toEqual({
    row: "chat-staged-attachment",
    baseOriginals: 1,
    supplements: 0,
    sourceIdentityRetained: true,
    completeGroup: false,
  });
});

it("prepares original size owner once after second tab selection and before its receipt wait", async () => {
  const value = fixture();
  const events: string[] = [];
  const open = value.input.terminal.withSecondWindow;
  value.input.terminal.withSecondWindow = (run) =>
    open((scope) =>
      run({
        ...scope,
        prepareOriginalSizeOwner: async () => {
          events.push("pointer");
          expect(value.actions.slice(-2)).toEqual([
            '//*[@data-right-panel-tab-list]//button[normalize-space()="Terminal 1"]',
            '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]',
          ]);
        },
      }),
    );
  value.input.owner.until = async (predicate) => {
    events.push("wait");
    expect(await predicate()).toBe(true);
  };
  await runBrowserFollowupScene(value.input, "terminal-shared-size");
  expect(events).toEqual(["pointer", "wait"]);
  expect(value.captures).toEqual(["terminal-shared-size"]);
});
it("keeps a failed setup pointer value before polling or capture", async () => {
  const value = fixture();
  const open = value.input.terminal.withSecondWindow;
  let waits = 0;
  value.input.terminal.withSecondWindow = (run) =>
    open((scope) =>
      run({
        ...scope,
        prepareOriginalSizeOwner: async () => {
          throw undefined;
        },
      }),
    );
  value.input.owner.until = async () => {
    waits++;
  };
  let failed = false,
    caught: unknown;
  try {
    await runBrowserFollowupScene(value.input, "terminal-shared-size");
  } catch (error) {
    failed = true;
    caught = error;
  }
  expect(failed).toBe(true);
  expect(caught).toBeUndefined();
  expect(waits).toBe(0);
  expect(value.captures).toEqual([]);
  expect(value.read().cleaned).toBe(1);
});

it.each([new Error("Inert terminal receipt deadline."), undefined])(
  "retains terminal receipt phase and its original value through cleanup",
  async (original) => {
    const value = fixture();
    const phases: string[] = [];
    value.input.step = (phase) => phases.push(phase);
    value.input.owner.until = async (predicate) => {
      expect(await predicate()).toBe(true);
      throw original;
    };
    let failed = false,
      caught: unknown;
    try {
      await runBrowserFollowupScene(value.input, "terminal-shared-size");
    } catch (error) {
      failed = true;
      caught = error;
    }
    expect(failed).toBe(true);
    expect(caught).toBe(original);
    expect(phases.at(-1)).toBe(
      "visual-browser-followups-terminal-shared-size-terminal-receipt-wait",
    );
    expect(value.captures).toEqual([]);
    expect(value.read().cleaned).toBe(1);
  },
);
it("clears terminal receipt phase on success before its unchanged capture", async () => {
  const value = fixture();
  const phases: string[] = [];
  value.input.step = (phase) => phases.push(phase);
  await runBrowserFollowupScene(value.input, "terminal-shared-size");
  expect(phases).toEqual([
    "visual-browser-followups-terminal-shared-size",
    "visual-browser-followups-terminal-shared-size-terminal-receipt-wait",
    "visual-browser-followups-terminal-shared-size",
    "visual-browser-followups-terminal-shared-size",
  ]);
  expect(value.captures).toEqual(["terminal-shared-size"]);
});

const terminalComposerSelector =
  '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
it("focuses the unique visible second composer once between tab selection and original ownership", async () => {
  const value = fixture();
  await runBrowserFollowupScene(value.input, "terminal-shared-size");
  expect(value.actions).toEqual([
    '//*[@data-right-panel-tab-list]//button[normalize-space()="Terminal 1"]',
    terminalComposerSelector,
    "original-size-owner",
    "button=Fit to this window",
    "fit-joined",
  ]);
  expect(value.captures).toEqual(["terminal-shared-size"]);
  expect(value.read().cleaned).toBe(1);
});
it.each([0, 2])(
  "refuses %s visible second composer editors before original ownership",
  async (count) => {
    const value = fixture();
    const controls = value.input.browser.$$;
    value.input.browser.$$ = ((selector: string) =>
      selector === terminalComposerSelector
        ? { length: count }
        : controls(selector)) as typeof controls;
    await expect(runBrowserFollowupScene(value.input, "terminal-shared-size")).rejects.toThrow();
    expect(value.actions).not.toContain(terminalComposerSelector);
    expect(value.actions).not.toContain("original-size-owner");
    expect(value.captures).toEqual([]);
    expect(value.read().cleaned).toBe(1);
  },
);
it.each(["display", "enabled", "click"] as const)(
  "preserves exact second composer %s failure through cleanup",
  async (boundary) => {
    for (const original of [new Error("Inert composer public control failure."), undefined]) {
      const value = fixture();
      const control = value.input.browser.$;
      value.input.browser.$ = ((selector: string) => {
        const element = control(selector);
        if (selector !== terminalComposerSelector) return element;
        return {
          ...element,
          waitForDisplayed: async () => {
            if (boundary === "display") throw original;
          },
          waitForEnabled: async () => {
            if (boundary === "enabled") throw original;
          },
          click: async () => {
            throw original;
          },
        };
      }) as typeof control;
      let failed = false,
        caught: unknown;
      try {
        await runBrowserFollowupScene(value.input, "terminal-shared-size");
      } catch (error) {
        failed = true;
        caught = error;
      }
      expect(failed).toBe(true);
      expect(caught).toBe(original);
      expect(value.actions).not.toContain("original-size-owner");
      expect(value.captures).toEqual([]);
      expect(value.read().cleaned).toBe(1);
    }
  },
);
