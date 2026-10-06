// @effect-diagnostics nodeBuiltinImport:off - Inert WebDriver originals in disposable roots test retention; these are never native evidence.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import {
  captureBrowserFollowupScene,
  browserFollowupFacts,
  type BrowserFollowupObservation,
} from "./release-visual-browser-followups.ts";
import type { QualificationBrowser } from "./qualification-owner.ts";
function png(width = 1280, height = 960) {
  const chunk = (name: string, data: Buffer) => {
    const value = Buffer.alloc(data.length + 12);
    value.writeUInt32BE(data.length);
    value.write(name, 4);
    data.copy(value, 8);
    value.writeUInt32BE(NodeZlib.crc32(value.subarray(4, -4)), value.length - 4);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * (width * 4 + 1) + 1 + x * 4;
      rows[index] = x % 2 ? 230 : 20;
      rows[index + 1] = 100;
      rows[index + 2] = 50;
      rows[index + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const observation: BrowserFollowupObservation = {
  scene: "hosted-pair-confirm",
  theme: "light",
  origin: "http://127.0.0.1:4893",
  environmentId: "local",
  threadId: "owned-thread",
  projectId: "owned-project",
  terminalId: "term-1",
  terminalLabel: "Terminal 1",
  environmentLabel: "Local",
  hostedHost: "127.0.0.1:4887",
};
it.each(["original", "source-changed", "post-unsafe", "geometry"])(
  "retains only a fully joined %s original",
  async (mode) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-followup-capture-")),
    );
    const captured = new Set<string>(),
      bytes = png(mode === "geometry" ? 1279 : 1280);
    let joins = 0,
      reads = 0;
    const browser = {
      ownedIsAlertOpen: async () => false,
      takeScreenshot: async () => bytes.toString("base64"),
      execute: async () => {
        reads++;
        const value = Object.fromEntries(
          browserFollowupFacts(observation.scene).map((key) => [key, true]),
        );
        if (mode === "post-unsafe" && reads === 2) value.credentialAbsent = false;
        return value;
      },
    } as unknown as QualificationBrowser;
    try {
      const capture = captureBrowserFollowupScene({
        browser,
        owner: {
          until: async (predicate) => {
            if (!(await predicate())) throw new Error("Inert admission refused");
          },
        },
        evidence: root,
        captured,
        observation,
        verifySource: async () => {
          joins++;
          if (mode === "source-changed" && joins === 2) throw new Error("Inert changed source");
        },
      });
      if (mode === "original") {
        const receipt = await capture;
        const original = NodeFS.readFileSync(NodePath.join(root, receipt.file));
        expect(original).toEqual(bytes);
        expect(receipt.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
        expect(receipt.baseOriginal).toBe(true);
        expect(captured.size).toBe(1);
      } else {
        await expect(capture).rejects.toThrow();
        expect(NodeFS.readdirSync(root)).toEqual([]);
        expect(captured.size).toBe(0);
      }
      expect(joins).toBe(2);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
