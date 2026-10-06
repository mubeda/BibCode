// @effect-diagnostics nodeBuiltinImport:off - Exact private application process identity and graceful native window closure, without a process-name sweep.
// @effect-diagnostics globalTimers:off - Owned application closure is awaited with an absolute bound.
// @effect-diagnostics globalDate:off - One finite native process closure deadline.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeCrypto from "node:crypto";
import { NativeFollowupCommandOwner } from "./release-visual-native-followups-process.ts";
import { readNativeFollowupLinuxBinding } from "./release-visual-native-followups-owner.ts";
export async function stopNativeFollowupApplication(input: {
  app: string;
  dataRoot: string;
  runRoot: string;
  platform: string;
  environment: NodeJS.ProcessEnv;
}) {
  if (
    input.environment.CI !== "true" ||
    input.environment.GITHUB_ACTIONS !== "true" ||
    !input.environment.GITHUB_RUN_ID ||
    !input.app.startsWith(NodePath.join(input.runRoot, "installed") + NodePath.sep) ||
    NodeFS.realpathSync(input.app) !== input.app ||
    NodeFS.realpathSync(input.runRoot) !== input.runRoot
  )
    throw new Error("Native follow-up shutdown ownership refused.");
  const privateRoot = NodePath.join(
    input.runRoot,
    "native-close-" + NodeCrypto.randomBytes(12).toString("hex"),
  );
  NodeFS.mkdirSync(privateRoot, { mode: 0o700 });
  if (input.platform === "win32") {
    const owner = new NativeFollowupCommandOwner(
        input.environment,
        privateRoot,
        () => {},
        input.platform,
      ),
      executable = NodePath.join(
        input.environment.SystemRoot ?? "",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      path = input.app.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq '${path}'}); if($p.Count -gt 1){throw 'Owned native instance count refused'}; if($p.Count -eq 1){$pidOwned=$p[0].ProcessId; $born=$p[0].CreationDate.ToUniversalTime().Ticks; $same=Get-CimInstance Win32_Process -Filter "ProcessId=$pidOwned"; if($same.ExecutablePath -ine '${path}' -or $same.CreationDate.ToUniversalTime().Ticks -ne $born){throw 'Owned native process changed'}; $live=Get-Process -Id $pidOwned; if($live.MainModule.FileName -ine '${path}'){throw 'Owned native executable changed'}; if(-not $live.CloseMainWindow()){throw 'Owned native window could not close'}; if(-not $live.WaitForExit(10000)){throw 'Owned native window did not close'}; $remaining=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq '${path}'}); if($remaining.Count -ne 0){throw 'Owned native process remains'}}; @{ownedProcessesClosed=$true}|ConvertTo-Json -Compress`;
    const raw: unknown = JSON.parse(
      (
        await owner.command(executable, ["-NoProfile", "-NonInteractive", "-Command", script])
      ).toString("utf8"),
    );
    owner.assertClosed();
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).join(",") !== "ownedProcessesClosed" ||
      !("ownedProcessesClosed" in raw) ||
      raw.ownedProcessesClosed !== true
    )
      throw new Error("Native follow-up Windows closure refused.");
    return { ownedProcessesClosed: true, processCount: 0 };
  }
  if (input.platform !== "linux") throw new Error("Native follow-up shutdown platform refused.");
  const binding = readNativeFollowupLinuxBinding(input.app, input.dataRoot, true);
  const stop = (pid: number, alive: () => boolean) => {
    if (!alive()) return;
    try {
      NodeProcess.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (binding) {
    binding.verify();
    if (binding.nativePid !== null) stop(binding.nativePid, binding.nativeAlive);
    stop(binding.runtimePid, binding.runtimeAlive);
  }
  const deadline = Date.now() + 10000;
  if (binding) {
    while (binding.nativeAlive() || binding.runtimeAlive()) {
      if (Date.now() >= deadline)
        throw new Error("Native follow-up exact process closure unavailable.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (readNativeFollowupLinuxBinding(input.app, input.dataRoot, true) !== null)
    throw new Error("Native follow-up replacement process remains.");
  NodeFS.writeFileSync(
    NodePath.join(privateRoot, "cleanup.json"),
    JSON.stringify({
      ownedProcessesClosed: true,
      processCount: binding ? (binding.nativePid === null ? 1 : 2) : 0,
    }),
    { mode: 0o600 },
  );
  return {
    ownedProcessesClosed: true,
    processCount: binding ? (binding.nativePid === null ? 1 : 2) : 0,
  };
}
