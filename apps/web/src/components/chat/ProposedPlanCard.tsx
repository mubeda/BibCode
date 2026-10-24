import { memo, useState, useId } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@bibcode/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { PLAN_BODY_FIND_SCOPE, PLAN_TITLE_FIND_SCOPE } from "./threadFind/threadFindScopes";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
  expanded: controlledExpanded,
  onExpandedChange,
  detailsOpen,
  onDetailsOpenChange,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  /** Whether a long plan shows in full, when the caller owns that state. */
  expanded?: boolean | undefined;
  onExpandedChange?: ((expanded: boolean) => void) | undefined;
  /** The plan body's `<details>` blocks, when the caller owns their state (see `ChatMarkdown`). */
  detailsOpen?: ReadonlyMap<number, boolean> | undefined;
  onDetailsOpenChange?: ((ordinal: number, open: boolean) => void) | undefined;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const toggleExpanded = () => {
    if (onExpandedChange) {
      onExpandedChange(!expanded);
    } else {
      setLocalExpanded((value) => !value);
    }
  };
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const authoredTitle = proposedPlanTitle(planMarkdown);
  const title = authoredTitle ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const relativePath = savePath.trim();
    if (!workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred while saving.",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p
            className="truncate text-sm font-medium text-foreground"
            // The fallback title is chrome; an authored one is the plan's text.
            data-find-scope={authoredTitle ? PLAN_TITLE_FIND_SCOPE : undefined}
          >
            {title}
          </p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
              detailsOpen={detailsOpen}
              onDetailsOpenChange={onDetailsOpenChange}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
              detailsOpen={detailsOpen}
              onDetailsOpenChange={onDetailsOpenChange}
              findScope={PLAN_BODY_FIND_SCOPE}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="outline" data-scroll-anchor-ignore onClick={toggleExpanded}>
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
