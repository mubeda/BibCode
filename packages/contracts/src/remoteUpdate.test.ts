import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  REMOTE_UPDATE_MANUAL_REQUIRED,
  RemoteUpdateActiveWork,
  RemoteUpdateActiveWorkError,
  RemoteUpdateInstallError,
  RemoteUpdateSnapshot,
  RemoteUpdateSupport,
} from "./remoteUpdate.ts";
import { WsUpdaterActiveWorkRpc } from "./rpc.ts";

const decodeSnapshot = Schema.decodeUnknownSync(RemoteUpdateSnapshot);
const decodeSupport = Schema.decodeUnknownSync(RemoteUpdateSupport);
const decodeInstallError = Schema.decodeUnknownSync(RemoteUpdateInstallError);
const decodeActiveWork = Schema.decodeUnknownSync(RemoteUpdateActiveWork);
const decodeActiveWorkError = Schema.decodeUnknownSync(RemoteUpdateActiveWorkError);
const decodeActiveWorkRpcError = Schema.decodeUnknownSync(WsUpdaterActiveWorkRpc.errorSchema);

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

describe("RemoteUpdateActiveWorkError", () => {
  it("decodes the Rust count failure as a declared method error", () => {
    const wireError = {
      _tag: "RemoteUpdateActiveWorkError",
      message: "Could not count running work.",
    };
    const error = decodeActiveWorkError(wireError);
    expect(error._tag).toBe("RemoteUpdateActiveWorkError");
    expect(error.message).toBe("Could not count running work.");
    expect(decodeActiveWorkRpcError(wireError)).toEqual(error);
  });
});

describe("RemoteUpdateActiveWork", () => {
  it("decodes counts including an idle server", () => {
    expect(decodeActiveWork({ runningTurns: 2, liveTerminals: 3, queuedMessages: 1 })).toEqual({
      runningTurns: 2,
      liveTerminals: 3,
      queuedMessages: 1,
    });
    expect(decodeActiveWork({ runningTurns: 0, liveTerminals: 0, queuedMessages: 0 })).toEqual({
      runningTurns: 0,
      liveTerminals: 0,
      queuedMessages: 0,
    });
  });

  it.each(["runningTurns", "liveTerminals", "queuedMessages"])(
    "rejects negative and fractional %s counts",
    (field) => {
      for (const value of [-1, 0.5]) {
        expect(() =>
          decodeActiveWork({
            runningTurns: 0,
            liveTerminals: 0,
            queuedMessages: 0,
            [field]: value,
          }),
        ).toThrow();
      }
    },
  );
});
