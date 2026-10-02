// @effect-diagnostics nodeBuiltinImport:off - Qualification evidence tests own private logs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  classifyQualificationFailure,
  mayCaptureQualificationFailure,
  projectPairingObservation,
  projectQualificationProcess,
} from "./chat-upload-evidence.ts";

it("retains only closed failure categories even when every error field contains secrets", () => {
  const secret = "fixture-secret-do-not-retain";
  const error = Object.assign(new Error("no such element " + secret), {
    name: secret,
    code: secret,
    status: secret,
    signal: secret,
    stdout: secret,
    stderr: secret,
  });
  const projected = classifyQualificationFailure(error);
  expect(projected.kind).toBe("missing-element");
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(projected.errorClass).toBeNull();
  expect(classifyQualificationFailure(new TypeError("Invalid URL " + secret))).toMatchObject({
    errorClass: "TypeError",
    launchMarkers: { endpoint: true },
  });
  expect(classifyQualificationFailure({ code: "ENOENT", message: secret }).systemCode).toBe(
    "ENOENT",
  );
  expect(classifyQualificationFailure({ signal: "SIGABRT", status: 134 }).signal).toBe("SIGABRT");
  for (const [message, kind] of [
    ["element click intercepted: " + secret, "click-intercepted"],
    ["element wasn't found: " + secret, "missing-element"],
    ["stale element reference: " + secret, "stale-element"],
    ["element still not displayed after 30000ms: " + secret, "timeout"],
  ]) {
    const projected = classifyQualificationFailure(new Error(message));
    expect(projected.kind).toBe(kind);
    expect(JSON.stringify(projected)).not.toContain(secret);
  }
});

it.each([
  ["invalid element state", "invalid-element-state"],
  ["element not interactable", "element-not-interactable"],
  ["invalid argument", "invalid-argument"],
] as const)("retains the closed WebDriver response code %s without raw detail", (name, kind) => {
  const secret = "file-or-credential-detail-do-not-retain";
  const result = classifyQualificationFailure({ name, message: secret });
  expect(result).toMatchObject({ kind, errorClass: name });
  expect(JSON.stringify(result)).not.toContain(secret);
  const unknown = classifyQualificationFailure({ name: name + secret, message: secret });
  expect(unknown.kind).toBe("unclassified");
  expect(unknown.errorClass).toBeNull();
});

it.each([
  ["pair-wait-token", false, false, true, true],
  ["pair-wait-token", true, false, true, false],
  ["pair-submit", true, false, true, false],
  ["pair-wait-sidebar", true, false, true, false],
  ["pair-navigate", false, false, true, false],
  ["real-composer-small-upload", true, true, true, true],
  ["pair-wait-token", false, false, false, false],
  ["real-composer-small-upload", true, true, false, false],
] as const)(
  "bounds failure capture for phase %s, entry %s, paired %s, safe %s",
  (phase, credentialEntryAttempted, pairingCompleted, screenSafe, expected) => {
    expect(
      mayCaptureQualificationFailure({
        phase,
        credentialEntryAttempted,
        pairingCompleted,
        screenSafe,
      }),
    ).toBe(expected);
  },
);

it("retains only closed pairing state without credentials, DOM text or URLs", () => {
  const secret = "pairing-secret-do-not-retain";
  const projected = projectPairingObservation({
    route: "pair",
    readyState: "complete",
    tokenInputPresent: true,
    tokenInputDisabled: false,
    submitPresent: true,
    submitDisabled: false,
    errorNoticePresent: true,
    pendingHeadingPresent: false,
    sidebarPresent: false,
    observerPresent: true,
    plainSocketCreated: 1,
    plainSocketOpened: 0,
    credential: secret,
    errorText: secret,
    url: "http://localhost/pair?code=" + secret,
  });
  expect(projected).toEqual({
    route: "pair",
    readyState: "complete",
    tokenInputPresent: true,
    tokenInputDisabled: false,
    submitPresent: true,
    submitDisabled: false,
    errorNoticePresent: true,
    pendingHeadingPresent: false,
    sidebarPresent: false,
    observerPresent: true,
    plainSocketCreated: 1,
    plainSocketOpened: 0,
  });
  expect(JSON.stringify(projected)).not.toContain(secret);
  const unknown = projectPairingObservation({
    route: secret,
    readyState: secret,
    tokenInputPresent: secret,
    plainSocketCreated: -1,
    plainSocketOpened: 20001,
  });
  expect(Object.values(unknown).every((value) => value === null)).toBe(true);
  expect(Object.values(projectPairingObservation(null)).every((value) => value === null)).toBe(
    true,
  );
  expect(projectPairingObservation({ route: ["pair"], readyState: ["complete"] })).toMatchObject({
    route: null,
    readyState: null,
  });
});

it("reports process exits and bounded guard refusal counts without any log text", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-upload-evidence-"));
  try {
    const path = NodePath.join(root, "private.log");
    NodeFS.writeFileSync(
      path,
      "secret-before\nhermetic-test-guard: refused codex at secret-path\nsecret-after\n",
    );
    const projected = projectQualificationProcess({
      role: "plain",
      exitCode: null,
      signal: "SIGABRT",
      spawnFailure: null,
      log: path,
    });
    expect(projected).toMatchObject({
      role: "plain",
      exitCode: null,
      signal: "SIGABRT",
      guardRefusals: 1,
      logTruncated: false,
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    NodeFS.writeFileSync(path, "x".repeat(200_000));
    expect(
      projectQualificationProcess({
        role: "driver",
        exitCode: 2,
        signal: null,
        spawnFailure: null,
        log: path,
      }),
    ).toMatchObject({ role: "driver", logBytesScanned: 65536, logTruncated: true, exitCode: 2 });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
