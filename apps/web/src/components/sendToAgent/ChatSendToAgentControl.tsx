/**
 * The Send to agent control of one chat panel. It reads the panel's messages, the agent list and
 * the sender itself, so that ChatView and the memoized composer footer see none of their
 * changes: the footer's slot is one stable element.
 */
import type { DefaultAgentSelection, ScopedThreadRef, ThreadId } from "@bibcode/contracts";
import { memo, useCallback, useMemo } from "react";

import { useProjects, useThreadMessages, useThreadShell } from "~/state/entities";
import { useSendRequest } from "~/state/sendRequests";
import { useAgentRows } from "../agents/useAgentRows";
import { SendToAgentButton } from "./SendToAgentButton";
import type {
  NewPanelProvider,
  PreviewContent,
  SendChoice,
  SendToAgentSource,
} from "./sendToAgent.logic";

// Until terminals can be notified (phase 9), no terminal is offered as a target.
const canNotifyTerminal = () => false;

export const ChatSendToAgentControl = memo(function ChatSendToAgentControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly serverSupported: boolean;
  readonly newPanelProviders: ReadonlyArray<NewPanelProvider>;
  readonly createPanel: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
  readonly previewContentFor: (choice: SendChoice) => PreviewContent | null;
}) {
  const { threadRef, newPanelProviders } = props;
  const shell = useThreadShell(threadRef);
  const messages = useThreadMessages(threadRef);
  const rows = useAgentRows();
  const projects = useProjects();
  const send = useSendRequest(threadRef.environmentId);
  const projectRootByProjectId = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.workspaceRoot])),
    [projects],
  );
  const projectId = shell?.projectId ?? null;
  const title = shell?.title ?? "";
  const worktreePath = shell?.worktreePath ?? null;
  const source = useMemo<SendToAgentSource | null>(
    () =>
      projectId === null
        ? null
        : {
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
            terminalId: null,
            projectId,
            title,
            checkout: worktreePath ?? projectRootByProjectId.get(projectId) ?? "",
            messages,
            terminalHasText: false,
          },
    [messages, projectId, projectRootByProjectId, threadRef, title, worktreePath],
  );
  const newPanelProvidersFor = useCallback(() => newPanelProviders, [newPanelProviders]);
  if (source === null) return null;
  return (
    <SendToAgentButton
      source={source}
      serverSupported={props.serverSupported}
      rows={rows}
      projectRootByProjectId={projectRootByProjectId}
      newPanelProvidersFor={newPanelProvidersFor}
      canNotifyTerminal={canNotifyTerminal}
      previewContentFor={props.previewContentFor}
      send={send}
      createPanel={props.createPanel}
    />
  );
});
