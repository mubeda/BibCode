// @effect-diagnostics nodeBuiltinImport:off - Matrix selection tests compare actual fixed producer data.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import { parseChatMatrixCase, chatMatrixCases, matrixArtifactNames } from "./chat-upload-matrix.ts";
import { parseQualificationMode } from "./browser-startup-probe.ts";

it("keeps matrix selection explicit and bounded with a covering set of fourteen cases", () => {
  expect(parseQualificationMode(undefined)).toBe("upload-smoke");
  expect(parseQualificationMode("upload-matrix")).toBe("upload-matrix");
  expect(chatMatrixCases).toHaveLength(14);
  const delivery = chatMatrixCases.filter((case_) => case_.action === "delivery");
  expect(delivery.map((case_) => `${case_.transport}:${case_.upBytesPerSecond}`).sort()).toEqual([
    "noise:16384",
    "noise:65536",
    "plain:16384",
    "plain:65536",
  ]);
  for (const transport of ["plain", "noise"] as const) {
    const cases = chatMatrixCases.filter((case_) => case_.transport === transport);
    expect(
      cases
        .filter((case_) => case_.action === "delivery")
        .map((case_) => case_.theme)
        .sort(),
    ).toEqual(["dark", "light"]);
    expect(cases.filter((case_) => case_.action === "freeze")).toHaveLength(1);
    expect(
      cases
        .filter((case_) => case_.action.startsWith("cancel"))
        .map((case_) => case_.action)
        .sort(),
    ).toEqual(["cancel-enter", "cancel-pointer", "cancel-space"]);
    expect(cases.filter((case_) => case_.action === "stop")).toHaveLength(1);
  }
});

it("rejects missing/foreign case input and returns immutable fixed budgets and scene names", () => {
  for (const value of [
    undefined,
    "private-secret",
    "noise-1-light-delivery",
    "../controller",
    "plain-64-dark-delivery",
  ])
    expect(() => parseChatMatrixCase(value)).toThrow("The upload matrix case is invalid.");
  for (const case_ of chatMatrixCases) {
    expect(parseChatMatrixCase(case_.case)).toBe(case_);
    expect(Object.isFrozen(case_)).toBe(true);
    expect(case_.innerTimeoutSeconds).toBe(1800);
    expect(case_.outerTimeoutSeconds).toBe(1860);
  }
  expect(new Set(matrixArtifactNames).size).toBe(matrixArtifactNames.length);
  expect(matrixArtifactNames.every((name) => /^[a-z-]+\.png$/.test(name))).toBe(true);
});

it("consumes the same fixed manifest used by the Python budget producer", () => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(new URL("./chat-upload-matrix-cases.json", import.meta.url), "utf8"),
  );
  expect(manifest).toEqual(chatMatrixCases);
});

it("uses genuine pointer or Tab/key activation without imperative renderer clicks/focus", async () => {
  const { activateMatrixCancel } = await import("./chat-upload-matrix.ts");
  for (const action of ["cancel-pointer", "cancel-enter", "cancel-space"] as const) {
    const calls: string[] = [];
    let tabs = 0;
    const browser = {
      $: async () => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => {
          calls.push("pointer");
        },
      }),
      keys: async (key: string) => {
        calls.push(key);
        if (key === "Tab") tabs++;
      },
      execute: async (fn: Function) => {
        expect(fn.toString()).not.toMatch(/\.click\(|\.focus\(|dispatchEvent/);
        return tabs >= 3;
      },
    };
    await activateMatrixCancel(browser as never, action);
    expect(calls).toEqual(
      action === "cancel-pointer"
        ? ["pointer"]
        : ["Tab", "Tab", "Tab", action === "cancel-enter" ? "Enter" : " "],
    );
  }
});

