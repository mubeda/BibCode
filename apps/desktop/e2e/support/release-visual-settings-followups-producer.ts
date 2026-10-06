import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { SettingsFollowupApi } from "./release-visual-settings-followups-api.ts";
import type { SettingsFollowupSocketOwner } from "./release-visual-settings-followups-socket.ts";
import type {
  SettingsFollowupTarget,
  SettingsFollowupPhysicalSource,
} from "./release-visual-settings-followups-source.ts";
import type { SettingsFollowupObservation } from "./release-visual-settings-followups.ts";
import {
  settingsFollowupScenes,
  settingsFollowupRows,
  type SettingsFollowupScene,
} from "./release-visual-settings-followups.ts";
import {
  verifySettingsFollowupSource,
  verifySettingsFollowupDiagnostics,
  verifySettingsFollowupUsage,
} from "./release-visual-settings-followups-source.ts";
import {
  runSettingsFollowupRename,
  runSettingsFollowupUsage,
} from "./release-visual-settings-followups-public.ts";
import { bounded } from "./qualification-owner.ts";
export interface SettingsFollowupProducerTarget {
  target: SettingsFollowupTarget;
  api: SettingsFollowupApi;
  readPhysical: () => Promise<SettingsFollowupPhysicalSource>;
}
export interface SettingsFollowupProducerInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  origin: "http://127.0.0.1:4885";
  theme: "light" | "dark";
  primary: SettingsFollowupProducerTarget;
  remote: SettingsFollowupProducerTarget;
  originalRemoteLabel: string;
  nextRemoteLabel: string;
  ownedPrimaryServerPid: number;
  ownedMissingPath: string;
  socket: SettingsFollowupSocketOwner;
  admitOwner: () => Promise<void>;
  capture: (
    observation: SettingsFollowupObservation,
    verifySource: () => Promise<void>,
  ) => Promise<void>;
  removeOwnedRemoteRegistration: () => Promise<void>;
  verifyOriginalRestored: () => Promise<void>;
  observeUnsafeCleanup: () => void;
  step: (phase: string) => void;
}
/** Reads only public route/rail/credential context; no client runtime or catalog access. */
export function readSettingsFollowupCallerState(input: {
  origin: string;
  environmentId: string;
  environmentLabel: string;
  threadId: string;
}) {
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search ||
    location.hash ||
    ![input.environmentId, input.threadId].every((value) =>
      /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    !/^[A-Za-z0-9 -]{1,80}$/.test(input.environmentLabel)
  )
    return null;
  const railId =
    input.environmentId === "local"
      ? "environment-rail-local"
      : "environment-rail-entry-" + input.environmentId;
  const rails = document.querySelectorAll(`[data-testid="${railId}"][aria-checked="true"]`);
  const route = ["/settings/remote-servers", "/settings/about", "/settings/diagnostics"].includes(
    location.pathname,
  )
    ? "settings"
    : location.pathname ===
        "/" + encodeURIComponent(input.environmentId) + "/" + encodeURIComponent(input.threadId)
      ? "workspace"
      : "other";
  return {
    route,
    selectedMatched: rails.length === 1,
    labelMatched:
      rails.length === 1 &&
      rails[0]!.getAttribute("aria-label") ===
        (input.environmentId === "local" ? "Local — this machine" : input.environmentLabel),
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
  };
}
/** Ordinary element scrolling inside the existing Settings surface; outer scroll must stay fixed. */
export function scrollSettingsFollowupSection(input: {
  origin: string;
  title: "Trace Diagnostics" | "Live Processes" | "Top Span Names";
}) {
  if (
    location.origin !== input.origin ||
    input.origin !== "http://127.0.0.1:4885" ||
    location.pathname !== "/settings/diagnostics" ||
    location.search ||
    location.hash ||
    !["Trace Diagnostics", "Live Processes", "Top Span Names"].includes(input.title) ||
    document.querySelector(
      '#pairing-token,input[type="password"],textarea[placeholder^="bibcode://pair"]',
    ) !== null
  )
    return false;
  const titles = Array.from(document.querySelectorAll("section h2")).filter(
    (value) => value.textContent?.trim() === input.title,
  );
  const section = titles.length === 1 ? titles[0]!.closest("section") : null;
  if (!section || section.getBoundingClientRect().width <= 0) return false;
  const before = { x: scrollX, y: scrollY };
  section.scrollIntoView({ block: "start", inline: "nearest" });
  return scrollX === before.x && scrollY === before.y;
}
/** Four existing rows, nine finite scenes per theme; all mutation is through public controls. */
export async function runSettingsFollowupProducer(input: SettingsFollowupProducerInput) {
  const refused = () => new Error("Owned settings follow-up producer refused.");
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    !["light", "dark"].includes(input.theme) ||
    input.primary.target.environmentId !== "local" ||
    input.remote.target.environmentId === "local" ||
    input.primary.target.descriptor.storageInstanceId ===
      input.remote.target.descriptor.storageInstanceId ||
    input.primary.target.projectRoot === input.remote.target.projectRoot ||
    ![input.originalRemoteLabel, input.nextRemoteLabel].every((value) =>
      /^[A-Za-z0-9 -]{1,64}$/.test(value),
    ) ||
    input.originalRemoteLabel === input.nextRemoteLabel
  )
    throw refused();
  const { browser, primary, remote } = input;
  const files: string[] = [];
  let original: unknown,
    failed = false,
    cleanupFailed = false,
    held = false;
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const rail = (target: SettingsFollowupProducerTarget) =>
    `[data-testid="${target === primary ? "environment-rail-local" : "environment-rail-entry-" + target.target.environmentId}"]`;
  const readLabel = async () => {
    const value = await browser.$(rail(remote)).getAttribute("aria-label");
    if (value !== input.originalRemoteLabel && value !== input.nextRemoteLabel) throw refused();
    return value;
  };
  const context = async (target: SettingsFollowupProducerTarget) => {
    const value = await bounded(
      browser.execute(readSettingsFollowupCallerState, {
        origin: input.origin,
        environmentId: target.target.environmentId,
        environmentLabel: target === remote ? await readLabel() : target.target.descriptor.label,
        threadId: target.target.threadId,
      }),
      2000,
    );
    if (!value || !value.credentialAbsent || !value.bootShellAbsent) throw refused();
    return value;
  };
  const verifyBoth = async () => {
    await input.admitOwner();
    for (const target of [primary, remote])
      verifySettingsFollowupSource({
        target: target.target,
        config: await target.api.config(),
        snapshot: await target.api.snapshot(),
        physical: await target.readPhysical(),
      });
  };
  const select = async (target: SettingsFollowupProducerTarget) => {
    await click(rail(target));
    await input.owner.until(async () => {
      const value = await context(target);
      return value.selectedMatched && value.labelMatched;
    });
  };
  const workspace = async (target: SettingsFollowupProducerTarget) => {
    for (let count = 0; count < 3 && (await context(target)).route === "settings"; count++)
      await click("button=Back");
    if ((await context(target)).route === "settings") throw refused();
    await select(target);
    await click(
      `[data-testid="${target.target.workspaceKind === "primary" ? "primary-card-button-" + target.target.projectId : "thread-card-button-" + target.target.threadId}"]`,
    );
    await input.owner.until(async () => (await context(target)).route === "workspace");
  };
  const openRemoteSettings = async () => {
    await click('[data-testid="environment-rail-manage"]');
    await click("button=Remote Servers");
  };
  const rowButton = (name: "Disconnect" | "Connect") =>
    `//h3[normalize-space()="${input.originalRemoteLabel}"]/ancestor::div[3]//button[normalize-space()="${name}"]`;
  const initialSocket = input.socket.observation();
  const sameSocket = () => {
    const value = input.socket.observation();
    if (
      value.closed ||
      value.holding ||
      value.activeNoiseConnections !== 1 ||
      value.acceptedNoiseConnections !== initialSocket.acceptedNoiseConnections ||
      initialSocket.acceptedNoiseConnections < 1
    )
      throw refused();
  };
  let diagnostics: ReturnType<typeof verifySettingsFollowupDiagnostics> | undefined;
  let readFailure: Awaited<ReturnType<SettingsFollowupApi["requestOwnedReadFailure"]>> | undefined;
  let before: Awaited<ReturnType<SettingsFollowupApi["diagnostics"]>> | undefined;
  const causalDiagnostics = async () => {
    if (!before || !readFailure) throw refused();
    return verifySettingsFollowupDiagnostics({
      before,
      after: await primary.api.diagnostics(),
      error: readFailure.error,
      processes: await primary.api.processes(),
      ownedServerPid: input.ownedPrimaryServerPid,
    });
  };
  const capture = async (
    scene: SettingsFollowupScene,
    target: SettingsFollowupProducerTarget,
    usageLabels: readonly string[] = [],
  ) => {
    if (files.length >= 9 || scene !== settingsFollowupScenes[files.length]) throw refused();
    input.step("visual-settings-followups-" + scene);
    const verify = async () => {
      await verifyBoth();
      const value = await context(target);
      if (!value.selectedMatched || !value.labelMatched) throw refused();
      if (scene.startsWith("diagnostics") || scene === "settings-diagnostics")
        await causalDiagnostics();
      if (scene === "usage-detail" || scene === "usage-detail-available")
        verifySettingsFollowupUsage(
          await target.api.usage(),
          scene === "usage-detail" ? "unavailable" : "available",
        );
      if (scene === "remote-rename" || scene === "remote-rename-applied") sameSocket();
      if (scene === "receiving-settings-row" || scene === "remote-receiving-settings") {
        await input.socket.verifyHolding();
        const value = input.socket.observation();
        if (
          value.acceptedNoiseConnections !== initialSocket.acceptedNoiseConnections + 1 ||
          value.activeNoiseConnections !== 1 ||
          !value.holding
        )
          throw refused();
      }
    };
    let joins = 0;
    await input.capture(
      {
        scene,
        theme: input.theme,
        origin: input.origin,
        environmentId: target.target.environmentId,
        environmentLabel: target === remote ? await readLabel() : target.target.descriptor.label,
        projectTitle: target.target.projectTitle,
        threadId: target.target.threadId,
        projectId: target.target.projectId,
        workspaceKind: target.target.workspaceKind,
        originalLabel: input.originalRemoteLabel,
        reportedLabel: target.target.descriptor.label,
        spanCount: diagnostics?.spanCount ?? 0,
        failureCount: diagnostics?.failureCount ?? 0,
        processLabels: diagnostics?.processLabels ?? [],
        unmeasuredSpanName: diagnostics?.unmeasuredSpanName ?? "agent_activity_disabled",
        unmeasuredCount: diagnostics?.unmeasuredCount ?? 0,
        failureCause: diagnostics?.failureCause ?? "",
        usageLabels,
        formerUsageLabels: ["93% remaining", "59% remaining"],
      },
      async () => {
        await verify();
        joins++;
      },
    );
    if (joins !== 2) throw refused();
    files.push(scene + "-" + input.theme + ".png");
  };
  try {
    await verifyBoth();
    sameSocket();
    await workspace(primary);
    if (
      (
        await browser
          .$('[data-chat-composer-form="true"] [data-testid="composer-editor"]')
          .getText()
      ).trim() !== "Owned visual review draft"
    )
      throw refused();
    before = await primary.api.diagnostics();
    readFailure = await primary.api.requestOwnedReadFailure(input.ownedMissingPath);
    await openRemoteSettings();
    await click("button=About");
    await click("a=View diagnostics");
    await click('[aria-label="Refresh trace diagnostics"]');
    await click('[aria-label="Refresh process diagnostics"]');
    diagnostics = await causalDiagnostics();
    for (const [scene, title] of [
      ["settings-diagnostics", "Trace Diagnostics"],
      ["diagnostics-live-processes", "Live Processes"],
      ["diagnostics-unknown-duration", "Top Span Names"],
    ] as const) {
      if (!(await browser.execute(scrollSettingsFollowupSection, { origin: input.origin, title })))
        throw refused();
      await capture(scene, primary);
    }
    await workspace(primary);
    await primary.api.refreshUsage();
    await runSettingsFollowupUsage({
      browser,
      owner: input.owner,
      verifyIdentity: verifyBoth,
      verifyUsage: async () => {
        verifySettingsFollowupUsage(await primary.api.usage(), "available");
      },
      capture: () => capture("usage-detail-available", primary, ["93% remaining", "59% remaining"]),
      observeUnsafeCleanup: input.observeUnsafeCleanup,
    });
    await workspace(remote);
    await remote.api.refreshUsage();
    await runSettingsFollowupUsage({
      browser,
      owner: input.owner,
      verifyIdentity: verifyBoth,
      verifyUsage: async () => {
        verifySettingsFollowupUsage(await remote.api.usage(), "unavailable");
      },
      capture: () => capture("usage-detail", remote),
      observeUnsafeCleanup: input.observeUnsafeCleanup,
    });
    await runSettingsFollowupRename({
      browser,
      owner: input.owner,
      originalLabel: input.originalRemoteLabel,
      nextLabel: input.nextRemoteLabel,
      openDialog: async () => {
        await openRemoteSettings();
        await click(`[aria-label="More actions for ${await readLabel()}"]`);
        await click('//*[@role="menuitem" and normalize-space()="Rename…"]');
      },
      readLabel,
      verifyIdentity: async () => {
        await verifyBoth();
        sameSocket();
      },
      captureDialog: () => capture("remote-rename", remote),
      afterSave: async () => {
        await workspace(remote);
        await capture("remote-rename-applied", remote);
      },
      observeUnsafeCleanup: input.observeUnsafeCleanup,
    });
    await openRemoteSettings();
    await click(rowButton("Disconnect"));
    await input.owner.until(async () => input.socket.observation().activeNoiseConnections === 0);
    await input.socket.armNextConfiguration();
    await click(rowButton("Connect"));
    held = true;
    await input.owner.until(async () => {
      await input.admitOwner();
      const value = input.socket.observation(),
        expected = initialSocket.acceptedNoiseConnections + 1;
      if (
        value.closed ||
        value.acceptedNoiseConnections < initialSocket.acceptedNoiseConnections ||
        value.acceptedNoiseConnections > expected ||
        value.activeNoiseConnections > 1
      )
        throw refused();
      // A joined upgrade disappearing cannot be a pending handshake. Surface the
      // exact owned scope failure instead of treating an expired/closed peer as readiness.
      if (value.acceptedNoiseConnections === expected && value.activeNoiseConnections === 0) {
        await input.socket.verifyHolding();
        throw refused();
      }
      if (
        !value.holding ||
        value.heldBytes <= 0 ||
        value.activeNoiseConnections !== 1 ||
        value.acceptedNoiseConnections !== expected
      )
        return false;
      await input.socket.verifyHolding();
      const joined = input.socket.observation();
      if (
        joined.closed ||
        !joined.holding ||
        joined.heldBytes <= 0 ||
        joined.activeNoiseConnections !== 1 ||
        joined.acceptedNoiseConnections !== expected
      )
        throw refused();
      return true;
    });
    await capture("receiving-settings-row", remote);
    await workspace(remote);
    await capture("remote-receiving-settings", remote);
    await input.socket.release();
    held = false;
    await input.owner.until(async () => {
      const value = input.socket.observation();
      return !value.closed && !value.holding && value.activeNoiseConnections === 1;
    });
    await verifyBoth();
    const live = browser.$(rail(remote) + ' [data-status="connected"]');
    await live.waitForDisplayed();
  } catch (error) {
    failed = true;
    original = error;
  }
  const clean = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch {
      cleanupFailed = true;
    }
  };
  if (held || input.socket.observation().holding)
    await clean(async () => {
      await input.socket.release();
      held = false;
    });
  await clean(input.removeOwnedRemoteRegistration);
  await clean(async () => {
    await workspace(primary);
    await input.verifyOriginalRestored();
    await verifyBoth();
  });
  if (cleanupFailed) {
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Preserve primary and cleanup outcomes. */
    }
  }
  if (failed) throw original;
  if (cleanupFailed || files.length !== 9) throw refused();
  return {
    theme: input.theme,
    rows: [...settingsFollowupRows],
    files,
    completeGroup: false,
    sourceIdentityRetained: true,
    originalContextRestored: true,
    originalLabelRestored: true,
    originalConfigurationReleased: true,
    unavailableUsageDidNotBorrow: true,
  } as const;
}
