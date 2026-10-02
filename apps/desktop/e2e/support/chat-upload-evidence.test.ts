// @effect-diagnostics nodeBuiltinImport:off - Qualification evidence tests own private logs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  classifyQualificationFailure,
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
        role: "web",
        exitCode: 2,
        signal: null,
        spawnFailure: null,
        log: path,
      }),
    ).toMatchObject({ logBytesScanned: 65536, logTruncated: true, exitCode: 2 });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
