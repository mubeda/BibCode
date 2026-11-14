/**
 * The Send to agent control of one chat panel. It reads the panel's shell and the sender itself, so
 * that ChatView and the memoized composer footer see none of their changes: the footer's slot is
 * one stable element. The panel's messages and the agent list change with every streamed token and
 * every agent; they are read only while the menu is open, so a closed control re-renders for
 * neither. A chosen preview keeps the source it was chosen with.
 */
import type { DefaultAgentSelection, ScopedThreadRef, ThreadId } from "@bibcode/contracts";
import { memo, useCallback, useMemo, type ReactNode } from "react";

import { useProjects, useThreadMessages, useThreadShell } from "~/state/entities";
import { useSendRequest } from "~/state/sendRequests";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { useAgentRows } from "../agents/useAgentRows";
import { SendToAgentButton, type LiveSendInputs } from "./SendToAgentButton";
import type {
  NewPanelProvider,
  PreviewContent,
  SendChoice,
  SendToAgentSource,
} from "./sendToAgent.logic";

const NO_ROWS: ReadonlyArray<AgentRow> = [];
const NO_MESSAGES: SendToAgentSource["messages"] = [];

// Until terminals can be notified (phase 9), no terminal is offered as a target.
const canNotifyTerminal = () => false;

/** Mounted while the menu is open: the only reader of the messages and the agent directory. */
function LiveSendInputsReader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly base: SendToAgentSource;
  readonly render: (live: LiveSendInputs) => ReactNode;
}) {
  const messages = useThreadMessages(props.threadRef);
  const rows = useAgentRows();
  const source = useMemo(() => ({ ...props.base, messages }), [messages, props.base]);
  return props.render({ source, rows });
}

export const ChatSendToAgentControl = memo(function ChatSendToAgentControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly serverSupported: boolean;
  readonly newPanelProvidersFor: (action: SendChoice["action"]) => ReadonlyArray<NewPanelProvider>;
  readonly createPanel: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
  readonly previewContentFor: (choice: SendChoice) => PreviewContent | null;
}) {
  const { threadRef, newPanelProvidersFor } = props;
  const shell = useThreadShell(threadRef);
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
            messages: NO_MESSAGES,
            terminalHasText: false,
          },
    [projectId, projectRootByProjectId, threadRef, title, worktreePath],
  );
  const renderLive = useCallback(
    (render: (live: LiveSendInputs) => ReactNode) =>
      source === null ? null : (
        <LiveSendInputsReader threadRef={threadRef} base={source} render={render} />
      ),
    [source, threadRef],
  );
  if (source === null) return null;
  return (
    <SendToAgentButton
      source={source}
      serverSupported={props.serverSupported}
      rows={NO_ROWS}
      renderLive={renderLive}
      projectRootByProjectId={projectRootByProjectId}
      newPanelProvidersFor={newPanelProvidersFor}
      canNotifyTerminal={canNotifyTerminal}
      previewContentFor={props.previewContentFor}
      send={send}
      createPanel={props.createPanel}
    />
  );
});
