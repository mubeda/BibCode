import {
  ACTIVITY_PAGE_MAX_LENGTH,
  type ActivityScopeRef,
  type EnvironmentId,
  type MessageId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@bibcode/contracts";
import { type ChatMessage, type SessionPhase, type Thread } from "../types";
import { type ComposerAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "bibcode:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

type ActivitySurfaceScope =
  | { readonly _tag: "thread" }
  | { readonly _tag: "terminal"; readonly terminalId: string };

export function isAgentActivityScopeEnabled(
  scope: ActivityScopeRef,
  settings: {
    readonly enableChatAgentActivity: boolean;
    readonly enableTerminalAgentActivity: boolean;
  },
): boolean {
  return scope._tag === "terminal"
    ? settings.enableTerminalAgentActivity
    : settings.enableChatAgentActivity;
}

export function resolveActivityScope(
  activeThreadRef: ScopedThreadRef | null,
  surfaceScope: ActivitySurfaceScope,
): ActivityScopeRef | null {
  if (activeThreadRef === null) {
    return null;
  }
  return surfaceScope._tag === "terminal"
    ? {
        _tag: "terminal",
        threadId: activeThreadRef.threadId,
        terminalId: surfaceScope.terminalId,
      }
    : { _tag: "thread", threadId: activeThreadRef.threadId };
}

type ActivityPageLike =
  | {
      readonly records: ReadonlyArray<unknown>;
      readonly nextCursor: string | null;
    }
  | {
      readonly entries: ReadonlyArray<unknown>;
      readonly nextCursor: string | null;
    };

export interface KeyedActivityPage<Page> {
  readonly cursor: string | null;
  readonly page: Page;
}

function activityPageItemCount(page: ActivityPageLike): number {
  return "records" in page ? page.records.length : page.entries.length;
}

function trimActivityPageStart<Page extends ActivityPageLike>(page: Page, count: number): Page {
  if ("records" in page) {
    return {
      ...page,
      records: page.records.slice(count),
    } as Page;
  }
  return {
    ...page,
    entries: page.entries.slice(count),
  } as Page;
}

export function reconcileBoundedActivityPages<Page extends ActivityPageLike>(
  current: ReadonlyArray<KeyedActivityPage<Page>>,
  cursor: string | null,
  incoming: Page,
): ReadonlyArray<KeyedActivityPage<Page>> {
  const existingIndex = current.findIndex((entry) => entry.cursor === cursor);
  const candidates =
    existingIndex < 0
      ? [...current, { cursor, page: incoming }]
      : current.map((entry, index) =>
          index === existingIndex ? { cursor, page: incoming } : entry,
        );
  const totalItems = candidates.reduce(
    (count, candidate) => count + activityPageItemCount(candidate.page),
    0,
  );
  let overflow = Math.max(0, totalItems - ACTIVITY_PAGE_MAX_LENGTH);
  const bounded: Array<KeyedActivityPage<Page>> = [];

  for (const candidate of candidates) {
    const itemCount = activityPageItemCount(candidate.page);
    if (overflow >= itemCount) {
      overflow -= itemCount;
      continue;
    }
    if (overflow > 0) {
      bounded.push({
        cursor: candidate.cursor,
        page: trimActivityPageStart(candidate.page, overflow),
      });
      overflow = 0;
      continue;
    }
    bounded.push(candidate);
  }
  return bounded;
}

export function resolveActivityPageLoadAction(input: {
  readonly currentCursor: string | null;
  readonly nextCursor: string | null;
  readonly failed: boolean;
}): "refresh" | "select" {
  return input.nextCursor === null || (input.failed && input.currentCursor === input.nextCursor)
    ? "refresh"
    : "select";
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function resolveCenterPanelLaunchContext(input: {
  readonly hasServerThread: boolean;
  readonly envMode: DraftThreadEnvMode;
  readonly projectCwd: string | null;
  readonly worktreePath: string | null;
}): { readonly cwd: string; readonly worktreePath: string | null } | null {
  if (!input.hasServerThread || input.projectCwd === null) {
    return null;
  }
  if (input.envMode === "worktree") {
    return input.worktreePath === null
      ? null
      : { cwd: input.worktreePath, worktreePath: input.worktreePath };
  }
  return { cwd: input.projectCwd, worktreePath: null };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read attachment data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerAttachmentForRetry(
  attachment: ComposerAttachment,
): ComposerAttachment {
  if (
    attachment.type !== "image" ||
    typeof URL === "undefined" ||
    !attachment.previewUrl.startsWith("blob:")
  ) {
    return attachment;
  }
  try {
    return {
      ...attachment,
      previewUrl: URL.createObjectURL(attachment.file),
    };
  } catch {
    return attachment;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// Both provider inputs are open branded driver slugs. Callers should resolve a
// bound instance id to its live driver before passing `threadProvider`; an
// unresolved exact-instance binding must stay separate rather than being
// rebranded as a driver kind because the two open slug namespaces can collide.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  threadId: ThreadId | null;
  messageId: MessageId | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function findLastCancellableDeliveryMessage(
  messages: ReadonlyArray<ChatMessage>,
): ChatMessage | null {
  return (
    messages.findLast(
      (message) => message.delivery?.state === "pending" || message.delivery?.state === "sending",
    ) ?? null
  );
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean; threadId?: ThreadId; messageId?: MessageId },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    threadId: options?.threadId ?? activeThread?.id ?? null,
    messageId: options?.messageId ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
  deliveryState?: NonNullable<ChatMessage["delivery"]>["state"] | null;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (
    input.deliveryState === "failed" ||
    input.deliveryState === "uncertain" ||
    input.deliveryState === "dismissed"
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
