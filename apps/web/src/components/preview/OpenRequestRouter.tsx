"use client";

import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@bibcode/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { openLink } from "~/browser/openLink";
import { useCenterPanelStore } from "~/centerPanelStore";
import { getClientSettings } from "~/hooks/useSettings";
import type { AppRouter } from "~/router";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolveThreadRouteRef } from "~/threadRoutes";

import { enqueueOpenPrompt } from "./OpenPromptBanner";

type ScreenRouter = Pick<AppRouter, "state">;

const HIDDEN_CLAIM_DELAY_MS = 2_000;

/** Whether a thread is the routed one, a chat panel shown as an active center tab, or neither. */
function shownAs(host: ScopedThreadRef, threadId: string): "route" | "panel" | null {
  if (host.threadId === threadId) return "route";
  const layout = useCenterPanelStore.getState().byThreadKey[scopedThreadKey(host)];
  return layout?.groups.some((group) => group.activeSurfaceId === `chat:${threadId}`)
    ? "panel"
    : null;
}

/**
 * Opens what a thread's commands ask to open (`$BROWSER`, `bibcode-open-url`).
 * Every client sees the request; only one showing that thread claims it.
 */
export function OpenRequestRouter(props: { readonly router: ScreenRouter }) {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentOpenRequestRouter
          key={environment.environmentId}
          environmentId={environment.environmentId}
          router={props.router}
        />
      ))}
    </>
  );
}

function EnvironmentOpenRequestRouter(props: {
  readonly environmentId: EnvironmentId;
  readonly router: ScreenRouter;
}) {
  const { environmentId, router } = props;
  const registry = useContext(RegistryContext);
  const claimOpenRequest = useAtomCommand(previewEnvironment.claimOpenRequest, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });

  useEffect(() => {
    const handled = new Set<string>();
    const timers = new Set<number>();
    let subscribed = false;
    // `immediate` starts the stream; the value it replays was already delivered.
    const unsubscribe = registry.subscribe(
      previewEnvironment.events({ environmentId, input: {} }),
      (result) => {
        if (!subscribed || !AsyncResult.isSuccess(result)) return;
        const event = result.value;
        if (event.type !== "openRequested" || handled.has(event.requestId)) return;
        handled.add(event.requestId);
        const threadRef = scopeThreadRef(environmentId, event.threadId as ThreadId);
        const shown = () => {
          const host = resolveThreadRouteRef(router.state.matches.at(-1)?.params ?? {});
          return host?.environmentId === environmentId ? shownAs(host, event.threadId) : null;
        };
        const claim = () => {
          // Checked when claiming: a delayed claim must not take a thread no longer shown.
          if (shown() === null) return;
          void claimOpenRequest({ environmentId, input: { requestId: event.requestId } }).then(
            (result) => {
              if (result._tag !== "Success" || !result.value.claimed) return;
              if (!window.desktopBridge) {
                // No click backs this open, so a browser would block the new tab.
                enqueueOpenPrompt({
                  id: event.requestId,
                  source: "command",
                  url: event.url,
                  threadRef,
                });
                return;
              }
              // Only the routed thread has a browser panel here (checked again: the
              // user may have moved on during the claim); otherwise use the system browser.
              const invert = shown() !== "route" && getClientSettings().browserLinkTarget === "app";
              openLink({ url: event.url, threadRef, invert, openPreview });
            },
          );
        };
        if (document.visibilityState !== "hidden") {
          claim();
          return;
        }
        // A hidden client claims only if no visible one has; requests expire after 60 s.
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          claim();
        }, HIDDEN_CLAIM_DELAY_MS);
        timers.add(timer);
      },
      { immediate: true },
    );
    subscribed = true;
    return () => {
      unsubscribe();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [claimOpenRequest, environmentId, openPreview, registry, router]);

  return null;
}
