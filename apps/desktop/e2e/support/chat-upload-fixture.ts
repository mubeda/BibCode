// @effect-diagnostics nodeBuiltinImport:off - Temporary browser qualification owns generated fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

const MAX_IMAGE_BYTES = 10 * 1024 ** 2;

function chunk(name: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(name, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(NodeZlib.crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
  return bytes;
}

/** A real one-pixel PNG padded with legal ancillary text, without costly image decoding. */
export function createSizedPng(size: number, label: string): Buffer {
  if (!Number.isSafeInteger(size) || size < 256 || size > MAX_IMAGE_BYTES) {
    throw new Error("The qualification image must be between 256 bytes and 10 MiB.");
  }
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Invalid fixture image label.");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const ihdr = chunk("IHDR", header);
  const idat = chunk("IDAT", NodeZlib.deflateSync(Buffer.from([0, 40, 140, 220, 255])));
  const end = chunk("IEND", Buffer.alloc(0));
  const text = Buffer.alloc(
    size - signature.length - ihdr.length - idat.length - end.length - 12,
    65,
  );
  const prefix = Buffer.from("bibcode-fixture\0" + label + ":", "latin1");
  if (prefix.length > text.length) throw new Error("Fixture padding is too small.");
  prefix.copy(text);
  return Buffer.concat([signature, ihdr, chunk("tEXt", text), idat, end]);
}

const receiptModule = String.raw`
import * as fs from "node:fs";
import * as crypto from "node:crypto";

export function recordUploadAttachments(parts, prompt, turnId) {
  if (!prompt.startsWith("upload-")) return;
  const path = process.env.BIBCODE_UPLOAD_RECEIPTS;
  if (!path || !Array.isArray(parts)) throw new Error("Missing owned upload receipt target.");
  const attachments = parts.filter((part) => part?.type === "image").map((part) => {
    const prefix = "data:image/png;base64,";
    if (typeof part.url !== "string" || !part.url.startsWith(prefix) || part.url.length > 15 * 1024 ** 2) {
      throw new Error("Unexpected fixture provider image input.");
    }
    const encoded = part.url.slice(prefix.length);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 10 * 1024 ** 2 || bytes.toString("base64") !== encoded) {
      throw new Error("Malformed fixture provider image input.");
    }
    return { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  fs.appendFileSync(path, JSON.stringify({ prompt, turnId, attachments, time: Date.now() }) + "\n", { mode: 0o600 });
}
`.trimStart();

/** Extend only the private generated provider, and reject changed/duplicate hook shapes. */
export function instrumentCodexAttachmentLog(shimDirectory: string): void {
  const path = NodePath.join(shimDirectory, "codex-fixture.mjs");
  const source = NodeFS.readFileSync(path, "utf8");
  const hook = '      appendProviderInput("codex", prompt, "start", turnId);';
  if (source.split(hook).length !== 2 || source.includes("recordUploadAttachments")) {
    throw new Error("The maintained Codex fixture start boundary changed.");
  }
  NodeFS.writeFileSync(NodePath.join(shimDirectory, "upload-receipt-fixture.mjs"), receiptModule, {
    mode: 0o600,
  });
  NodeFS.writeFileSync(
    path,
    'import { recordUploadAttachments } from "./upload-receipt-fixture.mjs";\n' +
      source.replace(
        hook,
        hook + "\n      recordUploadAttachments(message.params?.input, prompt, turnId);",
      ),
  );
}
