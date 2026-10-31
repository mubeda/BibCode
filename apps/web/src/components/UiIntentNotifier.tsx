"use client";

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, UiFocusIntent, UiIntent } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { useCenterPanelStore } from "~/centerPanelStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import type { AppRouter } from "~/router";
import { readThreadShell } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { uiIntentsEnvironment } from "~/state/uiIntents";
import { buildThreadRouteParams } from "~/threadRoutes";

import { stackedThreadToast, toastManager } from "./ui/toast";

type IntentRouter = Pick<AppRouter, "navigate">;

/** Intent ids remembered against replays; intents expire after 60 s anyway. */
const HANDLED_LIMIT = 256;
/**
 * Every intent this window already announced or deferred, insertion-ordered. Module-wide, so a
 * remount (or another environment's notifier) never raises the same notice twice.
 */
const handled = new Set<string>();

/** "Agent <label> wants to show <surface>", and the thread (and file) it names. */
export function uiIntentToastCopy(
  intent: UiFocusIntent,
  threadTitle: string | null,
): { readonly title: string; readonly description: string } {
  const label = intent.actor.label?.trim();
  const agent = label ? `Agent ${label}` : "An agent";
  const surface = {
    thread: "a thread",
    files: intent.path === null ? "files" : "a file",
    sourceControl: "Source Control",
    diff: intent.path === null ? "the diff" : "a file's diff",
  }[intent.surface];
  const thread = threadTitle ? `“${threadTitle}”` : "A thread";
  return {
    title: `${agent} wants to show ${surface}`,
    description: intent.path === null ? thread : `${thread} · ${intent.path}`,
  };
}

/**
 * Shows what the intent names, after the person clicked Show: the thread's route (a chat
 * panel's host, with the panel's tab active), then the surface on it.
 */
export async function showUiIntent(
  router: IntentRouter,
  environmentId: EnvironmentId,
  intent: UiFocusIntent,
): Promise<void> {
  const ref = scopeThreadRef(environmentId, intent.threadId);
  const shell = readThreadShell(ref);
  const host: ScopedThreadRef = shell?.hostThreadId
    ? scopeThreadRef(environmentId, shell.hostThreadId)
    : ref;
  await router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(host) });
  if (host.threadId !== ref.threadId) {
    useCenterPanelStore.getState().openChatPanel(host, intent.threadId);
  }
  const rightPanel = useRightPanelStore.getState();
  switch (intent.surface) {
    case "thread":
      return;
    case "files":
      if (intent.path === null) rightPanel.open(host, "files");
      else rightPanel.openFile(host, intent.path);
      return;
    case "sourceControl":
      rightPanel.open(host, "sourceControl");
      return;
    case "diff":
      rightPanel.open(host, "diff");
      if (intent.path !== null) useDiffPanelStore.getState().selectCompareFile(host, intent.path);
      return;
  }
}

/**
 * Raises a non-modal notice for each UI suggestion an outside agent sends (`focus_ui`), with
 * a Show button. Nothing moves until the person clicks it, so a suggestion never takes focus
 * from someone typing. A hidden window raises it when it is shown again, if it is still pending.
 */
export function UiIntentNotifier(props: { readonly router: IntentRouter }) {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentUiIntentNotifier
          key={environment.environmentId}
          environmentId={environment.environmentId}
          router={props.router}
        />
      ))}
    </>
  );
}

function EnvironmentUiIntentNotifier(props: {
  readonly environmentId: EnvironmentId;
  readonly router: IntentRouter;
}) {
  const { environmentId, router } = props;
  const registry = useContext(RegistryContext);

  useEffect(() => {
    const deferred = new Map<string, UiFocusIntent>();
    const announce = (intent: UiFocusIntent) => {
      const remaining = Date.parse(intent.expiresAt) - Date.now();
      if (remaining <= 0) return;
      const title = readThreadShell(scopeThreadRef(environmentId, intent.threadId))?.title ?? null;
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "info",
          ...uiIntentToastCopy(intent, title),
          timeout: remaining,
          actionVariant: "outline",
          actionProps: {
            children: "Show",
            onClick: () => {
              toastManager.close(toastId);
              void showUiIntent(router, environmentId, intent);
            },
          },
        }),
      );
    };
    const receive = (intents: ReadonlyArray<UiIntent>) => {
      for (const intent of intents) {
        // Later kinds (slice X7) have their own surfaces.
        if (intent.kind !== "focus" || handled.has(intent.intentId)) continue;
        handled.add(intent.intentId);
        if (handled.size > HANDLED_LIMIT) handled.delete(handled.values().next().value!);
        if (document.visibilityState === "hidden") deferred.set(intent.intentId, intent);
        else announce(intent);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      const pending = [...deferred.values()];
      deferred.clear();
      for (const intent of pending) announce(intent);
    };
    const unsubscribe = registry.subscribe(
      uiIntentsEnvironment.intents({ environmentId, input: null }),
      (result) => {
        if (AsyncResult.isSuccess(result)) receive(result.value);
      },
      { immediate: true },
    );
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId, registry, router]);

  return null;
}
