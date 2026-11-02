import { PROVIDER_DISPLAY_NAMES } from "@bibcode/contracts";
import { useEffect, useRef } from "react";

import { useEnvironments } from "~/state/environments";
import {
  detectExternalUpdates,
  type ProviderVersionObservation,
} from "./externalUpdateNotice.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const announcedNoticeKeys = new Set<string>();

/**
 * Says so when a provider updated itself (Claude Code's own updater) while BiBCode ran, so
 * nothing changes silently. It compares each environment's provider versions between
 * snapshots; an update BiBCode ran has its own toast and is left out.
 */
export function ExternalUpdateNotice() {
  const { environments } = useEnvironments();
  const lastVersions = useRef<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const observations: ProviderVersionObservation[] = [];
    for (const environment of environments) {
      for (const provider of environment.serverConfig?.providers ?? []) {
        observations.push({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
          version: provider.version,
          updatedByBiBCode: provider.updateState !== undefined,
        });
      }
    }
    const { notices, next } = detectExternalUpdates(
      lastVersions.current,
      observations,
      announcedNoticeKeys,
      environments.length > 1,
    );
    lastVersions.current = next;
    for (const notice of notices) {
      announcedNoticeKeys.add(notice.key);
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: notice.title,
          description: notice.description,
          timeout: 10_000,
          data: { hideCopyButton: true },
        }),
      );
    }
  }, [environments]);

  return null;
}
