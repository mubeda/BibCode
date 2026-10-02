// @effect-diagnostics nodeBuiltinImport:off - Inert tests evaluate the generated browser callback only.
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

import { createSeededUpgradeDriverSpec } from "../seeded-desktop-upgrade-smoke.ts";

function makeInstallationFixture() {
  const input = {
    candidateVersion: "0.7.3",
    expectedDataRoot: NodePath.resolve("fixture-data"),
    lane: "protected-baseline" as const,
    phase: "seed-and-install" as const,
    projectId: "fixture-project",
    resultPath: NodePath.resolve("fixture-result.json"),
    workspaceRoot: NodePath.resolve("fixture-workspace"),
    platform: "win" as const,
    appBinaryPath: NodePath.resolve("fixture-app.exe"),
  };
  const script = createSeededUpgradeDriverSpec(input);
  const start = script.indexOf("    const installation = await browser.executeAsync(");
  const end = script.indexOf("\n    if (installation.error)", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const timers: Array<{ run: () => void; delay: number }> = [];
  let observeAdmission!: () => void;
  const admission = new Promise<void>((resolve) => {
    observeAdmission = resolve;
  });
  const install = vi.fn(async () => {
    observeAdmission();
    return { completed: true };
  });
  const context = {
    input,
    window: { desktopBridge: { onUpdateState: async () => () => {}, installUpdate: install } },
    browser: {
      executeAsync: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
        new Promise((resolve) => callback(...args, resolve)),
    },
    setTimeout: (run: () => void, delay: number) => {
      timers.push({ run, delay });
      if (delay === 0) observeAdmission();
      return timers.length;
    },
  };
  const running = NodeVM.runInNewContext(
    `(async () => { ${script.slice(start, end)}; return installation; })()`,
    context,
    { timeout: 1000 },
  ) as Promise<{ error: string | null }>;
  return { admission, running, install, timers };
}

it("dispatches the native install from a fresh browser task after listener setup", async () => {
  const { admission, running, install, timers } = makeInstallationFixture();
  await admission;
  expect(install).not.toHaveBeenCalled();
  expect(timers.filter((timer) => timer.delay === 0)).toHaveLength(1);
  timers.find((timer) => timer.delay === 0)!.run();
  expect(await running).toMatchObject({ error: null });
  expect(install).toHaveBeenCalledOnce();
  expect(timers.some((timer) => timer.delay === 30_000)).toBe(true);
});

it("does not dispatch a queued installation after its observation deadline settled", async () => {
  const { admission, running, install, timers } = makeInstallationFixture();
  await admission;
  timers.find((timer) => timer.delay === 30_000)!.run();
  expect(await running).toMatchObject({ error: "timed out observing updater installation" });
  timers.find((timer) => timer.delay === 0)!.run();
  await Promise.resolve();
  await Promise.resolve();
  expect(install).not.toHaveBeenCalled();
});
