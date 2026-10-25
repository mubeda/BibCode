import type { PullRequestsPipelineStatus } from "@bibcode/contracts";
import {
  BanIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  CirclePlayIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { memo } from "react";

interface StatusIcon {
  readonly Icon: LucideIcon;
  readonly color: string;
  readonly spin?: true;
}

/** Shape carries the status as well as color (UI.md, Colors). */
const STATUS_ICONS: Record<PullRequestsPipelineStatus, StatusIcon> = {
  created: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  queued: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  waiting: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  running: { Icon: LoaderCircleIcon, color: "text-sky-600 dark:text-sky-400", spin: true },
  manual: { Icon: CirclePlayIcon, color: "text-foreground" },
  scheduled: { Icon: ClockIcon, color: "text-muted-foreground" },
  canceling: { Icon: BanIcon, color: "text-muted-foreground" },
  success: { Icon: CircleCheckIcon, color: "text-green-600 dark:text-green-400" },
  failed: { Icon: CircleXIcon, color: "text-red-600 dark:text-red-400" },
  canceled: { Icon: BanIcon, color: "text-muted-foreground" },
  skipped: { Icon: CircleMinusIcon, color: "text-muted-foreground" },
  unknown: { Icon: CircleHelpIcon, color: "text-muted-foreground" },
};
const WARNINGS_ICON: StatusIcon = {
  Icon: TriangleAlertIcon,
  color: "text-amber-600 dark:text-amber-400",
};

/**
 * One pipeline, stage or job status, shared by the merge request's Pipelines tab and
 * the Pipelines module so a status looks the same everywhere. Decorative: the
 * caller names the status in text or an accessible label.
 */
export const PipelineStatusIcon = memo(function PipelineStatusIcon({
  status,
  warnings,
}: {
  status: PullRequestsPipelineStatus;
  warnings: boolean;
}) {
  const { Icon, color, spin } =
    status === "success" && warnings ? WARNINGS_ICON : STATUS_ICONS[status];
  const icon = <Icon aria-hidden="true" className={`size-4 shrink-0 ${color}`} />;
  // The wrapper spins, not the SVG, so the browser can hardware-accelerate it.
  return spin ? (
    <span aria-hidden="true" className="inline-flex shrink-0 motion-safe:animate-spin">
      {icon}
    </span>
  ) : (
    icon
  );
});
