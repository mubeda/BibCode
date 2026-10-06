// @effect-diagnostics nodeBuiltinImport:off - Only exact admitted source inputs and private fixture configuration are owned here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { AssetCreateUrlResult } from "../../../../packages/contracts/src/assets.ts";
import type { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import {
  readOwnedDeliveryWorktree,
  type DeliveryWorktreeInput,
  type DeliveryWorktreeIdentity,
} from "./delivery-retry-workspace.ts";

const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
import {
  providerChatFileBaseline,
  providerChatFileUpdated,
} from "./release-visual-provider-chat-values.ts";
export {
  providerChatFileBaseline,
  providerChatFileUpdated,
} from "./release-visual-provider-chat-values.ts";
const refused = () => new Error("Owned provider media refused.");
const hash = (value: Buffer) => NodeCrypto.createHash("sha256").update(value).digest("hex");
interface FileProof {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly bytes: Buffer;
}
interface MediaProof {
  readonly input: DeliveryWorktreeInput;
  readonly identity: DeliveryWorktreeIdentity;
  readonly threadId: string;
  readonly source: FileProof;
  readonly image: FileProof;
  marker?: FileProof;
}
/** Opaque private file/asset configuration, never retained as public evidence. */
export interface ProviderChatMediaScope {
  readonly kind: "provider-chat-media";
}
const proofs = new WeakMap<ProviderChatMediaScope, MediaProof>();
function file(path: string): FileProof {
  const stat = NodeFS.lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 8192 ||
    NodeFS.realpathSync(path) !== path
  )
    throw refused();
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, bytes: NodeFS.readFileSync(path) });
}
function readProof(scope: ProviderChatMediaScope, changed: boolean): MediaProof {
  const proof = proofs.get(scope);
  if (
    !proof ||
    JSON.stringify(readOwnedDeliveryWorktree(proof.input)) !== JSON.stringify(proof.identity)
  )
    throw refused();
  const source = file(proof.source.path),
    image = file(proof.image.path);
  if (
    source.dev !== proof.source.dev ||
    source.ino !== proof.source.ino ||
    source.bytes.toString("utf8") !==
      (changed ? providerChatFileUpdated : providerChatFileBaseline) ||
    image.dev !== proof.image.dev ||
    image.ino !== proof.image.ino ||
    !image.bytes.equals(proof.image.bytes)
  )
    throw refused();
  if (proof.marker) {
    const marker = file(proof.marker.path);
    if (
      marker.dev !== proof.marker.dev ||
      marker.ino !== proof.marker.ino ||
      !marker.bytes.equals(proof.marker.bytes) ||
      (NodeFS.lstatSync(marker.path).mode & 0o777) !== 0o600
    )
      throw refused();
  }
  return proof;
}

/** Seed before the baseline turn so the real checkpoint later observes the native file mutation. */
export function prepareProviderChatFiles(
  input: DeliveryWorktreeInput,
  thread: OrchestrationThread,
): ProviderChatMediaScope {
  try {
    const identity = Object.freeze(readOwnedDeliveryWorktree(input));
    if (
      thread.deletedAt !== null ||
      thread.kind !== "workspace" ||
      thread.worktreePath !== identity.path ||
      thread.branch !== identity.branch ||
      typeof thread.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(thread.id)
    )
      throw refused();
    const image = file(NodePath.join(identity.path, "visual-swatch.png"));
    if (
      image.bytes.length < 33 ||
      !image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      image.bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
      image.bytes.readUInt32BE(16) !== 64 ||
      image.bytes.readUInt32BE(20) !== 64
    )
      throw refused();
    const sourcePath = NodePath.join(identity.path, "visual-chat.ts");
    NodeFS.writeFileSync(sourcePath, providerChatFileBaseline, { mode: 0o600, flag: "wx" });
    const scope: ProviderChatMediaScope = Object.freeze({ kind: "provider-chat-media" });
    proofs.set(scope, {
      input: Object.freeze({ ...input }),
      identity,
      threadId: thread.id,
      source: file(sourcePath),
      image,
    });
    return scope;
  } catch {
    throw refused();
  }
}

/** Bind only the genuine typed URL and exact served bytes to a one-use native fixture input. */
export async function configureProviderChatMedia(
  scope: ProviderChatMediaScope,
  value: unknown,
  fetchAsset: (url: string) => Promise<Buffer>,
): Promise<void> {
  try {
    const proof = readProof(scope, false);
    if (proof.marker) throw refused();
    const asset: AssetCreateUrlResult = Schema.decodeUnknownSync(AssetCreateUrlResult)(value);
    const url = new URL(asset.relativeUrl, "http://127.0.0.1:4885");
    if (
      !asset.relativeUrl.startsWith("/api/assets/") ||
      url.origin !== "http://127.0.0.1:4885" ||
      url.hash ||
      url.username ||
      url.password
    )
      throw refused();
    const bytes = await fetchAsset(url.toString());
    if (!Buffer.isBuffer(bytes) || !bytes.equals(proof.image.bytes)) throw refused();
    readProof(scope, false);
    const marker = NodePath.join(proof.input.root, "provider-chat-media.json");
    NodeFS.writeFileSync(
      marker,
      JSON.stringify({
        kind: "provider-chat-v1",
        worktreePath: proof.identity.path,
        threadId: proof.threadId,
        assetRelativeUrl: asset.relativeUrl,
        sourceSha256: hash(proof.source.bytes),
        updatedSha256: hash(Buffer.from(providerChatFileUpdated)),
        imageSha256: hash(proof.image.bytes),
        sourceDev: proof.source.dev,
        sourceIno: proof.source.ino,
        imageDev: proof.image.dev,
        imageIno: proof.image.ino,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    proof.marker = file(marker);
    readProof(scope, false);
  } catch {
    throw refused();
  }
}

/** Source inputs remain private; a changed proof is required only after the actual native plan turn. */
export function verifyProviderChatMedia(scope: ProviderChatMediaScope, changed: boolean): void {
  try {
    const proof = readProof(scope, changed);
    if (!proof.marker) throw refused();
  } catch {
    throw refused();
  }
}
