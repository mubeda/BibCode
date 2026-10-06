// @effect-diagnostics nodeBuiltinImport:off - The existing seeded CI owner supplies an isolated signed package, data root and driver session.
// @effect-diagnostics globalFetch:off - Only the actual native primary's admitted loopback descriptor is read.
// @effect-diagnostics globalTimers:off - Joined qualification polling has an absolute bound.
// @effect-diagnostics globalDate:off - Actual native operation deadlines are bounded.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { QualificationBrowser } from "./support/qualification-owner.ts";
import { bounded } from "./support/qualification-owner.ts";
import { NativeFollowupCommandOwner } from "./support/release-visual-native-followups-process.ts";
import {
  createNativeFollowupLinuxOs,
  withNativeFollowupOsTheme,
  captureNativeFollowupWindowsOriginal,
  withNativeFollowupWindowsDisplay,
} from "./support/release-visual-native-followups-os.ts";
import {
  withNativeFollowupInstallFailure,
  createNativeFollowupPortHold,
  type NativeFollowupPortHold,
} from "./support/release-visual-native-followups-update.ts";
import {
  freezeNativeFollowupSource,
  pinNativeFollowupOwnedRoot,
  readNativeFollowupProcess,
} from "./support/release-visual-native-followups-owner.ts";
import {
  readNativeFollowupBridge,
  validateNativeFollowupState,
  type NativeFollowupIdentityPin,
  type NativeFollowupState,
} from "./support/release-visual-native-followups-state.ts";
import { readNativeFollowupDom } from "./support/release-visual-native-followups-dom.ts";
import {
  selectNativeFollowupTheme,
  nativeFollowupPublicClick,
  openNativeFollowupUpdate,
  prepareNativeFollowupDownload,
} from "./support/release-visual-native-followups-public.ts";
import { captureNativeFollowupOriginal } from "./support/release-visual-native-followups-capture.ts";
import { prepareNativeFollowupSupportedPreview } from "./support/release-visual-native-followups-preview.ts";
import { pinNativeFollowupBackup } from "./support/release-visual-native-followups-backup.ts";
import { admitNativeFollowupEndpoint } from "./support/release-visual-native-followups-endpoint.ts";
import {
  projectNativeFollowupResult,
  type NativeFollowupOriginal,
  type NativeFollowupScene,
  type NativeFollowupTheme,
} from "./support/release-visual-native-followups.ts";

