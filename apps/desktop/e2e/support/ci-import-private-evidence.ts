// @effect-diagnostics nodeBuiltinImport:off - CI-only authenticated private evidence envelope.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ImportEvidenceAdmission {
  readonly publicKey: NodeCrypto.KeyObject;
  readonly context: Buffer;
}

export interface ImportEvidenceEnvelope {
  readonly context: Buffer;
  readonly ciphertext: Buffer;
  readonly wrappedKey: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
}

const MAX_REPLY_BYTES = 256 * 1024;
const OMITTED = "Private import evidence omitted.";

function positiveCanonicalInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : null;
}

export function admitImportEvidenceRecipient(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  scope:
    | "browser-owned-project-import"
    | "browser-owned-terminal-observer-refusal" = "browser-owned-project-import",
): ImportEvidenceAdmission | null {
  if (
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_JOB !== "visual_core" ||
    env.BIBCODE_DELIVERY_UI_SELECTION !== "release-visual-browser-followups" ||
    env.BIBCODE_IMPORT_EVIDENCE_SELECTED !== "true"
  )
    return null;
  const spki = env.BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI;
  const fingerprint = env.BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256;
  const source = env.GITHUB_SHA;
  const run = positiveCanonicalInteger(env.GITHUB_RUN_ID);
  const attempt = positiveCanonicalInteger(env.GITHUB_RUN_ATTEMPT);
  if (
    spki === undefined ||
    spki.length < 1 ||
    spki.length > 2048 ||
    spki.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(spki) ||
    fingerprint === undefined ||
    fingerprint.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    source === undefined ||
    source.length !== 40 ||
    !/^[a-f0-9]{40}$/.test(source) ||
    run === null ||
    attempt === null
  )
    return null;
  try {
    const der = Buffer.from(spki, "base64");
    if (
      der.length < 1 ||
      der.length > 1024 ||
      der.toString("base64") !== spki ||
      NodeCrypto.createHash("sha256").update(der).digest("hex") !== fingerprint
    )
      return null;
    const publicKey = NodeCrypto.createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "rsa" ||
      publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
      publicKey.asymmetricKeyDetails.publicExponent !== 65537n ||
      !publicKey.export({ format: "der", type: "spki" }).equals(der)
    )
      return null;
    const context = Buffer.from(
      JSON.stringify({
        version: 1,
        scope,
        alg: "RSA-OAEP-SHA256",
        enc: "AES-256-GCM",
        source,
        run,
        attempt,
        jobRole: "visual_core",
        fingerprint,
      }),
    );
    return Object.freeze({ publicKey, context });
  } catch {
    return null;
  }
}

export function sealImportFailure(
  admission: ImportEvidenceAdmission,
  reply: Uint8Array,
): ImportEvidenceEnvelope {
  if (reply.byteLength < 1 || reply.byteLength > MAX_REPLY_BYTES) throw new Error(OMITTED);
  const plaintext = Buffer.from(reply);
  let key: Buffer | undefined;
  try {
    key = NodeCrypto.randomBytes(32);
    const nonce = NodeCrypto.randomBytes(12);
    const context = Buffer.from(admission.context);
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = NodeCrypto.publicEncrypt(
      {
        key: admission.publicKey,
        padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      key,
    );
    return Object.freeze({ context, ciphertext, wrappedKey, nonce, tag });
  } catch {
    throw new Error(OMITTED);
  } finally {
    plaintext.fill(0);
    key?.fill(0);
  }
}

function currentOwner(): number {
  if (typeof process.getuid !== "function") throw new Error(OMITTED);
  return process.getuid();
}

function assertDirectoryPin(path: string, descriptor: number): void {
  const entry = NodeFS.lstatSync(path);
  const pinned = NodeFS.fstatSync(descriptor);
  const owner = currentOwner();
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !pinned.isDirectory() ||
    entry.uid !== owner ||
    pinned.uid !== owner ||
    (entry.mode & 0o777) !== 0o700 ||
    (pinned.mode & 0o777) !== 0o700 ||
    entry.dev !== pinned.dev ||
    entry.ino !== pinned.ino ||
    NodeFS.realpathSync.native(path) !== path
  )
    throw new Error(OMITTED);
}

function openPrivateDirectory(path: string): number {
  const descriptor = NodeFS.openSync(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    assertDirectoryPin(path, descriptor);
    return descriptor;
  } catch {
    NodeFS.closeSync(descriptor);
    throw new Error(OMITTED);
  }
}

