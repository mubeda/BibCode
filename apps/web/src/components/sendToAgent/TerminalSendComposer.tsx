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
  type RefObject,
} from "react";

import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useGetTerminalOutput, useSendRequest } from "~/state/sendRequests";
import { serverEnvironment } from "~/state/server";
import { useAgentRows } from "../agents/useAgentRows";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { SECOND_OPINION_LEAD_IN } from "./attachments.logic";
import { HAND_OFF_LEAD_IN, TERMINAL_START_MISSING_NOTE } from "./handoff.logic";
import { resolveOutOfTokensHint } from "./outOfTokens.logic";
import { SendToAgentButton, type LiveSendInputs } from "./SendToAgentButton";
import type {
  NewPanelProvider,
  PreviewAttachment,
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
  /** `sourceUnmountsOnActivate` keeps the new panel inactive until `revealPanel`. */
  readonly createPanel: (
    selection: DefaultAgentSelection,
    options?: { readonly sourceUnmountsOnActivate: boolean },
  ) => Promise<ThreadId | null>;
  readonly revealPanel: (panel: ThreadId) => void;
  /** The content of Review, Message and Take over from; the terminal supplies the other two. */
  readonly previewContentFor: (choice: SendChoice) => PreviewContent | null;
}

export const TerminalSendToAgentContext = createContext<TerminalSendToAgentServices | null>(null);

const NO_ROWS: ReadonlyArray<AgentRow> = [];
const NO_MESSAGES: SendToAgentSource["messages"] = [];

// Until a terminal can be notified (task 9.2), no terminal is offered as a target.
const canNotifyTerminal = () => false;

/** The output, or the CLI's conversation when the server could read it. */
interface TerminalRead extends TerminalOutputText {
  /** The conversation was asked for and could not be read, so the output is used. */
  fellBack: boolean;
  /** The conversation read did not reach its start (a long Codex thread). */
  startMissing: boolean;
}

/** Rejects when the output could not be read. */
type LoadOutput = () => Promise<TerminalRead>;

/**
 * The attachment of a terminal read, saying when the output stood in for the conversation. The
 * server already bounds a conversation (the handoff text, or one answer), so it is attached whole:
 * cutting its start would drop the newest messages.
 */
function readAttachment(output: TerminalRead, terminalLabel: string): PreviewAttachment | null {
  if (output.usedSource === "conversation") {
    return output.text.trim() === ""
      ? null
      : {
          id: "terminal-output",
          label: `Conversation of ${terminalLabel}`,
          text: output.text,
          leftOut: null,
          note: output.startMissing ? TERMINAL_START_MISSING_NOTE : null,
        };
  }
  const attachment = terminalAttachment({ selection: null, output, terminalLabel });
  if (attachment === null || !output.fellBack) return attachment;
  return {
    ...attachment,
    label: `Recent output of ${terminalLabel}, because the conversation could not be read`,
  };
}

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
  // `undefined` while the output is loading, `"failed"` when it could not be read.
  const [output, setOutput] = useState<TerminalOutputText | "failed" | undefined>(undefined);
  useEffect(() => {
    if (hasSelection) return;
    let current = true;
    loadOutput().then(
      (loaded) => {
        if (current) setOutput(loaded);
      },
      () => {
        if (current) setOutput("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [hasSelection, loadOutput]);
  // Loading and failed keep the entries enabled: only a read that found nothing says so. A failed
  // read shows the preview's error and Retry when an entry is chosen.
  const hasText = hasSelection || typeof output !== "object" || terminalHasText(null, output);
  const source = useMemo(() => ({ ...base, terminalHasText: hasText }), [base, hasText]);
  return props.render({ source, rows, hintFor });
}

function TerminalSendComposerBody(props: {
  readonly services: TerminalSendToAgentServices;
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly terminalLabel: string;
  readonly readSelection: () => string;
  readonly viewportFocusTarget: (() => HTMLElement | null) | undefined;
  readonly inCenterPanel: boolean;
}) {
  const {
    services,
    threadRef,
    terminalId,
    terminalLabel,
    readSelection,
    viewportFocusTarget,
    inCenterPanel,
  } = props;
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
  // The read of the latest menu open (the conversation's handoff text, else the output); a
  // preview chosen from it waits on the same read.
  const outputRef = useRef<ReturnType<LoadOutput> | null>(null);
  const readTerminal = useCallback(
    (part: SendRequestsGetTerminalOutputInput["part"]): Promise<TerminalRead> =>
      getTerminalOutput({
        sourceThreadId: threadId,
        threadId,
        terminalId,
        source: "conversation",
        part,
      }),
    [getTerminalOutput, terminalId, threadId],
  );
  const loadOutput = useCallback<LoadOutput>(() => {
    const read = readTerminal("handoff");
    outputRef.current = read;
    return read;
  }, [readTerminal]);

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
          const read = outputRef.current ?? loadOutput();
          // A failed read is not reused: Retry reads again.
          const shared = await read.catch((error: unknown) => {
            if (outputRef.current === read) outputRef.current = null;
            throw error;
          });
          // A Second opinion attaches the conversation's last answer; output has no such part.
          const output =
            choice.action === "second-opinion" && shared.usedSource === "conversation"
              ? await readTerminal("last-answer")
              : shared;
          const attachment = readAttachment(output, terminalLabel);
          return attachment === null ? [] : [attachment];
        },
      };
    },
    [baseContentFor, loadOutput, readSelection, readTerminal, terminalId, terminalLabel, threadId],
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
  const createPanel = useCallback(
    (selection: DefaultAgentSelection) =>
      services.createPanel(selection, { sourceUnmountsOnActivate: inCenterPanel }),
    [inCenterPanel, services],
  );
  // Closing the preview gives focus back to the terminal's viewport, never to its input.
  const viewportFocus = useMemo<RefObject<HTMLElement | null> | undefined>(
    () =>
      viewportFocusTarget === undefined
        ? undefined
        : {
            get current() {
              return viewportFocusTarget();
            },
          },
    [viewportFocusTarget],
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
      createPanel={createPanel}
      {...(viewportFocus === undefined ? {} : { finalFocus: viewportFocus })}
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
  /** The terminal's focusable viewport; the preview returns focus to it. */
  readonly viewportFocusTarget?: () => HTMLElement | null;
  /** The terminal lives in the center panel, where activating another panel unmounts it. */
  readonly inCenterPanel?: boolean;
}) {
  const services = useContext(TerminalSendToAgentContext);
  return services === null ? null : (
    <TerminalSendComposerBody
      services={services}
      threadRef={props.threadRef}
      terminalId={props.terminalId}
      terminalLabel={props.terminalLabel}
      readSelection={props.readSelection}
      viewportFocusTarget={props.viewportFocusTarget}
      inCenterPanel={props.inCenterPanel ?? false}
    />
  );
});
