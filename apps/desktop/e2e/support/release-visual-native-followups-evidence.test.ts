// @effect-diagnostics nodeBuiltinImport:off - Synthetic receipt privacy and original-preservation checks only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "../../../../packages/shared/src/hostProcess.ts";
const fixturePlatform = HostProcessPlatform.defaultValue();
import { retainNativeFollowupEvidence } from "./release-visual-native-followups-evidence.ts";
import {
  syntheticNativeFollowupPng,
  syntheticNativeWslWitness,
} from "./release-visual-native-followups-test-fixtures.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
it("refuses private or unjoined receipts before any publication, then copies the exact approved originals", () => {
  const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-publish-test-")),
    ),
    output = NodePath.join(root, "out");
  try {
    const bytes = syntheticNativeFollowupPng(),
      image = inspectScreenshot(bytes),
      originals = ["light", "dark"].map((theme) => ({
        scene: "native-wsl-local",
        theme,
        file: "native-wsl-local-" + theme + ".png",
        ...image,
      }));
    const result = {
      schemaVersion: 1,
      selection: "release-visual-native-followups",
      complete: false,
      baseRowCount: 5,
      requiredOriginalCount: 10,
      originalCount: 2,
      outstandingRowCount: 4,
      prerequisiteStatus: "unavailable",
      cleanup: "joined",
      visualReview: "pending",
      partition: "windows-wsl",
      partitionComplete: true,
      sourceSha: "a".repeat(40),
      appSha256: "b".repeat(64),
      dataRootIdentitySha256: "c".repeat(64),
      processIdentitySha256: "d".repeat(64),
      sourceFiles: [{ path: "apps/web/src/AppRoot.tsx", sha256: "e".repeat(64) }],
      processes: [],
    };
    const assertions = originals.map((original) => ({
      original,
      before: syntheticNativeWslWitness,
      after: syntheticNativeWslWitness,
      sourceSha: result.sourceSha,
      appSha256: result.appSha256,
      physicalRootSha256: result.dataRootIdentitySha256,
      processIdentitySha256: result.processIdentitySha256,
      storageIdentitySha256: "f".repeat(64),
      bootIdentitySha256: "1".repeat(64),
      endpointSha256: "2".repeat(64),
      versionSha256: "3".repeat(64),
      nativeViewport: { width: 1280, height: 960, scale: 1 },
    }));
    const write = (name: string, value: object) =>
      NodeFS.writeFileSync(NodePath.join(root, name + ".json"), JSON.stringify(value), {
        mode: 0o600,
      });
    write("originals", { schemaVersion: 1, originals });
    write("assertions", { schemaVersion: 1, assertions });
    for (const original of originals)
      NodeFS.writeFileSync(NodePath.join(root, original.file), bytes, { mode: 0o600 });
    write("result", { ...result, rawError: "PRIVATE" });
    expect(() =>
      retainNativeFollowupEvidence({
        privateEvidence: root,
        destination: output,
        platform: fixturePlatform === "win32" ? "win32" : "linux",
        cleanupSafe: true,
      }),
    ).toThrow();
    expect(NodeFS.existsSync(output)).toBe(false);
    write("result", result);
    expect(() =>
      retainNativeFollowupEvidence({
        privateEvidence: root,
        destination: output,
        platform: fixturePlatform === "win32" ? "win32" : "linux",
        cleanupSafe: false,
      }),
    ).toThrow();
    expect(NodeFS.existsSync(output)).toBe(false);
    expect(
      retainNativeFollowupEvidence({
        privateEvidence: root,
        destination: output,
        platform: fixturePlatform === "win32" ? "win32" : "linux",
        cleanupSafe: true,
      }),
    ).toMatchObject({ originalCount: 2, visualReview: "pending", complete: false });
    expect(NodeFS.readFileSync(NodePath.join(output, "native-wsl-local-dark.png"))).toEqual(bytes);
    expect(NodeFS.readdirSync(output).sort()).toEqual([
      "native-followups-assertions.json",
      "native-followups-originals.json",
      "native-followups-result.json",
      "native-wsl-local-dark.png",
      "native-wsl-local-light.png",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["duplicate", "hash", "theme"])(
  "refuses a non-bijective or mismatched %s original assertion before publication",
  (fault) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-join-test-")),
    );
    try {
      const bytes = syntheticNativeFollowupPng(),
        image = inspectScreenshot(bytes);
      const originals = ["light", "dark"].map((theme) => ({
        scene: "native-wsl-local",
        theme,
        file: "native-wsl-local-" + theme + ".png",
        ...image,
      }));
      const result = {
        schemaVersion: 1,
        selection: "release-visual-native-followups",
        complete: false,
        baseRowCount: 5,
        requiredOriginalCount: 10,
        originalCount: 2,
        outstandingRowCount: 4,
        prerequisiteStatus: "unavailable",
        cleanup: "joined",
        visualReview: "pending",
        partition: "windows-wsl",
        partitionComplete: true,
        sourceSha: "a".repeat(40),
        appSha256: "b".repeat(64),
        dataRootIdentitySha256: "c".repeat(64),
        processIdentitySha256: "d".repeat(64),
        sourceFiles: [{ path: "apps/web/src/AppRoot.tsx", sha256: "e".repeat(64) }],
        processes: [],
      };
      const assertions = originals.map((original) => ({
        original,
        before: syntheticNativeWslWitness,
        after: syntheticNativeWslWitness,
        sourceSha: result.sourceSha,
        appSha256: result.appSha256,
        physicalRootSha256: result.dataRootIdentitySha256,
        processIdentitySha256: result.processIdentitySha256,
        storageIdentitySha256: "f".repeat(64),
        bootIdentitySha256: "1".repeat(64),
        endpointSha256: "2".repeat(64),
        versionSha256: "3".repeat(64),
        nativeViewport: { width: 1280, height: 960, scale: 1 },
      }));
      if (fault === "duplicate") assertions[1] = assertions[0]!;
      if (fault === "hash")
        assertions[1] = {
          ...assertions[1]!,
          original: { ...originals[1]!, sha256: "f".repeat(64) },
        };
      if (fault === "theme")
        assertions[1] = {
          ...assertions[1]!,
          original: { ...originals[1]!, theme: "light", file: "native-wsl-local-light.png" },
        };
      const write = (name: string, value: object) =>
        NodeFS.writeFileSync(NodePath.join(root, name + ".json"), JSON.stringify(value), {
          mode: 0o600,
        });
      write("result", result);
      write("originals", { schemaVersion: 1, originals });
      write("assertions", { schemaVersion: 1, assertions });
      for (const original of originals)
        NodeFS.writeFileSync(NodePath.join(root, original.file), bytes, { mode: 0o600 });
      const destination = NodePath.join(root, "out");
      expect(() =>
        retainNativeFollowupEvidence({
          privateEvidence: root,
          destination,
          cleanupSafe: true,
          platform: fixturePlatform === "win32" ? "win32" : "linux",
        }),
      ).toThrow();
      expect(NodeFS.existsSync(destination)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