it("requires advancing UI and exact provider evidence rather than treating send handoff as completion", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  const calls: string[] = [];
  let units = 0;
  let settled = false;
  const port = {
    phase: (name: string) => calls.push(name),
    stageAndSend: async () => calls.push("send"),
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {},
    readUi: async () => ({
      progressUnits: settled ? null : ++units,
      deliveredImage: settled,
      reconnecting: false,
      validPreview: false,
      restoredOutgoing: false,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
    }),
    receipt: async () => {
      settled = true;
      return { count: 1, matched: true };
    },
    capture: async (name: string) => calls.push(name),
    observe: async () => ({
      plain: { requests: { begin: 1 }, complete: true, append: { maximumOutstandingPerSocket: 2 } },
    }),
    measurements: () => ({ controls: { nativeWebSocket: "not-observed", rpc: "not-observed" } }),
    clock: async () => 1,
    freeze: () => {},
    until: async (check: () => Promise<boolean>) => {
      expect(await check()).toBe(true);
    },
  };
  const result = await runChatMatrixCase(
    parseChatMatrixCase("plain-64-light-delivery"),
    port as never,
  );
  expect(result.advancingUi).toBe(true);
  expect(result.providerMatched).toBe(true);
  expect(result.fullMatrixComplete).toBe(false);
  expect(calls).toContain("matrix-progress.png");
  expect(calls).toContain("matrix-result.png");
  settled = false;
  await expect(
    runChatMatrixCase(parseChatMatrixCase("plain-64-light-delivery"), {
      ...port,
      receipt: async () => ({ count: 1, matched: false }),
    } as never),
  ).rejects.toThrow("Matrix evidence assertion failed.");
});

it("the actual read-only DOM producer projects acknowledged display and restoration without text, URLs or IDs", async () => {
  const NodeVM = await import("node:vm");
  const { readChatMatrixDom } = await import("./chat-upload-matrix.ts");
  class Image {
    complete = true;
    naturalWidth = 1;
    naturalHeight = 1;
    src = "private-url";
  }
  const notice = {
    textContent: "Uploading 1 attachment — 0.2 of 10 MiB",
    parentElement: { querySelector: () => ({ textContent: "Cancel" }) },
  };
  const view = {
    querySelectorAll: (selector: string) =>
      selector === 'p[role="status"]'
        ? [notice]
        : selector === '[data-message-role="assistant"]'
          ? [{ textContent: "private-transcript drip1. drip2." }]
          : selector === '[data-message-role="user"] img'
            ? [new Image()]
            : [],
    querySelector: (selector: string) =>
      selector === '[data-testid="composer-editor"]'
        ? { textContent: "newer\n\nupload-matrix private-draft" }
        : selector === '[data-chat-composer-form="true"]'
          ? { querySelectorAll: () => [new Image()] }
          : null,
  };
  const read = NodeVM.runInNewContext(`(${readChatMatrixDom.toString()})`, {
    document: {
      querySelector: (selector: string) =>
        selector === '[data-center-surface-host][data-visible="true"]' ? view : null,
    },
    HTMLImageElement: Image,
  });
  const result = read({ outgoing: "upload-matrix", newer: "newer" });
  expect(result).toMatchObject({
    progressUnits: 2,
    restoredOutgoing: true,
    newerPreserved: true,
    validPreview: true,
    deliveredImage: true,
    dripCount: 2,
    error: false,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  notice.textContent = "Reconnecting…";
  expect(read({ outgoing: "upload-matrix", newer: "newer" })).toMatchObject({
    reconnecting: true,
    progressUnits: null,
  });
});

it("the actual controller's selected matrix branch cannot silently execute the old small smoke", async () => {
  const NodeVM = await import("node:vm");
  const NodeModule = await import("node:module");
  const NodePath = await import("node:path");
  const source = NodeFS.readFileSync(
    new URL("../qualify-chat-uploads.ts", import.meta.url),
    "utf8",
  );
  const marker = "    plain.route = await b.getUrl();";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("\n} catch (error)", start);
  const body = source.slice(start, end).replace(/\n  }\s*$/, "");
  const calls: string[] = [];
  const receipt = JSON.stringify({
    prompt: "upload-smoke",
    attachments: [{ bytes: 512 * 1024, sha256: "f" }],
  });
  const element = {
    waitForEnabled: async () => {},
    waitForDisplayed: async () => {},
    click: async () => {},
    addValue: async () => {},
    elementId: "owned",
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(`async function control() {${body}}\ncontrol`),
    {
      selectedMatrixCase: parseChatMatrixCase("plain-64-light-delivery"),
      runMatrix: async () => {
        calls.push("matrix");
      },
      environments: [],
      plain: { receipts: "/owned/receipt" },
      b: {
        $: () => element,
        keys: async () => {},
        execute: async () => ({ plain: { requests: { begin: 1 } } }),
        elementSendKeys: async () => {
          calls.push("smoke");
        },
        saveScreenshot: async () => {},
      },
      NodePath,
      NodeFS: { writeFileSync: () => {}, existsSync: () => true, readFileSync: () => receipt },
      NodeCrypto: { createHash: () => ({ update: () => ({ digest: () => "f" }) }) },
      fixtureRoot: "/owned",
      evidenceRoot: "/owned/evidence",
      createSizedPng: () => Buffer.alloc(512 * 1024),
      STAGED_SMOKE_IMAGE_BYTES: 512 * 1024,
      editorSelector: "owned-editor",
      phase: () => {},
      until: async () => {},
      projectChatUploadObservation: (value: unknown) => value,
      results: [],
      success: false,
    },
  );
  await run();
  expect(calls).toEqual(["matrix"]);
});

it("actual screenshot fence refuses Noise offer controls even after primary pairing", async () => {
  const NodeVM = await import("node:vm");
  const { qualificationScreenSafe } = await import("./chat-upload-matrix.ts");
  let sensitive = true;
  const safe = NodeVM.runInNewContext(`(${qualificationScreenSafe.toString()})`, {
    location: { origin: "http://localhost:4901", search: "", hash: "" },
    document: {
      documentElement: { classList: { contains: () => true } },
      querySelector: (selector: string) => {
        expect(selector).toContain('textarea[placeholder="bibcode://pair?code=…"]');
        return sensitive ? {} : null;
      },
    },
  });
  expect(safe({ origin: "http://localhost:4901", dark: true })).toBe(false);
  sensitive = false;
  expect(safe({ origin: "http://localhost:4901", dark: true })).toBe(true);
  expect(safe({ origin: "http://foreign", dark: null })).toBe(false);
});

it("keyboard Cancel fails closed if genuine Tab traversal never reaches the action", async () => {
  const { activateMatrixCancel } = await import("./chat-upload-matrix.ts");
  const calls: string[] = [];
  const browser = {
    $: async () => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      click: async () => {
        calls.push("pointer");
      },
    }),
    execute: async () => false,
    keys: async (value: string) => {
      calls.push(value);
    },
  };
  await expect(activateMatrixCancel(browser as never, "cancel-enter")).rejects.toThrow(
    "Matrix evidence assertion failed.",
  );
  expect(calls).toHaveLength(128);
  expect(calls.every((value) => value === "Tab")).toBe(true);
});

