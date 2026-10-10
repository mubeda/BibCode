// @effect-diagnostics nodeBuiltinImport:off - Hermetic crypto and temporary filesystem evidence checks.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, it } from "vite-plus/test";
import {
  admitImportEvidenceRecipient,
  sealImportFailure,
  publishImportFailure,
  type ImportEvidenceEnvelope,
} from "./ci-import-private-evidence.ts";

const recipient = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicExponent: 65537,
});
function environment(
  publicKey: NodeCrypto.KeyObject = recipient.publicKey,
): Record<string, string> {
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_JOB: "visual_core",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    BIBCODE_DELIVERY_UI_SELECTION: "release-visual-browser-followups",
    BIBCODE_IMPORT_EVIDENCE_SELECTED: "true",
    BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI: der.toString("base64"),
    BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256: NodeCrypto.createHash("sha256")
      .update(der)
      .digest("hex"),
  };
}
function admission() {
  const admitted = admitImportEvidenceRecipient(environment(), "linux");
  NodeAssert.ok(admitted);
  return admitted;
}
function decrypt(
  parts: ImportEvidenceEnvelope,
  key: NodeCrypto.KeyObject = recipient.privateKey,
): Buffer {
  const unwrapped = NodeCrypto.privateDecrypt(
    { key, padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    parts.wrappedKey,
  );
  try {
    NodeAssert.equal(unwrapped.length, 32);
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", unwrapped, parts.nonce);
    decipher.setAAD(parts.context);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  } finally {
    unwrapped.fill(0);
  }
}

describe("CI import private evidence", () => {
  it("admits the owned manual browser job and decrypts a fresh authenticated five-part envelope", () => {
    const admitted = admission();
    const reply = Buffer.from("test-owned import refusal");
    const parts = sealImportFailure(admitted, reply);
    NodeAssert.deepEqual(decrypt(parts), reply);
    NodeAssert.equal(reply.toString(), "test-owned import refusal");
    NodeAssert.deepEqual(Object.keys(parts).sort(), [
      "ciphertext",
      "context",
      "nonce",
      "tag",
      "wrappedKey",
    ]);
    NodeAssert.equal(parts.wrappedKey.length, 384);
    NodeAssert.equal(parts.nonce.length, 12);
    NodeAssert.equal(parts.tag.length, 16);
    NodeAssert.deepEqual(JSON.parse(parts.context.toString()), {
      version: 1,
      scope: "browser-owned-project-import",
      alg: "RSA-OAEP-SHA256",
      enc: "AES-256-GCM",
      source: "1".repeat(40),
      run: 123,
      attempt: 1,
      jobRole: "visual_core",
      fingerprint: environment().BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256,
    });
    for (const part of Object.values(parts)) NodeAssert.equal(part.includes(reply), false);
    const second = sealImportFailure(admitted, reply);
    NodeAssert.notDeepEqual(second.nonce, parts.nonce);
    NodeAssert.notDeepEqual(second.wrappedKey, parts.wrappedKey);
  });
});

describe("owned private evidence publication", () => {
  it("publishes exactly five private ciphertext files atomically and refuses a second publication", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync.native(NodeOS.tmpdir()), "bibcode-import-"),
    );
    try {
      NodeFS.chmodSync(root, 0o700);
      const reply = Buffer.from("test-owned import refusal");
      const parts = sealImportFailure(admission(), reply);
      publishImportFailure(root, parts);
      const owned = NodePath.join(root, "import-private");
      const ready = NodePath.join(owned, "ready");
      NodeAssert.deepEqual(NodeFS.readdirSync(root), ["import-private"]);
      NodeAssert.deepEqual(NodeFS.readdirSync(owned), ["ready"]);
      const expected = {
        "context.json": parts.context,
        "reply.aesgcm.bin": parts.ciphertext,
        "key.rsa-oaep-sha256.bin": parts.wrappedKey,
        "nonce.bin": parts.nonce,
        "tag.bin": parts.tag,
      };
      NodeAssert.deepEqual(NodeFS.readdirSync(ready).sort(), Object.keys(expected).sort());
      for (const directory of [root, owned, ready])
        NodeAssert.equal(NodeFS.lstatSync(directory).mode & 0o777, 0o700);
      for (const [name, value] of Object.entries(expected)) {
        const file = NodePath.join(ready, name);
        NodeAssert.equal(NodeFS.lstatSync(file).mode & 0o777, 0o600);
        NodeAssert.equal(NodeFS.lstatSync(file).nlink, 1);
        NodeAssert.deepEqual(NodeFS.readFileSync(file), value);
        NodeAssert.equal(NodeFS.readFileSync(file).includes(reply), false);
      }
      NodeAssert.throws(() =>
        publishImportFailure(root, sealImportFailure(admission(), Buffer.from("another refusal"))),
      );
      for (const [name, value] of Object.entries(expected))
        NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(ready, name)), value);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

function withRoot(check: (root: string) => void): void {
  const root = NodeFS.mkdtempSync(
    NodePath.join(NodeFS.realpathSync.native(NodeOS.tmpdir()), "bibcode-import-"),
  );
  try {
    NodeFS.chmodSync(root, 0o700);
    check(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("recipient and authenticated-envelope boundaries", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["CI", "false"],
    ["GITHUB_ACTIONS", "false"],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_EVENT_NAME", "workflow_call"],
    ["GITHUB_JOB", "other"],
    ["BIBCODE_DELIVERY_UI_SELECTION", "release-visual-core"],
    ["BIBCODE_IMPORT_EVIDENCE_SELECTED", "false"],
    ["GITHUB_SHA", "A".repeat(40)],
    ["GITHUB_SHA", "1".repeat(40) + "\n"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ID", "01"],
    ["GITHUB_RUN_ID", "1\n"],
    ["GITHUB_RUN_ID", "9007199254740992"],
    ["GITHUB_RUN_ATTEMPT", "-1"],
    ["GITHUB_RUN_ATTEMPT", "1.0"],
    ["GITHUB_RUN_ATTEMPT", ""],
    ["BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI", ""],
    ["BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI", "A".repeat(2052)],
    ["BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI", "AAAA"],
    ["BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256", "0".repeat(64)],
    ["BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256", "A".repeat(64)],
  ];
  for (const [name, value] of refused) {
    it(`omits an invalid ${name} binding`, () => {
      NodeAssert.equal(
        admitImportEvidenceRecipient({ ...environment(), [name]: value }, "linux"),
        null,
      );
    });
  }
  it("omits missing opt-in or CI/key bindings and non-Linux jobs without throwing", () => {
    NodeAssert.equal(admitImportEvidenceRecipient({}, "linux"), null);
    for (const name of Object.keys(environment())) {
      const env = environment();
      delete env[name];
      NodeAssert.equal(admitImportEvidenceRecipient(env, "linux"), null);
    }
    for (const platform of ["darwin", "win32", "Linux"])
      NodeAssert.equal(admitImportEvidenceRecipient(environment(), platform), null);
  });
  it("rejects noncanonical base64/DER, private/PKCS1 keys, wrong RSA sizes/exponent, and other algorithms", () => {
    const publicDer = recipient.publicKey.export({ format: "der", type: "spki" });
    const wrongSize = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongExponent = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 3,
    });
    const otherAlgorithm = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const wrongPadding = NodeCrypto.generateKeyPairSync("rsa-pss", { modulusLength: 3072 });
    for (const key of [
      wrongSize.publicKey,
      wrongExponent.publicKey,
      otherAlgorithm.publicKey,
      wrongPadding.publicKey,
    ])
      NodeAssert.equal(admitImportEvidenceRecipient(environment(key), "linux"), null);
    for (const der of [
      Buffer.concat([publicDer, Buffer.from([0])]),
      recipient.privateKey.export({ format: "der", type: "pkcs8" }),
      recipient.publicKey.export({ format: "der", type: "pkcs1" }),
    ]) {
      const env = environment();
      env.BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI = der.toString("base64");
      env.BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256 = NodeCrypto.createHash("sha256")
        .update(der)
        .digest("hex");
      NodeAssert.equal(admitImportEvidenceRecipient(env, "linux"), null);
    }
    const base64 = publicDer.toString("base64");
    for (const value of [base64 + "\n", base64.slice(0, -1), " " + base64, base64 + "="])
      NodeAssert.equal(
        admitImportEvidenceRecipient(
          { ...environment(), BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI: value },
          "linux",
        ),
        null,
      );
  });
  it("rejects the wrong recipient and tampering with each of the five authenticated parts", () => {
    const parts = sealImportFailure(admission(), Buffer.from("test-owned import refusal"));
    const wrong = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    NodeAssert.throws(() => decrypt(parts, wrong.privateKey));
    for (const field of ["context", "ciphertext", "wrappedKey", "nonce", "tag"] as const) {
      const changed = { ...parts, [field]: Buffer.from(parts[field]) };
      changed[field][0] = (changed[field][0] ?? 0) ^ 1;
      NodeAssert.throws(() => decrypt(changed));
    }
  });
  it("accepts the exact reply cap and refuses empty or oversized replies with fixed errors", () => {
    const admitted = admission();
    for (const size of [1, 256 * 1024]) {
      const reply = Buffer.alloc(size, 73);
      NodeAssert.deepEqual(decrypt(sealImportFailure(admitted, reply)), reply);
      NodeAssert.equal(reply[0], 73);
    }
    for (const size of [0, 256 * 1024 + 1])
      NodeAssert.throws(() => sealImportFailure(admitted, Buffer.alloc(size)), {
        message: "Private import evidence omitted.",
      });
  });
});

describe("publication refusal and ownership boundaries", () => {
  it("rejects invalid envelope lengths or extra fields before creating a namespace", () => {
    const parts = sealImportFailure(admission(), Buffer.from("test-owned import refusal"));
    for (const invalid of [
      { ...parts, context: Buffer.alloc(0) },
      { ...parts, context: Buffer.alloc(4097) },
      { ...parts, ciphertext: Buffer.alloc(0) },
      { ...parts, ciphertext: Buffer.alloc(256 * 1024 + 1) },
      { ...parts, wrappedKey: Buffer.alloc(383) },
      { ...parts, wrappedKey: Buffer.alloc(385) },
      { ...parts, nonce: Buffer.alloc(11) },
      { ...parts, nonce: Buffer.alloc(13) },
      { ...parts, tag: Buffer.alloc(15) },
      { ...parts, tag: Buffer.alloc(17) },
      { ...parts, plaintext: Buffer.from("test-owned import refusal") },
    ])
      withRoot((root) => {
        NodeAssert.throws(() => publishImportFailure(root, invalid), {
          message: "Private import evidence omitted.",
        });
        NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
      });
  });
  it("refuses noncanonical, symlinked, file, and nonprivate roots", () => {
    const parts = sealImportFailure(admission(), Buffer.from("test-owned import refusal"));
    withRoot((root) => {
      for (const path of ["relative-root", root + "/.", root + "/", root + "//"])
        NodeAssert.throws(() => publishImportFailure(path, parts), {
          message: "Private import evidence omitted.",
        });
      for (const mode of [0o750, 0o755, 0o777]) {
        NodeFS.chmodSync(root, mode);
        NodeAssert.throws(() => publishImportFailure(root, parts), {
          message: "Private import evidence omitted.",
        });
      }
      NodeFS.chmodSync(root, 0o700);
      const file = NodePath.join(root, "not-directory");
      NodeFS.writeFileSync(file, "owned", { mode: 0o600 });
      NodeAssert.throws(() => publishImportFailure(file, parts), {
        message: "Private import evidence omitted.",
      });
      const link = NodePath.join(root, "alias");
      NodeFS.symlinkSync(root, link);
      NodeAssert.throws(() => publishImportFailure(link, parts), {
        message: "Private import evidence omitted.",
      });
      NodeAssert.throws(() => publishImportFailure(NodePath.join(link, "alias"), parts), {
        message: "Private import evidence omitted.",
      });
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(root, "import-private")), false);
    });
  });
  it("refuses every preexisting namespace without replacing directories, links, or files", () => {
    const parts = sealImportFailure(admission(), Buffer.from("test-owned import refusal"));
    for (const shape of ["directory", "symlink", "file"])
      withRoot((root) => {
        const owned = NodePath.join(root, "import-private");
        if (shape === "directory") {
          NodeFS.mkdirSync(owned, { mode: 0o700 });
          NodeFS.mkdirSync(NodePath.join(owned, "ready"), { mode: 0o700 });
          NodeFS.writeFileSync(NodePath.join(owned, "ready", "sentinel"), "owned", { mode: 0o600 });
        } else if (shape === "symlink") NodeFS.symlinkSync(root, owned);
        else NodeFS.writeFileSync(owned, "owned", { mode: 0o600 });
        const identity = NodeFS.lstatSync(owned);
        NodeAssert.throws(() => publishImportFailure(root, parts), {
          message: "Private import evidence omitted.",
        });
        NodeAssert.equal(NodeFS.lstatSync(owned).ino, identity.ino);
        if (shape === "directory")
          NodeAssert.equal(
            NodeFS.readFileSync(NodePath.join(owned, "ready", "sentinel"), "utf8"),
            "owned",
          );
      });
  });
  it("refuses a foreign owner and changed root identity through the actual filesystem caller", () => {
    const source = NodeFS.readFileSync(
      new URL("./ci-import-private-evidence.ts", import.meta.url),
      "utf8",
    );
    const compiled = NodeModule.stripTypeScriptTypes(source)
      .replace(/^import .*;$/gm, "")
      .replace(/^export /gm, "");
    const parts = sealImportFailure(admission(), Buffer.from("test-owned import refusal"));
    withRoot((root) => {
      const uid = NodeFS.statSync(root).uid;
      const publish = NodeVM.runInNewContext(compiled + "\npublishImportFailure", {
        NodeFS,
        NodePath,
        NodeCrypto,
        Buffer,
        process: { getuid: () => uid + 1 },
      });
      NodeAssert.throws(() => publish(root, parts));
      NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
    });
    withRoot((root) => {
      const moved = root + "-owned-original";
      let observations = 0;
      const filesystem = {
        ...NodeFS,
        lstatSync(path: string) {
          if (path === root && observations++ === 1) {
            NodeFS.renameSync(root, moved);
            NodeFS.mkdirSync(root, { mode: 0o700 });
          }
          return NodeFS.lstatSync(path);
        },
      };
      try {
        const publish = NodeVM.runInNewContext(compiled + "\npublishImportFailure", {
          NodeFS: filesystem,
          NodePath,
          NodeCrypto,
          Buffer,
          process,
        });
        NodeAssert.throws(() => publish(root, parts));
        NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
      } finally {
        NodeFS.rmSync(moved, { recursive: true, force: true });
      }
    });
  });
});

it("binds terminal ciphertext to a separate authenticated scope and private namespace", () => {
  const admitted = admitImportEvidenceRecipient(
    environment(),
    "linux",
    "browser-owned-terminal-observer-refusal",
  );
  NodeAssert.ok(admitted);
  const parts = sealImportFailure(admitted, Buffer.from("owned terminal refusal"));
  NodeAssert.equal(
    JSON.parse(parts.context.toString()).scope,
    "browser-owned-terminal-observer-refusal",
  );
  NodeAssert.equal(decrypt(parts).toString(), "owned terminal refusal");
  withRoot((root) => {
    publishImportFailure(root, parts, "terminal-private");
    NodeAssert.deepEqual(NodeFS.readdirSync(root), ["terminal-private"]);
    NodeAssert.equal(
      NodeFS.readdirSync(NodePath.join(root, "terminal-private", "ready")).length,
      5,
    );
  });
});
