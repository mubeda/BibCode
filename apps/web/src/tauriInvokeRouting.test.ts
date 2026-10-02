import { describe, expect, it, vi } from "vite-plus/test";

import { invokeTauriCommand } from "./tauriInvokeRouting";

describe("invokeTauriCommand", () => {
  it.each(["global", "imported", "mock"] as const)(
    "preserves raw download bytes and header options through the %s route",
    async (route) => {
      const bytes = new Uint8Array([0, 1, 255]);
      const options = { headers: { "x-bibcode-download-handle": "owned-handle" } };
      const importedInvoke = vi.fn(async (..._args: unknown[]) => "imported");
      const globalInvoke = vi.fn(async (..._args: unknown[]) => "global");
      const e2eMock = vi.fn((..._args: unknown[]) => "mock");
      await invokeTauriCommand({
        command: "desktop_bridge_append_download_file",
        args: bytes,
        options,
        importedInvoke,
        ...(route === "global" ? { globalInvoke } : {}),
        ...(route === "mock" ? { e2eMock } : {}),
      });
      if (route === "mock") {
        expect(e2eMock).toHaveBeenCalledExactlyOnceWith(bytes, options);
        expect(globalInvoke).not.toHaveBeenCalled();
        expect(importedInvoke).not.toHaveBeenCalled();
      } else {
        const used = route === "global" ? globalInvoke : importedInvoke;
        expect(used).toHaveBeenCalledExactlyOnceWith(
          "desktop_bridge_append_download_file",
          bytes,
          options,
        );
        expect(used.mock.calls[0]?.[1]).toBe(bytes);
      }
    },
  );
  it("routes an E2E command through its registered mock before native Tauri", async () => {
    const args = { options: { title: "Select Folder" } };
    const e2eMock = vi.fn(() => "/tmp/bibcode-ui-project");
    const globalInvoke = vi.fn(async () => "global");
    const importedInvoke = vi.fn(async () => "imported");

    await expect(
      invokeTauriCommand<string>({
        command: "desktop_bridge_pick_folder",
        args,
        e2eMock,
        globalInvoke,
        importedInvoke,
      }),
    ).resolves.toBe("/tmp/bibcode-ui-project");

    expect(e2eMock).toHaveBeenCalledExactlyOnceWith(args);
    expect(globalInvoke).not.toHaveBeenCalled();
    expect(importedInvoke).not.toHaveBeenCalled();
  });

  it("uses the global Tauri invoke when no E2E mock is registered", async () => {
    const globalInvoke = vi.fn(async () => "global");
    const importedInvoke = vi.fn(async () => "imported");

    await expect(
      invokeTauriCommand<string>({
        command: "desktop_bridge_get_client_settings",
        globalInvoke,
        importedInvoke,
      }),
    ).resolves.toBe("global");

    expect(globalInvoke).toHaveBeenCalledExactlyOnceWith(
      "desktop_bridge_get_client_settings",
      undefined,
    );
    expect(importedInvoke).not.toHaveBeenCalled();
  });

  it("falls back to the imported Tauri API when the global API is unavailable", async () => {
    const importedInvoke = vi.fn(async () => "imported");

    await expect(
      invokeTauriCommand<string>({
        command: "desktop_bridge_get_client_settings",
        importedInvoke,
      }),
    ).resolves.toBe("imported");

    expect(importedInvoke).toHaveBeenCalledExactlyOnceWith(
      "desktop_bridge_get_client_settings",
      undefined,
    );
  });
});