function assertAbsent(path: string): void {
  try {
    NodeFS.lstatSync(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw new Error(OMITTED);
  }
  throw new Error(OMITTED);
}

export function publishImportFailure(
  evidenceRoot: string,
  parts: ImportEvidenceEnvelope,
  namespace: "import-private" | "terminal-private" = "import-private",
): void {
  const descriptors: number[] = [];
  try {
    const expectedFields = ["ciphertext", "context", "nonce", "tag", "wrappedKey"];
    if (
      Object.keys(parts).sort().join(",") !== expectedFields.join(",") ||
      !Object.values(parts).every((part) => Buffer.isBuffer(part)) ||
      parts.context.length < 1 ||
      parts.context.length > 4096 ||
      parts.ciphertext.length < 1 ||
      parts.ciphertext.length > MAX_REPLY_BYTES ||
      parts.wrappedKey.length !== 384 ||
      parts.nonce.length !== 12 ||
      parts.tag.length !== 16
    )
      throw new Error(OMITTED);
    const owner = currentOwner();
    if (!NodePath.isAbsolute(evidenceRoot) || NodePath.resolve(evidenceRoot) !== evidenceRoot)
      throw new Error(OMITTED);
    const rootDescriptor = openPrivateDirectory(evidenceRoot);
    descriptors.push(rootDescriptor);
    const owned = NodePath.join(evidenceRoot, namespace);
    NodeFS.mkdirSync(owned, { mode: 0o700 });
    assertDirectoryPin(evidenceRoot, rootDescriptor);
    const ownedDescriptor = openPrivateDirectory(owned);
    descriptors.push(ownedDescriptor);
    const pending = NodePath.join(owned, "pending");
    const ready = NodePath.join(owned, "ready");
    NodeFS.mkdirSync(pending, { mode: 0o700 });
    const pendingDescriptor = openPrivateDirectory(pending);
    descriptors.push(pendingDescriptor);
    const files = {
      "context.json": parts.context,
      "reply.aesgcm.bin": parts.ciphertext,
      "key.rsa-oaep-sha256.bin": parts.wrappedKey,
      "nonce.bin": parts.nonce,
      "tag.bin": parts.tag,
    };
    for (const [name, bytes] of Object.entries(files)) {
      assertDirectoryPin(evidenceRoot, rootDescriptor);
      assertDirectoryPin(owned, ownedDescriptor);
      assertDirectoryPin(pending, pendingDescriptor);
      const file = NodePath.join(pending, name);
      const descriptor = NodeFS.openSync(
        file,
        NodeFS.constants.O_WRONLY |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_EXCL |
          NodeFS.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        NodeFS.writeFileSync(descriptor, bytes);
        NodeFS.fsyncSync(descriptor);
        const entry = NodeFS.lstatSync(file);
        const pinned = NodeFS.fstatSync(descriptor);
        if (
          !entry.isFile() ||
          !pinned.isFile() ||
          entry.nlink !== 1 ||
          pinned.nlink !== 1 ||
          entry.uid !== owner ||
          (entry.mode & 0o777) !== 0o600 ||
          entry.dev !== pinned.dev ||
          entry.ino !== pinned.ino ||
          entry.size !== bytes.length
        )
          throw new Error(OMITTED);
      } finally {
        NodeFS.closeSync(descriptor);
      }
    }
    NodeFS.fsyncSync(pendingDescriptor);
    assertDirectoryPin(evidenceRoot, rootDescriptor);
    assertDirectoryPin(owned, ownedDescriptor);
    assertDirectoryPin(pending, pendingDescriptor);
    assertAbsent(ready);
    NodeFS.renameSync(pending, ready);
    assertDirectoryPin(ready, pendingDescriptor);
    assertDirectoryPin(owned, ownedDescriptor);
    assertDirectoryPin(evidenceRoot, rootDescriptor);
    NodeFS.fsyncSync(ownedDescriptor);
    NodeFS.fsyncSync(rootDescriptor);
  } catch {
    throw new Error(OMITTED);
  } finally {
    let closeFailed = false;
    for (const descriptor of descriptors.reverse()) {
      try {
        NodeFS.closeSync(descriptor);
      } catch {
        closeFailed = true;
      }
    }
    if (closeFailed) throw new Error(OMITTED);
  }
}
