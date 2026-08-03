"use client";

import type { PreviewSessionSnapshot, ScopedThreadRef } from "@bibcode/contracts";
import { useEffect, useRef } from "react";

import type { RightPanelSurface } from "~/rightPanelStore";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";

import { acquireDesktopTab } from "./desktopTabLifetime";

export interface DesktopPreviewTabHostDescriptor {
  readonly tabId: string;
  readonly initialUrl: string | null;
}

export function selectDesktopPreviewTabHosts(
  surfaces: readonly RightPanelSurface[],
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  activeSurfaceId: string | null,
): readonly DesktopPreviewTabHostDescriptor[] {
  const surface = surfaces.find((candidate) => candidate.id === activeSurfaceId);
  if (surface?.kind !== "preview" || surface.resourceId === null) return [];
  const session = sessions[surface.resourceId];
  if (!session) return [];
  return [
    {
      tabId: surface.resourceId,
      initialUrl: session.navStatus._tag === "Idle" ? null : session.navStatus.url,
    },
  ];
}

export function NativePreviewTabHost(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly initialUrl: string | null;
}) {
  const { threadRef, tabId, initialUrl } = props;
  const initialUrlRef = useRef(initialUrl);

  usePreviewBridge({ threadRef, tabId });

  useEffect(() => {
    let disposed = false;
    const lease = acquireDesktopTab(tabId);
    const initialUrl = initialUrlRef.current;
    if (initialUrl !== null) {
      void lease.navigate(initialUrl, () => !disposed).catch(() => undefined);
    }
    return () => {
      disposed = true;
      lease.release();
    };
  }, [tabId]);

  return null;
}

export function DesktopPreviewTabHosts(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: readonly RightPanelSurface[];
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly activeSurfaceId: string | null;
}) {
  const { threadRef, surfaces, sessions, activeSurfaceId } = props;
  return selectDesktopPreviewTabHosts(surfaces, sessions, activeSurfaceId).map(
    ({ tabId, initialUrl }) => (
      <NativePreviewTabHost
        key={tabId}
        threadRef={threadRef}
        tabId={tabId}
        initialUrl={initialUrl}
      />
    ),
  );
}
