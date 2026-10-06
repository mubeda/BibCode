// @effect-diagnostics nodeBuiltinImport:off - Read-only fake generation checksum checks in a temporary directory; no database/server runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { pinNativeFollowupBackup } from "./release-visual-native-followups-backup.ts";
it("binds a server-reported backup to its exact private generation and rejects byte or ancestor replacement", () => {
  const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-backup-test-")),
    ),
    storage = "12345678-1234-1234-1234-123456789abc",
    backup = "22345678-1234-1234-1234-123456789abc";
  try {
    let parent = root;
    for (const segment of ["backups", "userdata", storage, backup]) {
      parent = NodePath.join(parent, segment);
      NodeFS.mkdirSync(parent, { mode: 0o700 });
    }
    const bytes = Buffer.from("unit fixture, not a real native database");
    NodeFS.writeFileSync(NodePath.join(parent, "state.sqlite"), bytes, { mode: 0o600 });
    NodeFS.writeFileSync(
      NodePath.join(parent, "manifest.json"),
      JSON.stringify({
        backupId: backup,
        storageInstanceId: storage,
        stateKind: "userdata",
        trigger: "pre-update",
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        databaseSizeBytes: bytes.length,
      }),
      { mode: 0o600 },
    );
    const pin = pinNativeFollowupBackup({ root, storage, backup });
    expect(() => pin.verify()).not.toThrow();
    NodeFS.writeFileSync(NodePath.join(parent, "state.sqlite"), "changed");
    expect(() => pin.verify()).toThrow();
    expect(() => pinNativeFollowupBackup({ root, storage, backup: "../../escape" })).toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["alias", "replacement", "permissions"])(
  "re-admits physical backup ancestors on verification after %s drift",
  (fault) => {
    const fixture = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-backup-chain-")),
    );
    const root = NodePath.join(fixture, "data"),
      storage = "12345678-1234-1234-1234-123456789abc",
      backup = "22345678-1234-1234-1234-123456789abc";
    try {
      NodeFS.mkdirSync(root, { mode: 0o700 });
      let directory = root;
      for (const segment of ["backups", "userdata", storage, backup]) {
        directory = NodePath.join(directory, segment);
        NodeFS.mkdirSync(directory, { mode: 0o700 });
      }
      const bytes = Buffer.from("inert retained generation");
      NodeFS.writeFileSync(NodePath.join(directory, "state.sqlite"), bytes, { mode: 0o600 });
      NodeFS.writeFileSync(
        NodePath.join(directory, "manifest.json"),
        JSON.stringify({
          backupId: backup,
          storageInstanceId: storage,
          stateKind: "userdata",
          trigger: "pre-update",
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          databaseSizeBytes: bytes.length,
        }),
        { mode: 0o600 },
      );
      const pin = pinNativeFollowupBackup({ root, storage, backup });
      expect(() => pin.verify()).not.toThrow();
      if (fault === "permissions") NodeFS.chmodSync(NodePath.join(root, "backups"), 0o755);
      else {
        const moved = NodePath.join(fixture, "relocated");
        NodeFS.renameSync(directory, moved);
        if (fault === "alias") NodeFS.symlinkSync(moved, directory);
        else {
          NodeFS.mkdirSync(directory, { mode: 0o700 });
          for (const name of ["state.sqlite", "manifest.json"])
            NodeFS.renameSync(NodePath.join(moved, name), NodePath.join(directory, name));
        }
      }
      expect(() => pin.verify()).toThrow();
    } finally {
      NodeFS.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
