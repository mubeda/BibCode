import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  /**
   * Shows what is being approved (the command or the file) in the panel. The expanded composer
   * shows it in the editor, which the collapsed composer on a narrow screen does not render.
   */
  showDetail?: boolean;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  showDetail = false,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {showDetail && approval.detail ? (
        <p className="mt-2 max-h-32 overflow-y-auto font-mono text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {approval.detail}
        </p>
      ) : null}
    </div>
  );
});
