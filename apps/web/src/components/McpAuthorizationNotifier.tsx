"use client";

import type { AuthPendingMcpAuthorization } from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect } from "react";

import type { AppRouter } from "~/router";
import { usePrimaryEnvironment } from "~/state/environments";
import { usePrimaryMcpAuthorizations } from "~/state/mcpAuthorizations";

import { REQUESTS_TO_CONNECT_ID } from "./settings/McpRemoteAgentsPanel";
import { stackedThreadToast, toastManager } from "./ui/toast";

type ReviewRouter = Pick<AppRouter, "navigate">;

/** Request ids remembered against repeats; a request lasts ten minutes anyway. */
const ANNOUNCED_LIMIT = 256;
/**
 * Every request this window already announced, insertion-ordered. Module-wide, so a remount
 * never raises the same notice twice.
 */
const announced = new Set<string>();

/** "Claude Code wants to operate Office", and the code to compare. */
export function mcpAuthorizationToastCopy(
  request: AuthPendingMcpAuthorization,
  environmentLabel: string,
): { readonly title: string; readonly description: string } {
  const client = request.clientName.trim() || "An AI tool";
  const environment = environmentLabel.trim() || "this environment";
  return {
    title: `${client} wants to operate ${environment}`,
    description: `Check the code ${request.code}, then approve or deny it.`,
  };
}

/** **Review**: Settings → Agents, scrolled to the requests to connect. */
export async function reviewMcpAuthorizations(router: ReviewRouter): Promise<void> {
  await router.navigate({ to: "/settings/agents" });
  // The section renders after the route does; look for it over a few frames.
  for (let frame = 0; frame < 10; frame += 1) {
    const section = document.getElementById(REQUESTS_TO_CONNECT_ID);
    if (section !== null) {
      section.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/**
 * Raises a notice in every BiBCode client that may decide them (`access:write`) when a
 * remote AI tool asks to connect (#139, slice R). **Review** opens the requests, because the
 * tool's sign-in page tells the person to approve in BiBCode. A hidden window raises it when
 * it is shown again, if the request still waits.
 */
export function McpAuthorizationNotifier(props: { readonly router: ReviewRouter }) {
  const { router } = props;
  const { requests, canManage } = usePrimaryMcpAuthorizations();
  const environmentLabel = usePrimaryEnvironment()?.label ?? "";

  useEffect(() => {
    if (!canManage) return;
    const announce = (request: AuthPendingMcpAuthorization) => {
      const remaining = DateTime.toEpochMillis(request.expiresAt) - Date.now();
      if (remaining <= 0) return;
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "info",
          ...mcpAuthorizationToastCopy(request, environmentLabel),
          timeout: remaining,
          actionVariant: "outline",
          actionProps: {
            children: "Review",
            onClick: () => {
              toastManager.close(toastId);
              void reviewMcpAuthorizations(router);
            },
          },
        }),
      );
    };
    const fresh = requests.filter((request) => !announced.has(request.id));
    const raise = () => {
      for (const request of fresh) {
        if (announced.has(request.id)) continue;
        announced.add(request.id);
        if (announced.size > ANNOUNCED_LIMIT) announced.delete(announced.values().next().value!);
        announce(request);
      }
    };
    if (fresh.length === 0) return;
    if (document.visibilityState !== "hidden") {
      raise();
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      raise();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [requests, canManage, environmentLabel, router]);

  return null;
}

/** Forgets what was announced, between tests. */
export function __resetMcpAuthorizationNotifierForTests(): void {
  announced.clear();
}
