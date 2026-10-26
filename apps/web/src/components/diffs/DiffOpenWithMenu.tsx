import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import type {
  ClientSettings,
  EnvironmentId,
  ReviewDiffTool,
  ReviewDiffToolScope,
  ReviewOpenDiffToolInput,
} from "@bibcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, CopyIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isDesktopHost } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import {
  NO_DIFF_TOOL_REASON,
  UNTRACKED_FILE_REASON,
  describeDiffToolLaunchFailure,
  describeOpenWithHeading,
  describeOpenWithUnavailable,
  diffToolOpensAllFiles,
  formatDiffToolCommand,
  resolveDefaultDiffTool,
  type DiffOpenWithTarget,
  type DiffToolLaunchFailure,
} from "~/lib/diffOpenWith";
import { cn } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";

export interface DiffOpenWithMenuProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** The scope whose revisions the server compares. */
  readonly scope: ReviewDiffToolScope;
  readonly target: DiffOpenWithTarget;
  /** A launch that did not open; the panel shows it under its toolbar. */
  readonly onLaunchFailure: (failure: DiffToolLaunchFailure) => void;
  readonly className?: string;
}

type LaunchTarget = ReviewOpenDiffToolInput["target"];

const selectDiffToolLastChoice = (settings: ClientSettings) => settings.diffToolLastChoice;

/**
 * **Open with**: opens the file, or every file, in a diff app through `git difftool` on the
 * server's computer. Each reason it cannot is shown in the menu rather than hiding it.
 */
export function DiffOpenWithMenu({
  environmentId,
  cwd,
  scope,
  target,
  onLaunchFailure,
  className,
}: DiffOpenWithMenuProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const unavailableReason = describeOpenWithUnavailable({
    local: primaryEnvironmentId !== null && environmentId === primaryEnvironmentId,
    environmentLabel: environment?.label ?? null,
    supported: serverConfig?.environment.capabilities.reviewDiffTools === true,
  });
  const [open, setOpen] = useState(false);
  // Probing the apps takes a second or two, so the list is asked for when the pointer reaches
  // the button, before the menu opens.
  const [wanted, setWanted] = useState(false);
  const want = () => setWanted(true);
  const toolsQuery = useEnvironmentQuery(
    wanted && unavailableReason === null
      ? reviewEnvironment.diffTools({ environmentId, input: { cwd } })
      : null,
  );
  const lastChoice = useClientSettings(selectDiffToolLastChoice);
  const updateClientSettings = useUpdateClientSettings();
  const openDiffTool = useAtomCommand(reviewEnvironment.openDiffTool, { reportFailure: false });
  // The launch in flight, by tool and target; its item shows a spinner and is disabled.
  const [launching, setLaunching] = useState<string | null>(null);

  const list = toolsQuery.data ?? null;
  // A folder comparison needs a tool that takes folders.
  const allFilesList =
    list === null
      ? null
      : { ...list, tools: list.tools.filter((tool) => diffToolOpensAllFiles(tool.id)) };
  const shownList = target.kind === "all" ? allFilesList : list;
  const defaultTool = shownList === null ? null : resolveDefaultDiffTool(shownList, lastChoice);
  const allFilesTool =
    allFilesList === null ? null : resolveDefaultDiffTool(allFilesList, lastChoice);
  const tools =
    shownList === null || defaultTool === null
      ? []
      : [defaultTool, ...shownList.tools.filter((tool) => tool.id !== defaultTool.id)];

  const launch = async (tool: ReviewDiffTool, launchTarget: LaunchTarget) => {
    const key = `${launchTarget._tag}:${tool.id}`;
    setLaunching(key);
    updateClientSettings({ diffToolLastChoice: tool.id });
    const result = await openDiffTool({
      environmentId,
      input: { cwd, toolId: tool.id, target: launchTarget, scope },
    });
    setLaunching((current) => (current === key ? null : current));
    setOpen(false);
    if (result._tag === "Failure") {
      onLaunchFailure(describeDiffToolLaunchFailure(tool.label, squashAtomCommandFailure(result)));
    }
  };
  const fileTarget: LaunchTarget =
    target.kind === "file"
      ? {
          _tag: "file",
          path: target.path,
          ...(target.previousPath ? { previousPath: target.previousPath } : {}),
        }
      : { _tag: "all" };

  const reason =
    unavailableReason ??
    (toolsQuery.error
      ? `Couldn't find diff apps. ${toolsQuery.error}`
      : list === null
        ? null
        : tools.length === 0
          ? NO_DIFF_TOOL_REASON
          : null);

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (next) want();
        setOpen(next);
      }}
    >
      <MenuTrigger
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        onFocus={want}
        onPointerEnter={want}
      >
        Open with
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-64">
        <MenuGroup>
          <MenuGroupLabel className="truncate">{describeOpenWithHeading(target)}</MenuGroupLabel>
          {reason !== null ? (
            <MenuItem className="h-auto whitespace-normal py-1.5 text-xs" disabled>
              {reason}
            </MenuItem>
          ) : list === null ? (
            <MenuItem className="text-xs" disabled>
              Finding diff apps…
            </MenuItem>
          ) : target.kind === "file" && target.untracked ? (
            <MenuItem className="h-auto whitespace-normal py-1.5 text-xs" disabled>
              {UNTRACKED_FILE_REASON}
            </MenuItem>
          ) : (
            tools.map((tool) => {
              const key = `${fileTarget._tag}:${tool.id}`;
              return (
                <MenuItem
                  key={tool.id}
                  closeOnClick={false}
                  disabled={launching === key}
                  onClick={() => void launch(tool, fileTarget)}
                >
                  <span className="min-w-0 truncate">{tool.label}</span>
                  {launching === key ? (
                    <Spinner className="ml-auto size-3.5" />
                  ) : tool.id === defaultTool?.id ? (
                    <span className="ml-auto text-xs text-muted-foreground">Default</span>
                  ) : null}
                </MenuItem>
              );
            })
          )}
        </MenuGroup>
        {reason === null && target.kind === "file" && allFilesTool !== null ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={false}
              disabled={launching === `all:${allFilesTool.id}`}
              onClick={() => void launch(allFilesTool, { _tag: "all" })}
            >
              <span className="min-w-0 truncate">All files in {allFilesTool.label}</span>
              {launching === `all:${allFilesTool.id}` ? (
                <Spinner className="ml-auto size-3.5" />
              ) : null}
            </MenuItem>
          </>
        ) : null}
        {isDesktopHost ? null : (
          <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            Opens on the computer running the server.
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** A launch that did not open: what failed, Git's message, and the command to run by hand. */
export function DiffToolLaunchAlert({
  failure,
  onDismiss,
}: {
  readonly failure: DiffToolLaunchFailure;
  readonly onDismiss: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "the command" });
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{failure.title}</p>
        {failure.detail ? (
          <p className="mt-0.5 break-words text-muted-foreground">{failure.detail}</p>
        ) : null}
      </div>
      {failure.command ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => copyToClipboard(formatDiffToolCommand(failure.command!), undefined)}
        >
          <CopyIcon aria-hidden="true" />
          {isCopied ? "Copied" : "Copy command"}
        </Button>
      ) : null}
      <Button aria-label="Dismiss" size="xs" variant="ghost" onClick={onDismiss}>
        <XIcon aria-hidden="true" />
        Dismiss
      </Button>
    </div>
  );
}
