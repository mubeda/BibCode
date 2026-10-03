// @effect-diagnostics nodeBuiltinImport:off - Qualification policy tests inspect their own private CI profile.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  runRemainingQualification,
  projectBrowserInlineObservation,
  projectOldInlineInput,
  type RemainingQualificationPort,
} from "./chat-remaining-qualification.ts";
import type { BrowserInlineAction } from "./chat-inline-mechanics.ts";
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