export interface SeededNativeFollowupsInput {
  readonly platform: "linux" | "win";
  readonly repositoryRoot: string;
  readonly sourceSha: string;
  readonly appBinaryPath: string;
  readonly dataRoot: string;
  readonly runRoot: string;
  readonly evidenceDirectory: string;
  readonly candidateVersion: string;
  readonly projectId: string;
  readonly wsl: boolean;
  readonly ownedWslDistro?: string;
}
export interface NativeFollowupRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly uid: number | null;
}
const sha = (bytes: string | Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
async function until(check: () => Promise<boolean>, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await bounded(check(), 15000)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native follow-up required observation unavailable.");
}
/** Opt-in hook for the existing ephemeral-signed, protected seeded package. Never launch it locally. */
export async function runSeededNativeFollowups(
  browser: QualificationBrowser,
  input: SeededNativeFollowupsInput,
  runtime: NativeFollowupRuntime,
) {
  if (
    runtime.environment.CI !== "true" ||
    runtime.environment.GITHUB_ACTIONS !== "true" ||
    !runtime.environment.GITHUB_RUN_ID ||
    (input.platform === "linux"
      ? runtime.platform !== "linux" || runtime.uid === null || runtime.uid === 0 || input.wsl
      : runtime.platform !== "win32" || !input.wsl) ||
    !/^[a-f0-9]{40}$/.test(input.sourceSha)
  )
    throw new Error("Native follow-up actual CI host refused.");
  const root = pinNativeFollowupOwnedRoot(input.dataRoot, input.runRoot, runtime.platform),
    source = freezeNativeFollowupSource(input.repositoryRoot, input.sourceSha),
    captures: NativeFollowupOriginal[] = [],
    captured = new Set<string>();
  const output = NodePath.join(input.evidenceDirectory, "native-followups");
  NodeFS.mkdirSync(output, { mode: 0o700 });
  const write = (name: string, value: object) =>
    NodeFS.writeFileSync(NodePath.join(output, name + ".json"), JSON.stringify(value), {
      mode: 0o600,
    });
  let unsafe = false,
    failed = false,
    originalError: unknown,
    phase = "admission",
    appMode: number | null = null;
  const markUnsafe = () => {
      unsafe = true;
    },
    commands = new NativeFollowupCommandOwner(
      runtime.environment,
      output,
      markUnsafe,
      runtime.platform,
    );
  const powershell =
    runtime.platform === "win32"
      ? NodePath.join(
          runtime.environment.SystemRoot ?? "",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : null;
  const originalUrl = await browser.getUrl(),
    originalSize = await browser.getWindowSize(),
    originalPosition = await browser.getWindowRect();
  let windowPinned = false;
  let nativeViewport: { width: number; height: number; scale: number } | null = null;
  const assertions: Readonly<Record<string, unknown>>[] = [];
  const retainedBackups: ReturnType<typeof pinNativeFollowupBackup>[] = [];
  let priorPreference: "System" | "Light" | "Dark" | null = null,
    pin: NativeFollowupIdentityPin | null = null,
    processPin = "",
    storageDraft = "",
    holder: NativeFollowupPortHold | null = null;
  const holdCancellation = new AbortController();
  let pendingHold: Promise<NativeFollowupPortHold> | null = null;
  let wslHosts: readonly string[] = [];
  const app = NodeFS.lstatSync(input.appBinaryPath),
    appSha = sha(NodeFS.readFileSync(input.appBinaryPath));
  if (
    NodeFS.realpathSync(input.appBinaryPath) !== input.appBinaryPath ||
    !app.isFile() ||
    app.isSymbolicLink() ||
    !input.appBinaryPath.startsWith(NodePath.join(input.runRoot, "installed") + NodePath.sep)
  )
    throw new Error("Native follow-up packaged input refused.");
  const url = new URL(originalUrl),
    origin =
      url.protocol === "tauri:" && url.hostname === "localhost"
        ? "tauri://localhost"
        : url.protocol === "http:" && url.hostname === "tauri.localhost"
          ? "http://tauri.localhost"
          : null;
  if (!origin || url.username || url.password || url.search)
    throw new Error("Native follow-up main document refused.");
  const read = async (): Promise<NativeFollowupState> => {
    const bridge = await browser.execute(readNativeFollowupBridge),
      boot = bridge.bootstraps.find((entry) => entry.id === "primary");
    let descriptor: NativeFollowupState["descriptor"] = null;
    if (
      runtime.platform === "win32" &&
      (!input.ownedWslDistro || boot?.runningDistro !== input.ownedWslDistro)
    )
      throw new Error("Native follow-up exact owned WSL distro refused.");
    if (boot?.httpBaseUrl) {
      if (runtime.platform === "win32" && boot.runningDistro) {
        const executable = NodePath.join(
          runtime.environment.SystemRoot ?? "",
          "System32",
          "wsl.exe",
        );
        wslHosts = (
          await commands.command(executable, [
            "--distribution",
            boot.runningDistro,
            "--exec",
            "hostname",
            "-I",
          ])
        )
          .toString("utf8")
          .trim()
          .split(/\s+/);
      }
      const endpoint = admitNativeFollowupEndpoint(
        boot.httpBaseUrl,
        runtime.platform,
        boot.runningDistro ?? null,
        wslHosts,
      );
      const response = await fetch(endpoint.origin + "/.well-known/bibcode/environment", {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("Native follow-up owned descriptor unavailable.");
      descriptor = await response.json();
    }
    return { ...bridge, descriptor };
  };
  const process = () =>
    readNativeFollowupProcess({
      platform: runtime.platform,
      app: input.appBinaryPath,
      dataRoot: input.dataRoot,
      commands,
      powershell,
    });
  const verifyOwner = async () => {
    source.verify();
    root.verify();
    const handles = await browser.getWindowHandles(),
      stat = NodeFS.lstatSync(input.appBinaryPath);
    if (
      JSON.stringify(handles) !== JSON.stringify(["main"]) ||
      (await browser.getWindowHandle()) !== "main" ||
      stat.dev !== app.dev ||
      stat.ino !== app.ino ||
      sha(NodeFS.readFileSync(input.appBinaryPath)) !== appSha ||
      (await process()) !== processPin
    )
      throw new Error("Native follow-up source/window/process/input changed.");
    if (windowPinned) {
      const size = await browser.getWindowSize(),
        position = await browser.getWindowRect(),
        viewport = await browser.execute(() => ({
          width: innerWidth,
          height: innerHeight,
          scale: devicePixelRatio,
        }));
      if (
        size.width !== 1280 ||
        size.height !== 960 ||
        position.x !== 0 ||
        position.y !== 0 ||
        viewport.width !== nativeViewport?.width ||
        viewport.height !== nativeViewport?.height ||
        viewport.scale !== 1
      )
        throw new Error("Native follow-up native window geometry changed.");
    }
  };
  const draft = "Native update preserved draft";
  const readDraft = () =>
    browser.execute((draft) => {
      const raw = localStorage.getItem("bibcode:composer-drafts:v1");
      if (!raw || raw.length > 1024 * 1024) return null;
      const value = JSON.parse(raw);
      const rows = Object.values(value?.state?.draftsByThreadKey ?? {}) as { prompt?: string }[];
      return value?.version === 8 && rows.filter((row) => row.prompt === draft).length === 1
        ? raw
        : null;
    }, draft);
  const stage = (value: string) => {
    phase = value;
    write("phase", { phase, originalCount: captures.length });
  };
  const capture = async (
    scene: NativeFollowupScene,
    theme: NativeFollowupTheme,
    original: () => Promise<Buffer>,
    extra: () => Promise<Record<string, true>>,
  ) => {
    if (!pin) throw new Error("Native follow-up identity not pinned.");
    const expected = pin;
    stage(scene + "-" + theme);
    const witness = async () => {
      const state = validateNativeFollowupState(scene, await read(), expected),
        dom = await browser.execute(readNativeFollowupDom, {
          scene,
          theme,
          privateRoots: [input.runRoot, input.dataRoot, input.repositoryRoot],
          draft,
          distro: expected.runningDistro,
        });
      const retained = storageDraft.length > 0 && (await readDraft()) === storageDraft;
      return {
        nativeHost: state.nativeHost,
        sourceMatched: true,
        inputMatched: true,
        mainWindowMatched: true,
        storeMatched: state.storeMatched,
        versionMatched: state.versionMatched,
        processOwnerMatched: true,
        ...dom,
        workPreserved: retained,
        ...state,
        ...(await extra()),
        ...(scene === "native-update-recovery" ? { draftRetained: retained } : {}),
      };
    };
    const receipt = await captureNativeFollowupOriginal({
      scene,
      theme,
      evidence: output,
      captures: captured,
      verify: verifyOwner,
      readWitness: witness,
      original,
      platform: runtime.platform,
      onJoin: (join) => {
        assertions.push({
          ...join,
          sourceSha: source.sourceSha,
          appSha256: appSha,
          physicalRootSha256: root.sha256,
          processIdentitySha256: processPin,
          storageIdentitySha256: sha(expected.storageInstanceId),
          bootIdentitySha256: sha(expected.bootId),
          endpointSha256: sha(expected.endpoint),
          versionSha256: sha(expected.version),
          nativeViewport,
        });
        write("assertions", { schemaVersion: 1, assertions });
      },
    });
    captures.push(receipt);
    write("originals", { schemaVersion: 1, originals: captures });
  };
  try {
    if (runtime.platform === "linux") {
      appMode = app.mode & 0o777;
      NodeFS.chmodSync(input.appBinaryPath, appMode & 0o555);
    }
    processPin = await process();
    await verifyOwner();
    await browser.setWindowSize(1280, 960);
    await browser.setWindowRect(0, 0, 1280, 960);
    if (runtime.platform === "linux") {
      await browser.fullscreenWindow();
      nativeViewport = await browser.execute(() => ({
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio,
      }));
      if (
        nativeViewport.width !== 1280 ||
        nativeViewport.height < 900 ||
        nativeViewport.height > 960 ||
        nativeViewport.scale !== 1
      )
        throw new Error("Native follow-up actual client geometry unavailable.");
      windowPinned = true;
    }
    await browser.url(origin + "/#/settings/general");
    const preference = browser.$('[aria-label="Theme preference"]');
    await preference.waitForDisplayed();
    const label = (await preference.getText()).trim();
    if (!["System", "Light", "Dark"].includes(label))
      throw new Error("Native follow-up original theme unavailable.");
    priorPreference = label as "System" | "Light" | "Dark";
    const first = await read(),
      primary = first.data.find((entry) => entry.environmentId === "primary"),
      boot = first.bootstraps.find((entry) => entry.id === "primary");
    if (
      !first.descriptor ||
      !primary ||
      !boot?.httpBaseUrl ||
      !first.descriptor.bootId ||
      !first.descriptor.storageInstanceId
    )
      throw new Error("Native follow-up initial native identity unavailable.");
    pin = {
      platform: runtime.platform as NativeFollowupIdentityPin["platform"],
      endpoint: boot.httpBaseUrl,
      port: Number(new URL(boot.httpBaseUrl).port),
      bootId: first.descriptor.bootId,
      storageInstanceId: first.descriptor.storageInstanceId,
      version: first.update.currentVersion,
      requestedRoot: primary.requestedRoot,
      effectiveRoot: primary.effectiveRoot,
      updateVersion: input.candidateVersion,
      runningDistro: primary.runningDistro,
      wslHosts,
    };
    if (
      runtime.platform === "linux" &&
      (primary.requestedRoot !== input.dataRoot || primary.effectiveRoot !== input.dataRoot)
    )
      throw new Error("Native follow-up user store refused.");
    const card = '[data-testid="primary-card-button-' + input.projectId + '"]';
    await browser.url(origin + "/#/");
    await nativeFollowupPublicClick(browser, card);
    const threadUrl = await browser.getUrl(),
      composer = browser.$('[data-testid="composer-editor"]');
    await composer.waitForDisplayed();
    await composer.setValue(draft);
    await until(async () => (storageDraft = (await readDraft()) ?? "").length > 0, 10000);
    if (runtime.platform === "linux") {
      const os = createNativeFollowupLinuxOs(commands, runtime.platform, markUnsafe);
      for (const theme of ["light", "dark"] as const)
        await withNativeFollowupOsTheme(os, theme, async () => {
          await selectNativeFollowupTheme(browser, "System", origin);
          await browser.url(threadUrl);
          await until(async () =>
            browser.execute(
              (theme) => document.documentElement.classList.contains("dark") === (theme === "dark"),
              theme,
            ),
          );
          await browser.$(card).click({ button: "right" });
          try {
            await capture("native-menu-theme", theme, os.capture, async () => ({
              ...(await os.menu()),
              osThemeMatched: (await os.verify(theme), true),
            }));
          } finally {
            await commands.command("/usr/bin/xdotool", ["key", "--clearmodifiers", "Escape"]);
          }
        });
      await prepareNativeFollowupDownload(browser, origin, input.candidateVersion, until);
      for (const theme of ["light", "dark"] as const) {
        await selectNativeFollowupTheme(browser, theme === "light" ? "Light" : "Dark", origin);
        await openNativeFollowupUpdate(browser, origin);
        await capture("native-update-protection", theme, os.capture, async () => ({}));
        await nativeFollowupPublicClick(
          browser,
          '//*[@role="dialog"]//button[normalize-space()="Cancel"]',
        );
      }
      await selectNativeFollowupTheme(browser, "Light", origin);
      await openNativeFollowupUpdate(browser, origin);
      stage("native-recovery-install-failure");
      await withNativeFollowupInstallFailure(
        {
          laneRoot: input.runRoot,
          app: input.appBinaryPath,
          platform: runtime.platform,
          unsafe: markUnsafe,
        },
        async () => {
          const hold = createNativeFollowupPortHold(pin!.port, holdCancellation.signal);
          pendingHold = hold;
          // Start the bounded holder before public installation so it observes the original port's release.
          hold.catch(() => undefined);
          await nativeFollowupPublicClick(
            browser,
            '//*[@role="dialog"]//button[normalize-space()="Protect projects and install"]',
          );
          holder = await hold;
          await until(
            async () =>
              (await browser.execute(readNativeFollowupBridge)).update.backendRecovery?.some(
                (entry) =>
                  entry.environmentId === "primary" &&
                  entry.reason === "port-in-use" &&
                  entry.port === pin!.port,
              ) === true,
          );
          const recovered = await browser.execute(readNativeFollowupBridge),
            primary = recovered.data.find((entry) => entry.environmentId === "primary"),
            backupIds =
              primary?.backups
                .filter((entry) => entry.trigger === "pre-update")
                .map((entry) => entry.backupId) ?? [];
          if (!backupIds.length) throw new Error("Native follow-up verified backup missing.");
          for (const backup of backupIds)
            retainedBackups.push(
              pinNativeFollowupBackup({
                root: input.dataRoot,
                storage: pin!.storageInstanceId,
                backup,
              }),
            );
          const protection = async () => {
            await holder!.verify();
            for (const backup of retainedBackups) backup.verify();
            const state = await browser.execute(readNativeFollowupBridge),
              current = state.data.find((entry) => entry.environmentId === "primary");
            if (
              !backupIds.every((id) =>
                current?.backups.some(
                  (entry) => entry.backupId === id && entry.trigger === "pre-update",
                ),
              )
            )
              throw new Error("Native follow-up verified backup lost.");
            return { protectedBackupRetained: true as const };
          };
          for (const theme of ["light", "dark"] as const) {
            if (theme === "dark") {
              await nativeFollowupPublicClick(
                browser,
                '//*[@role="dialog"]//button[normalize-space()="Close"]',
              );
              await selectNativeFollowupTheme(browser, "Dark", origin);
              await openNativeFollowupUpdate(browser, origin);
            }
            await capture("native-update-recovery", theme, os.capture, protection);
          }
        },
      );
      await holder!.close();
      holder = null;
      await nativeFollowupPublicClick(
        browser,
        '//*[@role="dialog"]//button[normalize-space()="Restart server"]',
      );
      await until(async () => {
        const next = await read();
        return (
          next.descriptor !== null &&
          next.descriptor.bootId !== pin!.bootId &&
          next.descriptor.storageInstanceId === pin!.storageInstanceId &&
          next.update.backendRecovery?.length === 0
        );
      });
      const settled = await read();
      for (const backup of retainedBackups) backup.verify();
      pin = { ...pin, bootId: settled.descriptor!.bootId! };
      if (
        (await readDraft()) !== storageDraft ||
        settled.update.downloadedVersion !== input.candidateVersion
      )
        throw new Error("Native follow-up draft/download recovery lost.");
      await nativeFollowupPublicClick(
        browser,
        '//*[@role="dialog"]//button[normalize-space()="Cancel"]',
      );
      await browser.url(threadUrl);
      await composer.waitForDisplayed();
      if ((await composer.getText()).trim() !== draft)
        throw new Error("Native follow-up public draft was not restored.");
      try {
        write(
          "preview-prerequisite",
          await prepareNativeFollowupSupportedPreview({
            browser,
            until,
            verify: verifyOwner,
            unsafe: markUnsafe,
          }),
        );
      } catch {
        write("preview-prerequisite", {
          scene: "native-preview-annotations",
          status: "unavailable",
          reason: "production-native-picker-unsupported",
          supportedPreparation: "unavailable",
          originalCount: 0,
        });
      }
    } else {
      if (!powershell || !pin.runningDistro)
        throw new Error("Native follow-up mapped WSL missing.");
      const executable = NodePath.join(runtime.environment.SystemRoot!, "System32", "wsl.exe");
      await commands.command(executable, ["--status"]);
      const distros = (await commands.command(executable, ["--list", "--quiet"]))
        .toString("utf16le")
        .replaceAll("\0", "")
        .split(/\r?\n/)
        .map((value) => value.trim());
      if (!distros.includes(pin.runningDistro))
        throw new Error("Native follow-up real WSL distro unavailable.");
      const mapped = (
        await commands.command(executable, [
          "--distribution",
          pin.runningDistro,
          "--exec",
          "wslpath",
          "-a",
          input.dataRoot,
        ])
      )
        .toString("utf8")
        .trim();
      if (mapped !== pin.requestedRoot || mapped !== pin.effectiveRoot)
        throw new Error("Native follow-up WSL physical root mismatch.");
      await withNativeFollowupWindowsDisplay(commands, powershell, markUnsafe, async () => {
        for (const theme of ["light", "dark"] as const) {
          await browser.setWindowSize(1280, 960);
          await browser.setWindowRect(0, 0, 1280, 960);
          await browser.fullscreenWindow();
          nativeViewport = await browser.execute(() => ({
            width: innerWidth,
            height: innerHeight,
            scale: devicePixelRatio,
          }));
          if (
            nativeViewport.width !== 1280 ||
            nativeViewport.height < 900 ||
            nativeViewport.height > 960 ||
            nativeViewport.scale !== 1
          )
            throw new Error("Native follow-up Windows client geometry unavailable.");
          windowPinned = true;
          await selectNativeFollowupTheme(browser, theme === "light" ? "Light" : "Dark", origin);
          await browser.url(origin + "/#/settings/local-environment");
          await capture(
            "native-wsl-local",
            theme,
            () => captureNativeFollowupWindowsOriginal(commands, powershell),
            async () => ({}),
          );
        }
      });
      windowPinned = false;
    }
    await verifyOwner();
  } catch (error) {
    failed = true;
    originalError = error;
    try {
      write("failure", {
        phase,
        status: "unavailable",
        reason: "native-observation-refused",
        originalCount: captures.length,
      });
    } catch {
      markUnsafe();
    }
  } finally {
    holdCancellation.abort();
    const pending = pendingHold as Promise<NativeFollowupPortHold> | null;
    if (pending) {
      let acquired: NativeFollowupPortHold | null = null;
      try {
        acquired = await pending;
      } catch (error) {
        if (!failed) {
          failed = true;
          originalError = error;
        }
      }
      if (acquired) {
        try {
          await acquired.close();
        } catch (error) {
          markUnsafe();
          if (!failed) {
            failed = true;
            originalError = error;
          }
        }
      }
    }
    const remainingHold = holder as NativeFollowupPortHold | null;
    if (remainingHold) {
      try {
        await remainingHold.close();
      } catch {
        markUnsafe();
      }
    }
    try {
      windowPinned = false;
      if (priorPreference) await selectNativeFollowupTheme(browser, priorPreference, origin);
      await browser.url(originalUrl);
      await browser.setWindowSize(originalSize.width, originalSize.height);
      await browser.setWindowRect(
        originalPosition.x,
        originalPosition.y,
        originalSize.width,
        originalSize.height,
      );
      if (processPin) await verifyOwner();
    } catch {
      markUnsafe();
    }
    try {
      if (appMode !== null) {
        const current = NodeFS.lstatSync(input.appBinaryPath);
        if (current.ino !== app.ino || current.dev !== app.dev) markUnsafe();
        else NodeFS.chmodSync(input.appBinaryPath, appMode);
      }
      source.verify();
      root.verify();
      for (const backup of retainedBackups) backup.verify();
      commands.assertClosed();
    } catch {
      markUnsafe();
    }
    const result = projectNativeFollowupResult(
      captures,
      runtime.platform === "linux"
        ? ["native-preview", "native-wsl"]
        : ["native-system-theme", "native-update-ui", "native-preview"],
      !unsafe,
    );
    try {
      write("result", {
        ...result,
        partition: runtime.platform === "linux" ? "linux-menu-update" : "windows-wsl",
        partitionComplete:
          !failed && !unsafe && captures.length === (runtime.platform === "linux" ? 6 : 2),
        sourceSha: source.sourceSha,
        appSha256: appSha,
        dataRootIdentitySha256: root.sha256,
        processIdentitySha256: processPin,
        sourceFiles: source.sourceFiles,
        processes: commands.processes,
      });
    } catch (error) {
      markUnsafe();
      if (!failed) {
        failed = true;
        originalError = error;
      }
    }
  }
  if (failed) throw originalError;
  if (unsafe) throw new Error("Native follow-up cleanup unsafe.");
  return { originalCount: captures.length, complete: false, partitionComplete: true };
}
