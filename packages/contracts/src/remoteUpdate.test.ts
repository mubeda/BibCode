import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  REMOTE_UPDATE_MANUAL_REQUIRED,
  RemoteUpdateInstallError,
  RemoteUpdateSnapshot,
  RemoteUpdateSupport,
} from "./remoteUpdate.ts";

const decodeSnapshot = Schema.decodeUnknownSync(RemoteUpdateSnapshot);
const decodeSupport = Schema.decodeUnknownSync(RemoteUpdateSupport);
const decodeInstallError = Schema.decodeUnknownSync(RemoteUpdateInstallError);

describe("RemoteUpdateSnapshot", () => {
  it("decodes the desktop-hosted interactive shape", () => {
    const snapshot = decodeSnapshot({
      serverVersion: "0.4.2",
      latestVersion: "0.5.0",
      state: "update-available",
      error: null,
      support: { installMode: "interactive", reason: "available" },
    });
    expect(snapshot.latestVersion).toBe("0.5.0");
    expect(snapshot.support.installMode).toBe("interactive");
  });

  it("decodes the headless manual shape with a null latest version", () => {
    const snapshot = decodeSnapshot({
      serverVersion: "0.4.2",
      latestVersion: null,
      state: "idle",
      error: null,
      support: { installMode: "manual", reason: "manual-update-required" },
    });
    expect(snapshot.latestVersion).toBeNull();
    expect(snapshot.state).toBe("idle");
  });

  it("keeps the schema-reserved supervised mode decodable", () => {
    const support = decodeSupport({ installMode: "supervised", reason: "available" });
    expect(support.installMode).toBe("supervised");
  });

  it("preserves an empty desktop updater error string", () => {
    expect(
      decodeSnapshot({
        serverVersion: "0.4.2",
        latestVersion: null,
        state: "error",
        error: "",
        support: { installMode: "interactive", reason: "available" },
      }).error,
    ).toBe("");
  });

  it("rejects unknown states", () => {
    expect(() =>
      decodeSnapshot({
        serverVersion: "0.4.2",
        latestVersion: null,
        state: "rebooting",
        error: null,
        support: { installMode: "manual", reason: "manual-update-required" },
      }),
    ).toThrow();
  });
});

describe("RemoteUpdateInstallError", () => {
  it("decodes the exact Rust manual-required wire shape", () => {
    const error = decodeInstallError({
      _tag: "RemoteUpdateInstallError",
      code: "remote_update_manual_required",
    });
    expect(error.code).toBe(REMOTE_UPDATE_MANUAL_REQUIRED);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
