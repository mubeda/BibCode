import { it, expect } from "vite-plus/test";
import {
  admitWsl2Registration,
  admitWsl2Runtime,
  admitWsl2Image,
  joinOwnedWslCleanup,
} from "./owned-wsl2-fixture.ts";
const intent = {
  name: "BibCodeQA-0123456789abcdef0123456789abcdef",
  basePath: "inert-physical-root",
  guid: "inert-registration",
};
const before = { defaultGuid: null, distros: [] };
const registeredEntry = { ...intent, version: 2 };
const registered = { defaultGuid: intent.guid, distros: [registeredEntry] };
it("admits only one exact newly-owned version2 registration and its permissible first default", () => {
  expect(admitWsl2Registration(before, registered, intent)).toEqual(registered.distros[0]);
  for (const after of [
    { ...registered, defaultGuid: "foreign" },
    { ...registered, distros: [{ ...registeredEntry, version: 1 }] },
    { ...registered, distros: [{ ...registeredEntry, basePath: "foreign" }] },
    { ...registered, distros: [...registered.distros, ...registered.distros] },
  ])
    expect(() => admitWsl2Registration(before, after, intent)).toThrow();
  expect(() => admitWsl2Registration(registered, registered, intent)).toThrow();
});
it("requires an actual WSL2 Microsoft kernel, x86_64 and Ubuntu24.04", () => {
  expect(
    admitWsl2Runtime({
      kernel: "6.6.87.2-microsoft-standard-WSL2",
      architecture: "x86_64",
      osId: "ubuntu",
      osVersion: "24.04",
    }),
  ).toBe(true);
  for (const input of [
    { kernel: "4.4.0-Microsoft", architecture: "x86_64", osId: "ubuntu", osVersion: "24.04" },
    {
      kernel: "6.6.87.2-microsoft-standard-WSL2",
      architecture: "aarch64",
      osId: "ubuntu",
      osVersion: "24.04",
    },
    {
      kernel: "6.6.87.2-microsoft-standard-WSL2",
      architecture: "x86_64",
      osId: "debian",
      osVersion: "24.04",
    },
  ])
    expect(() => admitWsl2Runtime(input)).toThrow();
});
it("requires the full authenticated Canonical signer and exact fixed release bytes", () => {
  const valid = {
    signers: ["843938DF228D22F7B3742BC0D94AA3F0EFE21092"],
    filename: "ubuntu-24.04.5-wsl-amd64.wsl",
    signedSha256: "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e",
    actualSha256: "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e",
  };
  expect(admitWsl2Image(valid)).toBe(true);
  for (const input of [
    { ...valid, signers: [] },
    { ...valid, signers: ["D94AA3F0EFE21092"] },
    { ...valid, filename: "current.wsl" },
    { ...valid, actualSha256: "a".repeat(64) },
  ])
    expect(() => admitWsl2Image(input)).toThrow();
});
it("termination failure cannot skip exact unregister and retains first failure for every caller", async () => {
  const original = new Error("inert termination failure"),
    events: string[] = [];
  let unsafe = 0;
  const close = joinOwnedWslCleanup({
    verifyOwner: async () => {
      events.push("verify");
    },
    terminate: async () => {
      events.push("terminate");
      throw original;
    },
    unregister: async () => {
      events.push("unregister");
    },
    verifyRestored: async () => {
      events.push("restored");
    },
    deleteOwned: async () => {
      events.push("delete");
    },
    unsafe: () => {
      unsafe++;
    },
  });
  const first = close(),
    second = close();
  expect(first).toBe(second);
  await expect(first).rejects.toBe(original);
  expect(events).toEqual(["verify", "terminate", "unregister", "restored"]);
  expect(unsafe).toBe(1);
});
it("ownership refusal cannot run destructive commands; thrown undefined remains a failure", async () => {
  const events: string[] = [];
  const close = joinOwnedWslCleanup({
    verifyOwner: async () => {
      throw undefined;
    },
    terminate: async () => {
      events.push("terminate");
    },
    unregister: async () => {
      events.push("unregister");
    },
    verifyRestored: async () => {},
    deleteOwned: async () => {},
    unsafe: () => {},
  });
  let failed = false,
    error: unknown;
  try {
    await close();
  } catch (value) {
    failed = true;
    error = value;
  }
  expect(failed).toBe(true);
  expect(error).toBe(undefined);
  expect(events).toEqual([]);
});
it("native-only settings name the kernel-verified exact private distro before app launch", async () => {
  const { admitOwnedWslSeed } = await import("./owned-wsl2-fixture.ts");
  const record = {
    schema: 1,
    sourceSha: "a".repeat(40),
    name: intent.name,
    imageSha256: "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e",
    kernelVerified: true,
    phase: "kernel-verified",
    guid: intent.guid,
    appState: "none",
  };
  expect(admitOwnedWslSeed(record, "a".repeat(40)).settings).toEqual({
    wslOnly: true,
    wslBackendEnabled: true,
    wslDistro: intent.name,
    serverExposureMode: "local-only",
    tailscaleServeEnabled: false,
  });
  for (const input of [
    { ...record, kernelVerified: false },
    { ...record, name: "Ubuntu" },
    { ...record, sourceSha: "b".repeat(40) },
    { ...record, appState: "attempted" },
  ])
    expect(() => admitOwnedWslSeed(input, "a".repeat(40))).toThrow();
});
