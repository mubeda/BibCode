import { expect, it } from "vite-plus/test";
import { withNativeSharingApplication } from "./release-visual-native-sharing-application.ts";
function fixture(mode = "owned") {
  const original = new Error("Inert original native failure.");
  const calls: string[] = [];
  let live = false,
    connected = false;
  const browser = {};
  return {
    original,
    calls,
    live: () => live,
    connected: () => connected,
    browser,
    ports: {
      guard: async () => {
        calls.push("guard");
        if (mode === "guard") throw original;
      },
      start: async () => {
        live = true;
        calls.push("start");
        if (mode === "start") throw original;
      },
      connect: async () => {
        calls.push("connect");
        if (mode === "connect") throw original;
        connected = true;
        return browser;
      },
      disconnect: async (value: object) => {
        expect(value).toBe(browser);
        connected = false;
        calls.push("disconnect");
        if (mode === "cleanup" || mode === "run-and-cleanup")
          throw new Error("Inert disconnect failure.");
      },
      stop: async () => {
        live = false;
        calls.push("stop");
      },
      unsafeCleanup: () => {
        calls.push("unsafe");
      },
    },
    run: async (value: object) => {
      expect(value).toBe(browser);
      expect(live).toBe(true);
      expect(connected).toBe(true);
      calls.push("run");
      if (mode === "run" || mode === "run-and-cleanup") throw original;
      return "owned-result";
    },
  };
}
it("owns one native app/session, guards it before public UI work and joins both on completion", async () => {
  const f = fixture();
  await expect(withNativeSharingApplication(f.ports, f.run)).resolves.toBe("owned-result");
  expect(f.live()).toBe(false);
  expect(f.connected()).toBe(false);
  expect(f.calls).toEqual([
    "guard",
    "start",
    "guard",
    "connect",
    "guard",
    "run",
    "guard",
    "disconnect",
    "stop",
    "guard",
  ]);
});
it.each(["guard", "start", "connect", "run", "run-and-cleanup"])(
  "keeps the original failure while joining only its own admitted resources: %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(withNativeSharingApplication(f.ports, f.run)).rejects.toBe(f.original);
    expect(f.live()).toBe(false);
    expect(f.connected()).toBe(false);
    if (mode === "guard") expect(f.calls).toEqual(["guard"]);
    else expect(f.calls).toContain("stop");
    if (mode === "connect") expect(f.calls).not.toContain("disconnect");
    if (mode === "run-and-cleanup") expect(f.calls).toContain("unsafe");
  },
);
it("refuses success if session cleanup failed, even when the app has been reaped", async () => {
  const f = fixture("cleanup");
  await expect(withNativeSharingApplication(f.ports, f.run)).rejects.toThrow();
  expect(f.live()).toBe(false);
  expect(f.calls).toContain("unsafe");
});
