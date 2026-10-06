import { afterEach, expect, it, vi } from "vite-plus/test";
import { closeNativeSharingSession, verifyNativeSharingWindow } from "../qualify-native-sharing.ts";
import { withNativeSharingApplication } from "./release-visual-native-sharing-application.ts";
afterEach(() => vi.unstubAllGlobals());
function fixture(mode = "owned") {
  const calls: string[] = [],
    prepareError = new Error("Inert native prepare failure."),
    deleteError = new Error("Inert session delete failure.");
  let deleted = false;
  vi.stubGlobal(
    "window",
    mode === "missing-bridge"
      ? {}
      : {
          __TAURI__: {
            core: {
              invoke: async (command: string) => {
                calls.push(command);
                if (mode === "prepare-failure" || mode === "both-fail") throw prepareError;
              },
            },
          },
        },
  );
  const browser = {
    execute: async (read: () => Promise<unknown>) => read(),
    deleteSession: async () => {
      calls.push("deleteSession");
      deleted = true;
      if (mode === "delete-failure" || mode === "both-fail") throw deleteError;
    },
  };
  return { browser, calls, prepareError, deleteError, deleted: () => deleted };
}
it("joins the real native preparation callback before deleting the still-live driver session", async () => {
  const f = fixture();
  await closeNativeSharingSession(f.browser as never);
  expect(f.calls).toEqual(["desktop_e2e_prepare_for_exit", "deleteSession"]);
});
it.each(["prepare-failure", "delete-failure", "both-fail", "missing-bridge"])(
  "still joins session deletion and refuses unsafe native cleanup: %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(closeNativeSharingSession(f.browser as never)).rejects.toThrow();
    expect(f.deleted()).toBe(true);
    if (mode === "prepare-failure" || mode === "both-fail")
      await expect(closeNativeSharingSession(f.browser as never)).rejects.toBe(f.prepareError);
  },
);
it("prepares the backend on a connected visual failure while preserving that original failure", async () => {
  const f = fixture(),
    original = new Error("Inert visual failure.");
  let stopped = false;
  await expect(
    withNativeSharingApplication(
      {
        guard: async () => {},
        start: async () => {},
        connect: async () => f.browser,
        disconnect: (browser) => closeNativeSharingSession(browser as never),
        stop: async () => {
          stopped = true;
        },
        unsafeCleanup: () => {},
      },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(f.calls).toEqual(["desktop_e2e_prepare_for_exit", "deleteSession"]);
  expect(stopped).toBe(true);
});
it.each(["extra", "current", "duplicate", "missing"])(
  "refuses changed native window identity at a later capture check: %s",
  async (mode) => {
    let changed = false;
    const browser = {
      getWindowHandles: async () =>
        changed
          ? mode === "extra"
            ? ["main", "preview"]
            : mode === "duplicate"
              ? ["main", "main"]
              : mode === "missing"
                ? []
                : ["main"]
          : ["main"],
      getWindowHandle: async () => (changed && mode === "current" ? "preview" : "main"),
    };
    await verifyNativeSharingWindow(browser);
    changed = true;
    await expect(verifyNativeSharingWindow(browser)).rejects.toThrow();
  },
);
