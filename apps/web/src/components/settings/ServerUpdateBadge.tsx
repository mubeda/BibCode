import type { RemoteUpdateSnapshot } from "@bibcode/contracts";

export type ServerUpdateBadgeVariant =
  | "up-to-date"
  | "update-available"
  | "busy"
  | "manual"
  | "error"
  | "unknown";

export function serverUpdateBadgeVariant(
  snapshot: RemoteUpdateSnapshot | null,
): ServerUpdateBadgeVariant {
  if (snapshot === null) return "unknown";
  switch (snapshot.state) {
    case "error":
      return "error";
    case "checking":
    case "downloading":
    case "installing":
      return "busy";
    case "update-available":
      return "update-available";
    case "up-to-date":
      return "up-to-date";
    case "idle":
      return snapshot.support.installMode === "manual" ? "manual" : "unknown";
  }
}

const BADGE_LABELS: Record<ServerUpdateBadgeVariant, string> = {
  "up-to-date": "Up to date",
  "update-available": "Update available",
  busy: "Updating…",
  manual: "Manual updates",
  error: "Update status error",
  unknown: "Status unavailable",
};

const BADGE_CLASSES: Record<ServerUpdateBadgeVariant, string> = {
  "up-to-date": "border-border text-muted-foreground",
  "update-available": "border-amber-500/40 text-amber-600 dark:text-amber-400",
  busy: "border-border text-muted-foreground animate-pulse",
  manual: "border-border text-muted-foreground",
  error: "border-destructive/40 text-destructive",
  unknown: "border-border text-muted-foreground/70",
};

export function ServerUpdateBadge({ snapshot }: { snapshot: RemoteUpdateSnapshot | null }) {
  const variant = serverUpdateBadgeVariant(snapshot);
  const label =
    variant === "update-available" && snapshot?.latestVersion != null
      ? `Update to v${snapshot.latestVersion}`
      : BADGE_LABELS[variant];
  return (
    <span
      data-variant={variant}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${BADGE_CLASSES[variant]}`}
    >
      {label}
    </span>
  );
}

/**
 * Headless servers cannot install remotely and have no update feed: show honest
 * operator steps, never a fabricated "latest version".
 */
export function manualUpdateInstructions(serverVersion: string): string {
  return [
    "# Update this BiBCode server manually on its host:",
    "# 1. Stop the running server (Ctrl+C or your service manager).",
    "# 2. Install the latest bibcode build (replace the binary on PATH).",
    "# 3. Restart it:",
    "bibcode serve",
    "",
    `# Currently running: v${serverVersion}`,
  ].join("\n");
}