it("never passes a late 4408 as within the deadline and always thaws after failed evidence", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  let units = 0,
    frozen = false;
  const freezes: boolean[] = [];
  const port = {
    phase: () => {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {},
    readUi: async () => ({
      progressUnits: ++units,
      reconnecting: false,
      validPreview: false,
      restoredOutgoing: false,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: false,
    }),
    receipt: async () => ({ count: 0, matched: false }),
    capture: async () => {},
    clock: async () => 0,
    measurements: () => ({}),
    observe: async () => ({
      plain: {
        closeCalls: frozen ? 1 : 0,
        lastCloseCode: 4408,
        lastCloseAtMs: frozen ? 34000 : null,
      },
    }),
    freeze: (value: boolean) => {
      freezes.push(value);
      frozen = value;
    },
    until: async (check: () => Promise<boolean>) => {
      if (!(await check())) throw new Error("Matrix evidence assertion failed.");
    },
  };
  await expect(
    runChatMatrixCase(parseChatMatrixCase("plain-64-dark-freeze"), port as never),
  ).rejects.toThrow("Matrix evidence assertion failed.");
  expect(freezes).toEqual([true, false]);
});

it("cannot qualify Cancel when newer composer work was lost even though the old image returned", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  let units = 0,
    cancelled = false;
  const captures: string[] = [];
  const port = {
    phase: () => {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {
      cancelled = true;
    },
    readUi: async () => ({
      progressUnits: cancelled ? null : ++units,
      reconnecting: false,
      validPreview: cancelled,
      restoredOutgoing: cancelled,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: false,
    }),
    receipt: async () => ({ count: 0, matched: false }),
    capture: async (name: string) => {
      captures.push(name);
    },
    observe: async () => ({ plain: { requests: { cancel: 0 } } }),
    measurements: () => ({}),
    clock: async () => 0,
    freeze: () => {},
    until: async (check: () => Promise<boolean>) => {
      if (!(await check())) throw new Error("Matrix evidence assertion failed.");
    },
  };
  await expect(
    runChatMatrixCase(parseChatMatrixCase("noise-16-dark-cancel-pointer"), port as never),
  ).rejects.toThrow("Matrix evidence assertion failed.");
  expect(captures).not.toContain("matrix-cancel-restored.png");
});

