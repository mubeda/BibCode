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
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import { useSendToAgentStore } from "~/sendToAgentStore";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useGetTerminalOutput, useSendRequest, useSendRequests } from "~/state/sendRequests";
import { serverEnvironment } from "~/state/server";
import { useAgentTerminalSources } from "../../hooks/useAgentFreshness";
import { useAgentRows } from "../agents/useAgentRows";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { SECOND_OPINION_LEAD_IN } from "./attachments.logic";
import { HAND_OFF_LEAD_IN, TERMINAL_START_MISSING_NOTE } from "./handoff.logic";
import { resolveOutOfTokensHint } from "./outOfTokens.logic";
import { selectRowsForTerminal } from "./SendRequestRow";
import { SendToAgentButton, type LiveSendInputs } from "./SendToAgentButton";
import { TerminalSendRequests } from "./TerminalSendRequests";
import {
  canNotifyTerminalRow,
  sendChoiceKey,
  type NewPanelProvider,
  type PreviewAttachment,
  type PreviewContent,
  type SendChoice,
  type SendToAgentSource,
} from "./sendToAgent.logic";
import {
  TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
  TERMINAL_OUTPUT_LOADING_MESSAGE,
  terminalAttachment,
  terminalHasText,
  type TerminalOutputText,
} from "./terminalSource.logic";

export { TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE };

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
  /** Open the target of a request, as the chat's request rows do. */
  readonly openSendTarget: (target: ScopedThreadRef) => void;
  readonly cancelSendRequest: (requestId: string) => Promise<void>;
  readonly dismissSendRequest: (requestId: string) => Promise<void>;
}

export const TerminalSendToAgentContext = createContext<TerminalSendToAgentServices | null>(null);

const NO_ROWS: ReadonlyArray<AgentRow> = [];

const NO_MESSAGES: SendToAgentSource["messages"] = [];

// The closed control lists no rows; the open menu reads terminal state for the real answer.
const canNotifyTerminal = () => false;

/**
 * Whether a terminal row of `environmentId` can be notified of a request, from its live terminal
 * summary. Call it only in a component mounted while the menu is open.
 */
export function useCanNotifyTerminal(
  environmentId: ScopedThreadRef["environmentId"],
): (row: Pick<AgentRow, "ref" | "terminalId">) => boolean {
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const sources = useAgentTerminalSources(environmentIds);
  return useCallback(
    (row: Pick<AgentRow, "ref" | "terminalId">) =>
      canNotifyTerminalRow(
        sources
          .find((source) => source.environmentId === row.ref.environmentId)
          ?.rows.find(
            (summary) =>
              summary.threadId === row.ref.threadId && summary.terminalId === row.terminalId,
          ),
      ),
    [sources],
  );
}

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
  const canNotifyTerminal = useCanNotifyTerminal(props.environmentId);
  // Take over from goes to this terminal itself, so it needs this terminal to be notifiable.
  const terminalNotifiable = canNotifyTerminal({
    ref: { environmentId: base.environmentId, threadId: base.threadId },
    terminalId: base.terminalId,
  });
  const source = useMemo(
    () => ({ ...base, terminalHasText: hasText, terminalNotifiable }),
    [base, hasText, terminalNotifiable],
  );
  return props.render({ source, rows, hintFor, canNotifyTerminal });
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
  // A terminal source's answers wait on its control, the only place the person acts from it.
  const requests = useSendRequests(environmentId);
  const terminalRequests = useMemo(
    () => selectRowsForTerminal(requests, threadId, terminalId),
    [requests, terminalId, threadId],
  );
  const waitingAnswers = useMemo(
    () => terminalRequests.filter((request) => request.state === "answered").length,
    [terminalRequests],
  );
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
  const read = useCallback(
    (
      source: SendRequestsGetTerminalOutputInput["source"],
      part: SendRequestsGetTerminalOutputInput["part"],
    ): Promise<TerminalRead> =>
      getTerminalOutput({ sourceThreadId: threadId, threadId, terminalId, source, part }),
    [getTerminalOutput, terminalId, threadId],
  );
  // Opening the menu only asks whether the terminal has text; the conversation is read only for
  // the Second opinion or Hand off the person chose.
  const loadOutput = useCallback<LoadOutput>(() => read("output", "handoff"), [read]);

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
        loadFailedMessage: TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
        loadingMessage: TERMINAL_OUTPUT_LOADING_MESSAGE,
        loadAttachments: async () => {
          const output = await read(
            "conversation",
            choice.action === "second-opinion" ? "last-answer" : "handoff",
          );
          const attachment = readAttachment(output, terminalLabel);
          return attachment === null ? [] : [attachment];
        },
      };
    },
    [baseContentFor, read, readSelection, terminalId, terminalLabel, threadId],
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
  // Bring back opens the control's menu with the quoted answer as the Message note: the person
  // copies it or picks an agent to send it on to. Nothing reaches the terminal.
  const [signal, setSignal] = useState({ terminalId, count: 0 });
  // The signal belongs to the terminal it was raised for; another terminal starts from zero.
  if (signal.terminalId !== terminalId) setSignal({ terminalId, count: 0 });
  const openSignal = signal.terminalId === terminalId ? signal.count : 0;
  const bringBack = useCallback(
    (text: string) => {
      if (source === null) return;
      const key = sendChoiceKey({ source, action: "message" });
      const store = useSendToAgentStore.getState();
      const typed = store.notes[key] ?? "";
      store.setNote(key, typed === "" ? text : `${typed}\n\n${text}`);
      setSignal((current) => ({
        terminalId,
        count: (current.terminalId === terminalId ? current.count : 0) + 1,
      }));
    },
    [source, terminalId],
  );
  const controlRef = useRef<HTMLSpanElement | null>(null);
  const focusControl = useCallback(() => {
    controlRef.current?.querySelector<HTMLElement>('button[aria-label^="Send to agent"]')?.focus();
  }, []);
  if (source === null) return null;
  return (
    <span ref={controlRef} className="contents">
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
        waitingAnswers={waitingAnswers}
        openSignal={openSignal}
      />
      <TerminalSendRequests
        key={terminalId}
        restoreFocus={focusControl}
        threadRef={threadRef}
        requests={terminalRequests}
        onOpen={services.openSendTarget}
        onCancel={services.cancelSendRequest}
        onDismiss={services.dismissSendRequest}
        onBringBack={bringBack}
      />
    </span>
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
