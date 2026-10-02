// @effect-diagnostics nodeBuiltinImport:off - Qualification tests own temporary fixture files.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSizedPng, instrumentCodexAttachmentLog } from "./chat-upload-fixture.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

describe("owned live upload fixtures", () => {
  it("makes an exact 10 MiB PNG with valid chunk checksums and a real pixel", () => {
    const bytes = createSizedPng(10 * 1024 ** 2, "slow-link");
    expect(bytes.length).toBe(10 * 1024 ** 2);
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const names: string[] = [];
    let offset = 8;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const name = bytes.toString("ascii", offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      expect(bytes.readUInt32BE(offset + 8 + length)).toBe(
        NodeZlib.crc32(bytes.subarray(offset + 4, offset + 8 + length)),
      );
      if (name === "IHDR") expect([data.readUInt32BE(0), data.readUInt32BE(4)]).toEqual([1, 1]);
      if (name === "IDAT") expect([...NodeZlib.inflateSync(data)]).toEqual([0, 40, 140, 220, 255]);
      if (name === "tEXt")
        expect(data.toString("latin1").startsWith("bibcode-fixture\0slow-link:")).toBe(true);
      names.push(name);
      offset += 12 + length;
    }
    expect(offset).toBe(bytes.length);
    expect(names).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
  });

  it("rejects invalid fixture budgets instead of making malformed or oversized files", () => {
    for (const size of [0, 100, -1, 2.5, Number.POSITIVE_INFINITY, 10 * 1024 ** 2 + 1]) {
      expect(() => createSizedPng(size, "fixture")).toThrow();
    }
  });

  it("instruments only the exact generated Codex start boundary and fails closed on drift", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-upload-instrument-"));
    directories.push(root);
    const path = NodePath.join(root, "codex-fixture.mjs");
    const hook = '      appendProviderInput("codex", prompt, "start", turnId);';
    NodeFS.writeFileSync(path, "// generated fixture\n" + hook + "\n");
    instrumentCodexAttachmentLog(root);
    expect(NodeFS.readFileSync(path, "utf8")).toContain(
      "recordUploadAttachments(message.params?.input, prompt, turnId)",
    );
    expect(NodeFS.readFileSync(path, "utf8")).toContain(hook);
    const once = NodeFS.readFileSync(path);
    expect(() => instrumentCodexAttachmentLog(root)).toThrow();
    expect(NodeFS.readFileSync(path)).toEqual(once);
    NodeFS.writeFileSync(path, hook + "\n" + hook);
    expect(() => instrumentCodexAttachmentLog(root)).toThrow();
    expect(NodeFS.readFileSync(path, "utf8")).toBe(hook + "\n" + hook);
  });

  it("records actual received bytes and digest without retaining provider attachment content", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-upload-receipt-"));
    directories.push(root);
    const bytes = createSizedPng(1024, "receipt");
    const path = NodePath.join(root, "codex-fixture.mjs");
    const receipt = NodePath.join(root, "receipt.jsonl");
    NodeFS.writeFileSync(
      path,
      "const message = " +
        JSON.stringify({
          params: {
            input: [{ type: "image", url: "data:image/png;base64," + bytes.toString("base64") }],
          },
        }) +
        ';\nconst prompt="upload-receipt", turnId="fixture-turn";\nfunction appendProviderInput() {}\n' +
        '      appendProviderInput("codex", prompt, "start", turnId);\n',
    );
    instrumentCodexAttachmentLog(root);
    NodeChildProcess.execFileSync(process.execPath, [path], {
      env: { BIBCODE_UPLOAD_RECEIPTS: receipt },
      timeout: 5000,
    });
    const result = JSON.parse(NodeFS.readFileSync(receipt, "utf8"));
    expect(result).toEqual({
      prompt: "upload-receipt",
      turnId: "fixture-turn",
      time: expect.any(Number),
      attachments: [
        { bytes: 1024, sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex") },
      ],
    });
    expect(NodeFS.readFileSync(receipt, "utf8")).not.toContain(bytes.toString("base64"));
  });
});
