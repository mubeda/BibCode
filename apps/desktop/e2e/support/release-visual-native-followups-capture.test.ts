// @effect-diagnostics nodeBuiltinImport:off - Synthetic original bytes and disposable filesystem ports only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { captureNativeFollowupOriginal } from "./release-visual-native-followups-capture.ts";
import {
  syntheticNativeFollowupPng,
  syntheticNativeWslWitness,
} from "./release-visual-native-followups-test-fixtures.ts";
it("writes only original bytes after both identity and witness joins and refuses drift or replacement", async () => {
  const evidence = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-original-test-")),
    ),
    bytes = syntheticNativeFollowupPng();
  NodeFS.chmodSync(evidence, 0o700);
  try {
    let reads = 0;
    const input = {
      scene: "native-wsl-local" as const,
      theme: "light" as const,
      evidence,
      captures: new Set<string>(),
      verify: async () => {},
      readWitness: async () => {
        reads++;
        return { ...syntheticNativeWslWitness, mappedDistro: reads === 1 };
      },
      original: async () => bytes,
    };
    await expect(captureNativeFollowupOriginal(input)).rejects.toThrow();
    expect(NodeFS.readdirSync(evidence)).toEqual([]);
    const receipt = await captureNativeFollowupOriginal({
      ...input,
      readWitness: async () => syntheticNativeWslWitness,
    });
    expect(NodeFS.readFileSync(NodePath.join(evidence, receipt.file))).toEqual(bytes);
    expect(NodeFS.statSync(NodePath.join(evidence, receipt.file)).mode & 0o777).toBe(0o600);
    await expect(
      captureNativeFollowupOriginal({
        ...input,
        readWitness: async () => syntheticNativeWslWitness,
      }),
    ).rejects.toThrow();
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});
