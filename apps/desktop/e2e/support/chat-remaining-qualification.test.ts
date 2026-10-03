// @effect-diagnostics nodeBuiltinImport:off - Qualification policy tests inspect their own private CI profile.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  runRemainingQualification,
  projectBrowserInlineObservation,
  projectOldInlineInput,
  observeInlineTransportProbe,
  projectBrowserInlineProgress,
  type RemainingQualificationPort,
} from "./chat-remaining-qualification.ts";
import type { BrowserInlineAction } from "./chat-inline-mechanics.ts";
import { createNativeFrameRecorder } from "./chat-inline-mechanics.ts";
import { createProxyMeasurements } from "../../../../scripts/throttle-proxy.ts";
function fixture(
  fault?:
    | "capable"
    | "upload-probe"
    | "staged-reference"
    | "ui-error"
    | "digest-mismatch"
    | "close-call-only",
) {
  let sent = false;
  const themes: string[] = [],
    actions: string[] = [];
  const port: RemainingQualificationPort = {
    capability: async () => (fault === "capable" ? true : false),
    inline: async () => ({
      version: 1,
      complete: true,
      plainSockets: 1,
      uploadRequests: sent && fault === "upload-probe" ? 1 : 0,
      turnRequests: sent ? 1 : 0,
      inlineAttachments: sent ? 1 : 0,
      inlineBytes: sent ? 10485760 : 0,
      stagedReferences: sent && fault === "staged-reference" ? 1 : 0,
    }),
    sendImage: async () => {
      sent = true;
    },
    receipt: async () => ({ count: sent ? 1 : 0, matched: sent && fault !== "digest-mismatch" }),
    ui: async () => ({
      deliveredImage: sent,
      error: fault === "ui-error",
      uploadNotice: false,
      composerUsable: true,
    }),
    captureTheme: async (theme) => {
      themes.push(theme);
    },
    until: async (check) => {
      if (!(await check())) throw new Error("Controlled fixture observation refused.");
    },
    transport: async (action: BrowserInlineAction) => {
      actions.push(action);
      return {
        browser: {
          action,
          failed: false,
          sentBytes: 3145728,
          bufferedAfterSend: 3145728,
          bufferedBeforeClose: action === "queued-before-close" ? 3145728 : null,
          closeCalled: action === "queued-before-close",
          receivedCloseCode: 1000,
          receivedCleanClose: true,
          samples: [],
        },
        native: {
          complete: true,
          messageBytes: 3145728,
          messageFinished: true,
          messageDigest: "a".repeat(64),
          nativePingWritesMidMessage: action === "mid-message-pong" ? 1 : 0,
          nativePongMidMessage: 0,
          nativePongAfterMessage: action === "mid-message-pong" ? 1 : 0,
          closeFrameReceived: fault !== "close-call-only",
          closeAfterMessage: fault !== "close-call-only",
          partialFrame: false,
        },
      };
    },
  };
  return { port, themes, actions, sent: () => sent };
}
describe("remaining qualification proof gates", () => {
  it("contains throwing diagnostics while preserving successful probe action and join order", async () => {
    const measurement = await fixture().port.transport("mid-message-pong");
    const actions: string[] = [];
    const result = await observeInlineTransportProbe({
      action: "mid-message-pong",
      start: async () => {
        actions.push("start");
      },
      readBrowser: async () => {
        actions.push("browser");
        return { result: measurement.browser, progress: null };
      },
      readNative: () => ({
        ...measurement.native,
        upgraded: true,
        upgradeCount: 1,
        timedOut: false,
        closeWritten: true,
        expectedBytes: 3145728,
        expectedDigest: "a".repeat(64),
      }),
      readProxy: createProxyMeasurements().snapshot,
      until: async (check, bound) => {
        actions.push("wait-" + bound);
        expect(await check()).toBe(true);
      },
      closeProxy: async () => {
        actions.push("proxy-close");
      },
      closeReceiver: async () => {
        actions.push("receiver-close");
      },
      capture: () => {
        throw new Error("Controlled diagnostic callback failure.");
      },
    });
    expect(result).toMatchObject({ browser: measurement.browser, ownedCleanupJoined: true });
    expect(actions).toEqual([
      "start",
      "wait-250000",
      "browser",
      "wait-5000",
      "proxy-close",
      "receiver-close",
    ]);
  });
  it("preserves exact original timeout identity when the failed-witness callback throws", async () => {
    const measurement = await fixture().port.transport("mid-message-pong");
    const original = new Error("Controlled original timeout.");
    const actions: string[] = [];
    await expect(
      observeInlineTransportProbe({
        action: "mid-message-pong",
        start: async () => {
          actions.push("start");
        },
        readBrowser: async () => {
          actions.push("browser");
          return { result: null, progress: null };
        },
        readNative: () => ({
          ...measurement.native,
          upgraded: true,
          upgradeCount: 1,
          timedOut: false,
          closeWritten: false,
          expectedBytes: 3145728,
          expectedDigest: "a".repeat(64),
        }),
        readProxy: createProxyMeasurements().snapshot,
        until: async (check, bound) => {
          actions.push("wait-" + bound);
          expect(await check()).toBe(false);
          throw original;
        },
        closeProxy: async () => {
          actions.push("proxy-close");
        },
        closeReceiver: async () => {
          actions.push("receiver-close");
        },
        capture: (value) => {
          if (value.outcome === "failed")
            throw new Error("Controlled failed-witness callback failure.");
        },
      }),
    ).rejects.toBe(original);
    expect(actions).toEqual(["start", "wait-250000", "browser"]);
  });
  it("retains partial native frame and proxy progress when browser-result waiting fails", async () => {
    const expectedDigest = NodeCrypto.createHash("sha256")
      .update(Buffer.alloc(3145728, 65))
      .digest("hex");
    const recorder = createNativeFrameRecorder(3145728, expectedDigest);
    const wire = Buffer.alloc(14 + 32768, 65);
    wire.set([0x81, 0xff, 0, 0, 0, 0, 0, 0x30, 0, 0, 0, 0, 0, 0]);
    recorder.push(wire);
    recorder.recordPingWrite();
    const proxy = createProxyMeasurements();
    proxy.connected();
    proxy.observe("up", { _tag: "received", bytes: wire.length });
    proxy.observe("up", { _tag: "accepted", bytes: wire.length });
    const captures: unknown[] = [];
    const original = new Error("Controlled observation timeout.");
    await expect(
      observeInlineTransportProbe({
        action: "mid-message-pong",
        start: async () => {},
        readBrowser: async () => ({
          result: null,
          progress: {
            action: "mid-message-pong",
            finished: false,
            failed: false,
            timedOut: false,
            readyState: "open",
            sentBytes: 3145728,
            bufferedBytes: 3145728,
            closeCalled: false,
            receivedCloseCode: null,
            receivedCleanClose: false,
            sampleCount: 1,
          },
        }),
        readNative: () => ({
          ...recorder.read(),
          upgraded: true,
          upgradeCount: 1,
          timedOut: false,
          closeWritten: false,
          expectedBytes: 3145728,
          expectedDigest,
          privatePayload: "private-payload",
        }),
        readProxy: proxy.snapshot,
        until: async (check: () => Promise<boolean>) => {
          expect(await check()).toBe(false);
          throw original;
        },
        closeProxy: async () => {
          throw new Error("Not reached.");
        },
        closeReceiver: async () => {
          throw new Error("Not reached.");
        },
        capture: (value: unknown) => captures.push(value),
      }),
    ).rejects.toBe(original);
    expect(captures.at(-1)).toMatchObject({
      action: "mid-message-pong",
      stage: "browser-result",
      outcome: "failed",
      browserResultReceived: false,
      ownedCleanupJoined: false,
      browser: { readyState: "open", finished: false, timedOut: false, bufferedBytes: 3145728 },
      native: {
        messageBytes: 32768,
        partialFrame: true,
        messageFinished: false,
        nativePingWritesMidMessage: 1,
        nativePongMidMessage: 0,
        nativePongAfterMessage: 0,
        closeFrameReceived: false,
        digest: "not-complete",
      },
      proxy: { connections: { created: 1, active: 1 }, up: { destinationAcceptedBytes: 32782 } },
    });
    expect(JSON.stringify(captures)).not.toMatch(
      /private-payload|Controlled observation timeout|expectedDigest|messageDigest/,
    );
  });
  it("distinguishes receiver-close waiting and preserves both original probe bounds on success", async () => {
    const measurement = await fixture().port.transport("mid-message-pong");
    const captures: unknown[] = [],
      bounds: number[] = [],
      joins: string[] = [];
    let receivedClose = false;
    const port = {
      action: "mid-message-pong" as const,
      start: async () => {},
      readBrowser: async () => ({ result: measurement.browser, progress: null }),
      readNative: () => ({
        ...measurement.native,
        closeFrameReceived: receivedClose,
        upgraded: true,
        upgradeCount: 1,
        timedOut: false,
        closeWritten: true,
        expectedBytes: 3145728,
        expectedDigest: "a".repeat(64),
      }),
      readProxy: createProxyMeasurements().snapshot,
      until: async (check: () => Promise<boolean>, bound?: number) => {
        bounds.push(bound!);
        if (!(await check())) throw new Error("Controlled observation timeout.");
      },
      closeProxy: async () => {
        joins.push("proxy");
      },
      closeReceiver: async () => {
        joins.push("receiver");
      },
      capture: (value: unknown) => captures.push(value),
    };
    await expect(observeInlineTransportProbe(port)).rejects.toThrow(
      "Controlled observation timeout.",
    );
    expect(captures.at(-1)).toMatchObject({
      stage: "receiver-close",
      outcome: "failed",
      browserResultReceived: true,
    });
    expect(joins).toEqual([]);
    receivedClose = true;
    await expect(observeInlineTransportProbe(port)).resolves.toMatchObject({
      browser: measurement.browser,
      ownedCleanupJoined: true,
    });
    expect(bounds).toEqual([250000, 5000, 250000, 5000]);
    expect(joins).toEqual(["proxy", "receiver"]);
    expect(captures.at(-1)).toMatchObject({
      stage: "complete",
      outcome: "complete",
      ownedCleanupJoined: true,
    });
    // Diagnostic rejection cannot turn otherwise accepted transport evidence into a failure.
    await expect(
      observeInlineTransportProbe({
        ...port,
        readBrowser: async () => ({
          result: measurement.browser,
          progress: { privateUrl: "private-url" },
        }),
      }),
    ).resolves.toMatchObject({ browser: measurement.browser, ownedCleanupJoined: true });
    expect(captures.at(-1)).toMatchObject({ browser: null, browserProgressState: "refused" });
    expect(JSON.stringify(captures)).not.toContain("private-url");
  });
  it("refuses unknown or unbounded live browser metrics before retaining them", () => {
    const progress = {
      action: "mid-message-pong",
      finished: false,
      failed: false,
      timedOut: false,
      readyState: "open",
      sentBytes: 3145728,
      bufferedBytes: 3145728,
      closeCalled: false,
      receivedCloseCode: null,
      receivedCleanClose: false,
      sampleCount: 1,
    };
    expect(projectBrowserInlineProgress(progress)).toEqual(progress);
    expect(projectBrowserInlineProgress({ ...progress, privateUrl: "private" })).toBeNull();
    expect(projectBrowserInlineProgress({ ...progress, readyState: "private" })).toBeNull();
    expect(projectBrowserInlineProgress({ ...progress, sampleCount: 257 })).toBeNull();
    expect(projectBrowserInlineProgress({ ...progress, bufferedBytes: Infinity })).toBeNull();
  });
  it.each([
    "getter",
    "revoked-proxy",
    "throwing-proxy",
    "foreign-proxy",
    "inherited",
    "symbol",
    "non-enumerable",
    "malformed",
  ] as const)(
    "quarantines %s progress without reading property values or changing valid terminal acceptance",
    async (fault) => {
      const privateCanary = "controlled-private-metric";
      let propertyReads = 0;
      const progress = {
        action: "mid-message-pong",
        finished: false,
        failed: false,
        timedOut: false,
        readyState: "open",
        sentBytes: 3145728,
        bufferedBytes: 3145728,
        closeCalled: false,
        receivedCloseCode: null,
        receivedCleanClose: false,
        sampleCount: 1,
      };
      let input: unknown = progress;
      if (fault === "getter")
        Object.defineProperty(progress, "readyState", {
          enumerable: true,
          get: () => {
            propertyReads++;
            return "open";
          },
        });
      if (fault === "revoked-proxy") {
        const pair = Proxy.revocable(progress, {
          get: () => {
            propertyReads++;
            return privateCanary;
          },
        });
        pair.revoke();
        input = pair.proxy;
      }
      if (fault === "throwing-proxy")
        input = new Proxy(progress, {
          get: () => {
            propertyReads++;
            return privateCanary;
          },
          getOwnPropertyDescriptor: () => {
            throw new Error(privateCanary);
          },
        });
      if (fault === "foreign-proxy")
        input = new Proxy(
          { ...progress, privateMetric: privateCanary },
          {
            get: () => {
              propertyReads++;
              return privateCanary;
            },
            getOwnPropertyDescriptor: (target, key) => {
              propertyReads++;
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        );
      if (fault === "inherited") {
        Object.defineProperty(progress, "action", {
          enumerable: true,
          get: () => {
            propertyReads++;
            return "mid-message-pong";
          },
        });
        const inherited = Object.create(progress) as Record<string, unknown>;
        for (let index = 0; index < 11; index++) inherited["private" + index] = privateCanary;
        input = inherited;
      }
      if (fault === "symbol")
        Object.defineProperty(progress, Symbol("private"), {
          enumerable: true,
          get: () => {
            propertyReads++;
            return privateCanary;
          },
        });
      if (fault === "non-enumerable")
        Object.defineProperty(progress, "action", { enumerable: false });
      if (fault === "malformed") progress.sampleCount = privateCanary as unknown as number;
      let projected: unknown;
      expect(() => {
        projected = projectBrowserInlineProgress(input);
      }).not.toThrow();
      expect(projected).toBeNull();
      expect(propertyReads).toBe(0);

      const measurement = await fixture().port.transport("mid-message-pong");
      const captures: unknown[] = [],
        joins: string[] = [];
      await expect(
        observeInlineTransportProbe({
          action: "mid-message-pong",
          start: async () => {},
          readBrowser: async () => ({ result: measurement.browser, progress: input }),
          readNative: () => ({
            ...measurement.native,
            upgraded: true,
            upgradeCount: 1,
            timedOut: false,
            closeWritten: true,
            expectedBytes: 3145728,
            expectedDigest: "a".repeat(64),
          }),
          readProxy: createProxyMeasurements().snapshot,
          until: async (check) => {
            expect(await check()).toBe(true);
          },
          closeProxy: async () => {
            joins.push("proxy");
          },
          closeReceiver: async () => {
            joins.push("receiver");
          },
          capture: (value) => captures.push(value),
        }),
      ).resolves.toMatchObject({ browser: measurement.browser, ownedCleanupJoined: true });
      expect(joins).toEqual(["proxy", "receiver"]);
      expect(captures.at(-1)).toMatchObject({
        browser: null,
        browserProgressState: "refused",
        outcome: "complete",
      });
      expect(propertyReads).toBe(0);
      expect(JSON.stringify(captures)).not.toContain(privateCanary);
    },
  );
  it("selects only the explicit remaining profile with immutable old checkout and exact safe artifacts", () => {
    const yaml = NodeModule.createRequire(
      new URL("../../../../scripts/package.json", import.meta.url),
    )("yaml");
    const profile = yaml.parse(
      NodeFS.readFileSync(
        new URL("../../../../.github/workflows/qualify-chat-remaining.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(profile.on.push.branches).toEqual(["codex/qualify-chat-remaining"]);
    expect(profile.permissions).toEqual({ contents: "read" });
    expect(profile.jobs.remaining.strategy).toBeUndefined();
    const steps = profile.jobs.remaining.steps;
    const old = steps.find((step: { with?: { ref?: string } }) => step.with?.ref);
    expect(old.with.ref).toBe("cd66fda5700294a320fe76256c486bd7a7a0b3a5");
    expect(old.with["persist-credentials"]).toBe(false);
    const run = steps.find(
      (step: { env?: { BIBCODE_UPLOAD_MODE?: string } }) => step.env?.BIBCODE_UPLOAD_MODE,
    );
    expect(run.env.BIBCODE_UPLOAD_MODE).toBe("remaining-qualification");
    expect(run.env.BIBCODE_UPLOAD_CASE).toBeUndefined();
    expect(run.env.BIBCODE_UPLOAD_OLD_SERVER).toBe(
      "${{ runner.temp }}/issue17-old-inline-input/bibcode",
    );
    const artifacts = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(artifacts.with.path).not.toMatch(/\.log|\*|matrix-/);
    expect(artifacts.with.path).toContain("inline-fallback-light.png");
    expect(artifacts.with.path).toContain("inline-fallback-dark.png");
  });
  it("does not accept a source receipt as native evidence or retain arbitrary fields", () => {
    const input = {
      source: "cd66fda5700294a320fe76256c486bd7a7a0b3a5",
      serverVersion: "0.7.2",
      binarySha256: "a".repeat(64),
      build: "immutable-source",
      hermeticGuard: "unavailable-in-old-source",
      contractProof: {
        serveFlags: true,
        pairingIssue: true,
        inlineDataUrl: true,
        capabilityAbsent: true,
        operateScope: true,
      },
    };
    expect(projectOldInlineInput(input)).toEqual(input);
    expect(projectOldInlineInput({ ...input, source: "b".repeat(40) })).toBeNull();
    expect(projectOldInlineInput({ ...input, hermeticGuard: "default Abort" })).toBeNull();
    expect(projectOldInlineInput({ ...input, privatePath: "private" })).toBeNull();
    expect(
      projectOldInlineInput({
        ...input,
        contractProof: { ...input.contractProof, operateScope: false },
      }),
    ).toBeNull();
  });
  it("retains only the closed browser metrics and refuses unknown values before storage", async () => {
    const f = fixture();
    const browser = (await f.port.transport("queued-before-close")).browser;
    expect(projectBrowserInlineObservation(browser)).toEqual(browser);
    expect(projectBrowserInlineObservation({ ...browser, privateUrl: "private" })).toBeNull();
    expect(
      projectBrowserInlineObservation({ ...browser, receivedCloseCode: "private" }),
    ).toBeNull();
    expect(
      projectBrowserInlineObservation({
        ...browser,
        samples: [{ elapsedMs: 1, bufferedBytes: Infinity }],
      }),
    ).toBeNull();
  });
  it("requires public inline delivery and distinct receiver proof for the two browser actions", async () => {
    const f = fixture();
    const result = await runRemainingQualification(f.port);
    expect(f.themes).toEqual(["light", "dark"]);
    expect(f.actions).toEqual(["mid-message-pong", "queued-before-close"]);
    expect(result).toMatchObject({
      complete: true,
      fallback: { inlineBytes: 10485760, uploadRequests: 0 },
      browser: { pongPosition: "after-message", queuedData: "received-before-close" },
      webkitgtk: "not-measured",
      fullMatrixComplete: false,
    });
  });
  it.each([
    "capable",
    "upload-probe",
    "staged-reference",
    "ui-error",
    "digest-mismatch",
    "close-call-only",
  ] as const)(
    "refuses %s evidence without upgrading partial observations into a pass",
    async (fault) => {
      const f = fixture(fault);
      await expect(runRemainingQualification(f.port)).rejects.toThrow();
      if (fault === "capable") expect(f.sent()).toBe(false);
    },
  );
});
