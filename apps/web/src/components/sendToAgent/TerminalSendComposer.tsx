/**
 * The Send to agent control of one AI Terminal. It never writes to the terminal: the person's note
 * lives in the preview, and the terminal's text is only read (the selection when the person
 * chooses, the recent output from the server when the menu opens). Like the chat control, it reads
 * the agent list and the output only while the menu is open, so a closed control re-renders for
 * neither. A plain terminal is never given one.
 */
import type {
  DefaultAgentSelection,
  ScopedThreadRef,
  SendRequestsGetTerminalOutputInput,
  ThreadId,
} from "@bibcode/contracts";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useGetTerminalOutput, useSendRequest } from "~/state/sendRequests";
import { serverEnvironment } from "~/state/server";
import { useAgentRows } from "../agents/useAgentRows";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { SECOND_OPINION_LEAD_IN } from "./attachments.logic";
import { HAND_OFF_LEAD_IN } from "./handoff.logic";
import { resolveOutOfTokensHint } from "./outOfTokens.logic";
import { SendToAgentButton, type LiveSendInputs } from "./SendToAgentButton";
import type {
  NewPanelProvider,
  PreviewContent,
  SendChoice,
  SendToAgentSource,
} from "./sendToAgent.logic";
import {
  terminalAttachment,
  terminalHasText,
  type TerminalOutputText,
} from "./terminalSource.logic";

/** What the host chat supplies to every terminal control under it. */
export interface TerminalSendToAgentServices {
  readonly serverSupported: boolean;
  readonly newPanelProvidersFor: (action: SendChoice["action"]) => ReadonlyArray<NewPanelProvider>;
  readonly createPanel: (selection: DefaultAgentSelection) => Promise<ThreadId | null>;
  readonly revealPanel: (panel: ThreadId) => void;
  /** The content of Review, Message and Take over from; the terminal supplies the other two. */
  readonly previewContentFor: (choice: SendChoice) => PreviewContent | null;
}

export const TerminalSendToAgentContext = createContext<TerminalSendToAgentServices | null>(null);

const NO_ROWS: ReadonlyArray<AgentRow> = [];
const NO_MESSAGES: SendToAgentSource["messages"] = [];

// Until a terminal can be notified (task 9.2), no terminal is offered as a target.
const canNotifyTerminal = () => false;

type LoadOutput = () => Promise<TerminalOutputText | null>;

/** Mounted while the menu is open: the only reader of the agent directory and the output. */
function LiveTerminalInputsReader(props: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly base: SendToAgentSource;
  readonly readSelection: () => string;
  readonly loadOutput: LoadOutput;
  readonly render: (live: LiveSendInputs) => ReactNode;
}) {
  const { base, readSelection, loadOutput } = props;
  const rows = useAgentRows();
  const usage =
    useEnvironmentQuery(
      serverEnvironment.providerUsage({ environmentId: props.environmentId, input: {} }),
    ).data ?? null;
  const hintFor = useCallback(
    (row: AgentRow) => resolveOutOfTokensHint({ row, usage, now: new Date() }),
    [usage],
  );
  const [selection] = useState(readSelection);
  const hasSelection = terminalHasText(selection, null);
  // `undefined` while the output is loading, `null` when it could not be read.
  const [output, setOutput] = useState<TerminalOutputText | null | undefined>(undefined);
  useEffect(() => {
    if (hasSelection) return;
    let current = true;
    void loadOutput().then((loaded) => {
      if (current) setOutput(loaded);
    });
    return () => {
      current = false;
    };
  }, [hasSelection, loadOutput]);
  // Until the output is known the entries stay enabled, so they do not flash a reason.
  const hasText = hasSelection || output === undefined || terminalHasText(null, output);
  const source = useMemo(() => ({ ...base, terminalHasText: hasText }), [base, hasText]);
  return props.render({ source, rows, hintFor });
}

