import { describe, expect, it } from "vite-plus/test";
import { decodeExit, encodeRequest, identityFromConfig } from "./remote-install-driver.ts";

describe("remote install RPC driver", () => {
  it("encodes the real request envelope and reads only a matching successful exit", () => {
    expect(JSON.parse(encodeRequest("7", "updater.status"))).toEqual({
      _tag: "Request",
      id: "7",
      tag: "updater.status",
      payload: {},
      headers: [],
    });
    expect(
      decodeExit(
        { _tag: "Exit", requestId: "7", exit: { _tag: "Success", value: { state: "idle" } } },
        "7",
      ),
    ).toEqual({ state: "idle" });
    expect(
      decodeExit({ _tag: "Exit", requestId: "8", exit: { _tag: "Success", value: {} } }, "7"),
    ).toBeUndefined();
    expect(() =>
      decodeExit({ _tag: "Exit", requestId: "7", exit: { _tag: "Failure", cause: [] } }, "7"),
    ).toThrow();
  });
  it("retains boot/version/capability and supports older descriptors", () => {
    expect(
      identityFromConfig({
        environment: {
          bootId: "b1",
          serverVersion: "0.7.2",
          capabilities: { remoteUpdateProgress: true },
        },
      }),
    ).toEqual({ bootId: "b1", serverVersion: "0.7.2", progress: true });
    expect(
      identityFromConfig({ environment: { serverVersion: "0.6.0", capabilities: {} } }),
    ).toEqual({ bootId: null, serverVersion: "0.6.0", progress: false });
    expect(() => identityFromConfig({ environment: {} })).toThrow();
  });
});