it("CI case and artifact producers cover only the fixed fourteen selections without raw-log globs", async () => {
  const source = NodeFS.readFileSync(
    new URL("../../../../.github/workflows/qualify-chat-matrix.yml", import.meta.url),
    "utf8",
  );
  const selected = Array.from(source.matchAll(/^          - ([a-z0-9-]+)$/gm), (match) => match[1]);
  expect(selected).toEqual(chatMatrixCases.map((case_) => case_.case));
  expect(source).toContain("BIBCODE_UPLOAD_MODE: upload-matrix");
  expect(source).toContain("BIBCODE_UPLOAD_CASE: ${{ matrix.case }}");
  expect(source).toContain("branches: [codex/qualify-chat-matrix]");
  for (const artifact of matrixArtifactNames) expect(source).toContain("/" + artifact);
  expect(source).not.toMatch(/\/\*|\.log\s*$/m);
});

it("rejects incomplete Noise close evidence instead of qualifying a successful freeze", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  let units = 0,
    frozen = false,
    delivered = false;
  const freezes: boolean[] = [];
  const port = {
    phase: () => {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {},
    readUi: async () => ({
      progressUnits: delivered || frozen ? null : ++units,
      reconnecting: frozen,
      validPreview: false,
      restoredOutgoing: false,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: delivered,
    }),
    receipt: async () => {
      delivered = true;
      return { count: 1, matched: true };
    },
    capture: async () => {},
    observe: async () => ({
      noise: {
        closeCalls: frozen || delivered ? 1 : 0,
        lastCloseCode: 4408,
        lastCloseAtMs: 1000,
        closeMetricsComplete: false,
        applicationMetricsAvailable: false,
      },
    }),
    measurements: () => ({}),
    clock: async () => 0,
    freeze: (value: boolean) => {
      frozen = value;
      freezes.push(value);
    },
    until: async (check: () => Promise<boolean>) => {
      if (!(await check())) throw new Error("Matrix evidence assertion failed.");
    },
  };
  await expect(
    runChatMatrixCase(parseChatMatrixCase("noise-64-light-freeze"), port as never),
  ).rejects.toThrow("Matrix evidence assertion failed.");
  expect(freezes).toEqual([true, false]);
});

it.each(["second-cancel", "incomplete-final", "provider-arrived"] as const)(
  "Cancel final proof rejects changes introduced during capture: %s",
  async (fault) => {
    const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
    let units = 0,
      cancelled = false,
      captures = 0,
      reads = 0;
    const port = {
      phase: () => {},
      stageAndSend: async () => {},
      editNewer: async () => {},
      startStream: async () => {},
      stopGeneration: async () => {},
      activateCancel: async () => {
        cancelled = true;
      },
      readUi: async () => ({
        progressUnits: cancelled ? null : ++units,
        reconnecting: false,
        validPreview: cancelled,
        restoredOutgoing: cancelled,
        newerPreserved: cancelled,
        error: false,
        dripCount: 0,
        stopAvailable: false,
        deliveredImage: false,
      }),
      receipt: async () => ({
        count: fault === "provider-arrived" && captures >= 2 ? 1 : 0,
        matched: false,
      }),
      capture: async () => {
        captures++;
      },
      observe: async () => {
        reads++;
        return {
          plain: {
            requests: {
              cancel: reads === 1 ? 0 : fault === "second-cancel" && captures >= 2 ? 2 : 1,
            },
            complete: !(fault === "incomplete-final" && captures >= 2),
          },
        };
      },
      measurements: () => ({}),
      clock: async () => 0,
      freeze: () => {},
      until: async (check: () => Promise<boolean>) => {
        if (!(await check())) throw new Error("Matrix evidence assertion failed.");
      },
    };
    await expect(
      runChatMatrixCase(parseChatMatrixCase("plain-16-light-cancel-pointer"), port as never),
    ).rejects.toThrow("Matrix evidence assertion failed.");
  },
);