function TerminalSendComposerBody(props: {
  readonly services: TerminalSendToAgentServices;
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly readSelection: () => string;
}) {
  const { services, threadRef, terminalId, terminalLabel, readSelection } = props;
  const { environmentId, threadId } = threadRef;
  const shell = useThreadShell(threadRef);
  const projects = useProjects();
  const send = useSendRequest(environmentId);
  const getTerminalOutput = useGetTerminalOutput(environmentId);
  const projectRootByProjectId = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.workspaceRoot])),
    [projects],
  );
  const projectId = shell?.projectId ?? null;
  const worktreePath = shell?.worktreePath ?? null;
  const source = useMemo<SendToAgentSource | null>(
    () =>
      projectId === null
        ? null
        : {
            environmentId,
            threadId,
            terminalId,
            projectId,
            title: terminalLabel,
            checkout: worktreePath ?? projectRootByProjectId.get(projectId) ?? "",
            messages: NO_MESSAGES,
            terminalHasText: false,
          },
    [
      environmentId,
      projectId,
      projectRootByProjectId,
      terminalId,
      terminalLabel,
      threadId,
      worktreePath,
    ],
  );
  // The output read of the latest menu open; a preview chosen from it waits on the same read.
  const outputRef = useRef<ReturnType<LoadOutput> | null>(null);
  const loadOutput = useCallback<LoadOutput>(() => {
    const input: SendRequestsGetTerminalOutputInput = {
      sourceThreadId: threadId,
      threadId,
      terminalId,
      source: "output",
      part: "handoff",
    };
    const read = getTerminalOutput(input)
      .then((result): TerminalOutputText => result)
      .catch(() => null);
    outputRef.current = read;
    return read;
  }, [getTerminalOutput, terminalId, threadId]);

  const { previewContentFor: baseContentFor } = services;
  const previewContentFor = useCallback(
    (choice: SendChoice): PreviewContent | null => {
      const ownChoice =
        choice.source.threadId === threadId && choice.source.terminalId === terminalId;
      if (!ownChoice || (choice.action !== "second-opinion" && choice.action !== "hand-off")) {
        return baseContentFor(choice);
      }
      const leadIn = choice.action === "second-opinion" ? SECOND_OPINION_LEAD_IN : HAND_OFF_LEAD_IN;
      const selection = readSelection();
      if (terminalHasText(selection, null)) {
        const attachment = terminalAttachment({ selection, output: null, terminalLabel });
        return { leadIn, attachments: attachment === null ? [] : [attachment] };
      }
      return {
        leadIn,
        attachments: [],
        loadAttachments: async () => {
          const output = await (outputRef.current ?? loadOutput());
          const attachment = terminalAttachment({ selection: null, output, terminalLabel });
          return attachment === null ? [] : [attachment];
        },
      };
    },
    [baseContentFor, loadOutput, readSelection, terminalId, terminalLabel, threadId],
  );

  const renderLive = useCallback(
    (render: (live: LiveSendInputs) => ReactNode) =>
      source === null ? null : (
        <LiveTerminalInputsReader
          environmentId={environmentId}
          base={source}
          readSelection={readSelection}
          loadOutput={loadOutput}
          render={render}
        />
      ),
    [environmentId, loadOutput, readSelection, source],
  );
  if (source === null) return null;
  return (
    <SendToAgentButton
      source={source}
      serverSupported={services.serverSupported}
      rows={NO_ROWS}
      renderLive={renderLive}
      projectRootByProjectId={projectRootByProjectId}
      newPanelProvidersFor={services.newPanelProvidersFor}
      canNotifyTerminal={canNotifyTerminal}
      previewContentFor={previewContentFor}
      send={send}
      createPanel={services.createPanel}
      revealPanel={services.revealPanel}
    />
  );
}

export const TerminalSendComposer = memo(function TerminalSendComposer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly terminalLabel: string;
  /** The terminal's current selection, normalized; empty when nothing is selected. */
  readonly readSelection: () => string;
}) {
  const services = useContext(TerminalSendToAgentContext);
  return services === null ? null : <TerminalSendComposerBody services={services} {...props} />;
});