it.each(["dialog", "alertdialog"])(
  "the actual DOM producer detects product Base UI error toast markup outside the chat: %s",
  async (role) => {
    const NodeVM = await import("node:vm");
    const { Window } = await import("../../../../apps/web/node_modules/happy-dom/lib/index.js");
    const { readChatMatrixDom } = await import("./chat-upload-matrix.ts");
    const window = new Window();
    try {
      window.document.body.innerHTML = `<main data-center-surface-host data-visible="true"><div data-testid="composer-editor">upload-matrix upload-newer-draft</div></main><div role="${role}" data-type="error">private-error-notification</div>`;
      const read = NodeVM.runInNewContext(`(${readChatMatrixDom.toString()})`, {
        document: window.document,
        HTMLImageElement: window.HTMLImageElement,
      });
      const ui = read({ outgoing: "upload-matrix", newer: "upload-newer-draft" });
      expect(ui.error).toBe(true);
      expect(JSON.stringify(ui)).not.toContain("private-error");
      window.document.querySelector('[data-type="error"]')!.setAttribute("data-type", "success");
      expect(read({ outgoing: "upload-matrix", newer: "upload-newer-draft" }).error).toBe(false);
      window.document
        .querySelector("main")!
        .insertAdjacentHTML(
          "beforeend",
          '<div role="alert" class="text-destructive-foreground">private-banner</div>',
        );
      expect(read({ outgoing: "upload-matrix", newer: "upload-newer-draft" }).error).toBe(true);
    } finally {
      window.close();
    }
  },
);

it("complete Noise close proof still qualifies and remains an application close-call receipt", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  let units = 0,
    frozen = false,
    delivered = false;
  const result = await runChatMatrixCase(parseChatMatrixCase("noise-64-light-freeze"), {
    phase() {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {},
    readUi: async () => ({
      progressUnits: delivered || frozen ? null : ++units,
      reconnecting: frozen,
      validPreview: false,
      restoredOutgoing: false,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: delivered,
    }),
    receipt: async () => {
      delivered = true;
      return { count: 1, matched: true };
    },
    capture: async () => {},
    observe: async () => ({
      noise: {
        closeCalls: frozen || delivered ? 1 : 0,
        lastCloseCode: 4408,
        lastCloseAtMs: 1000,
        closeMetricsComplete: true,
        applicationMetricsAvailable: false,
      },
    }),
    measurements: () => ({}),
    clock: async () => 0,
    freeze(value: boolean) {
      frozen = value;
    },
    until: async (check: () => Promise<boolean>) => {
      expect(await check()).toBe(true);
    },
  } as never);
  expect(result.clientCloseCode).toBe(4408);
  expect(result.clientCloseElapsedMs).toBe(1000);
  expect(result.applicationMetricsAvailable).toBe(false);
});

it("final Cancel count is the validated delta from a nonzero baseline", async () => {
  const { runChatMatrixCase } = await import("./chat-upload-matrix.ts");
  let units = 0,
    cancelled = false,
    reads = 0;
  const result = await runChatMatrixCase(parseChatMatrixCase("plain-16-light-cancel-pointer"), {
    phase() {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {
      cancelled = true;
    },
    readUi: async () => ({
      progressUnits: cancelled ? null : ++units,
      reconnecting: false,
      validPreview: cancelled,
      restoredOutgoing: cancelled,
      newerPreserved: cancelled,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: false,
    }),
    receipt: async () => ({ count: 0, matched: false }),
    capture: async () => {},
    observe: async () => ({
      plain: { complete: true, requests: { cancel: ++reads === 1 ? 5 : 6 } },
    }),
    measurements: () => ({}),
    clock: async () => 0,
    freeze() {},
    until: async (check: () => Promise<boolean>) => {
      expect(await check()).toBe(true);
    },
  } as never);
  expect(result.cancelRpcCount).toBe(1);
  expect(result.transportObservations).toMatchObject({ requests: { cancel: 6 } });
});
