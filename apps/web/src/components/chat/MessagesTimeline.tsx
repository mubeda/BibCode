import { QueuedMessageTimelineRow } from "./QueuedMessageTimelineRow";
import { AttachmentUploadNotice, type PendingAttachmentUpload } from "./AttachmentUploadNotice";
import { deliveryProviderLabel, waitsBehind, type QueuedCardStatus } from "../ChatView.logic";
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationReasoning,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from "@bibcode/contracts";
import { parseScopedThreadKey } from "@bibcode/client-runtime/environment";
import { reasoningLabel, reasoningPreview } from "@bibcode/client-runtime/state/reasoning";
import { resolveChatListAnchoredEndSpace } from "@bibcode/shared/chatList";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListMetrics, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import {
  deriveTimelineEntries,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDeliveryResolutionAction, type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  EyeIcon,
  FileIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import {
  holdTimelineReadingPosition,
  preserveTimelineReadingPosition,
  ReadingAnchorContext,
  type ReadingAnchor,
} from "./readingAnchor";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { TurnDeliveryNotice } from "./TurnDeliveryNotice";
import {
  applyTimelineDisclosureChange,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveUnsettledTurnId,
  detailsDisclosureKey,
  detailsOpenForScope,
  EMPTY_TIMELINE_DISCLOSURES,
  type EntryDisclosure,
  MESSAGE_BODY_DISCLOSURE_KEY,
  normalizeCompactToolLabel,
  PROPOSED_PLAN_DISCLOSURE_KEY,
  type TimelineDisclosureChange,
  type TimelineDisclosures,
  toolCallDisplayedCommand,
  TOOL_ROW_DISCLOSURE_KEY,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  resolveTimelineMaintainScrollAtEnd,
  resolveTimelineMaintainVisibleContentPosition,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapStepTargets,
  resolveTimelineMinimapTopPercent,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_JUMP_OFFSET,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
  type TimelineMinimapStep,
} from "./MessagesTimeline.logic";
import { timelineScrollAnimates } from "./timelineScrollAnchoring";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { ThreadFind } from "./threadFind/ThreadFindBar";
import type { ThreadFindInput } from "./threadFind/useThreadFind";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { type ParsedElementContextEntry } from "~/lib/elementContext";
import { type ParsedPreviewAnnotation } from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@bibcode/contracts/settings";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { formatMemoryBytes as formatBytes } from "../status-bar/statusBarFormat";

import { buildInlineTerminalContextText } from "./userMessageTerminalContexts";
import {
  deriveSentUserMessageBody,
  deriveUserMessageBodyLayout,
  shouldCollapseUserMessage,
  userMessageMarkdownParts,
  type UserMessageMarkdownPart,
} from "./userMessageBody";
import {
  ASSISTANT_MESSAGE_FIND_SCOPE,
  markdownFindScope,
  PLAN_BODY_FIND_SCOPE,
  TOOL_COMMAND_FIND_SCOPE,
} from "./threadFind/threadFindScopes";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onResolveTurnDelivery: (messageId: MessageId, action: TurnDeliveryResolutionAction) => void;
  resolvingTurnDeliveryMessageId: MessageId | null;
  blockingDelivery:
    | (Pick<TimelineMessage, "id" | "createdAt"> & { readonly offersRetry: boolean })
    | null;
  /** The failed message a context-limit recovery sends again once the compaction succeeds. */
  compactionFailedMessageId: MessageId | null;
  instanceLabels: ReadonlyMap<ProviderInstanceId, string>;
  onSteerQueuedMessage: (messageId: MessageId) => void;
  onSendNowQueuedMessage: (messageId: MessageId) => void;
  onCancelQueuedMessage: (messageId: MessageId) => void;
  resolvingQueuedMessageId: MessageId | null;
  queuedMessageErrors: Readonly<Record<string, string>>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  /** `expanded` is what the row shows now; the toggle flips it. */
  onToggleTurnFold: (turnId: TurnId, expanded: boolean) => void;
  onToggleWorkGroup: (groupId: string, expanded: boolean, anchorElement?: HTMLElement) => void;
  /** Sets one of an entry's own disclosures: its tool row, long body, plan or a details block. */
  onSetEntryDisclosure: (entryId: string, key: string, open: boolean) => void;
  /** A Thinking row was expanded or collapsed: the owner keeps the end in view if it was. */
  onReasoningRowToggle: () => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
  unsettledTurnId: TurnId | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const AttachmentUploadCtx = createContext<{
  readonly uploads: Readonly<Record<string, PendingAttachmentUpload>>;
  readonly onCancel: (messageId: MessageId) => void;
}>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
// LegendList includes numeric padding in its initial end target. A measured footer leaves one
// painted WebView2 remount frame 16 px short while its layout catches up.
const TIMELINE_LIST_CONTENT_STYLE = { paddingBottom: 16 };
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const NO_MINIMAP_STEP_TARGETS: TimelineMinimapStepTargets = { previous: null, next: null };

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  attachmentUploads: Readonly<Record<string, PendingAttachmentUpload>>;
  onCancelAttachmentUpload: (messageId: MessageId) => void;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  /** Called with the list once it mounts, and with null once it unmounts. */
  onListMount?: (list: LegendListRef | null) => void;
  /**
   * Whether the timeline follows its end. False once the reader has scrolled away, so a change
   * in the bottom region's height leaves the line they read in place. Defaults to true.
   */
  followsEnd?: boolean;
  /**
   * Whether a scroll key's native scroll may still be about to start, during which LegendList
   * keeps no content position, since a scroll of its own would cancel the key's (#207).
   */
  nativeScrollPending?: boolean;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  queuedMessages: ReadonlyArray<TimelineMessage>;
  queuedStatuses: ReadonlyArray<QueuedCardStatus>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onResolveTurnDelivery: (messageId: MessageId, action: TurnDeliveryResolutionAction) => void;
  resolvingTurnDeliveryMessageId: MessageId | null;
  blockingDelivery: TimelineRowSharedState["blockingDelivery"];
  compactionFailedMessageId?: MessageId | null;
  instanceLabels: ReadonlyMap<ProviderInstanceId, string>;
  onSteerQueuedMessage: (messageId: MessageId) => void;
  onSendNowQueuedMessage: (messageId: MessageId) => void;
  onCancelQueuedMessage: (messageId: MessageId) => void;
  resolvingQueuedMessageId: MessageId | null;
  queuedMessageErrors: Readonly<Record<string, string>>;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  verboseChat: boolean;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  /** A row's measured height changed; `previous` is its height before. */
  onRowSizeChanged?: (info: {
    readonly index: number;
    readonly previous: number;
    readonly size: number;
  }) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: () => void;
  /** The server thread Find in thread reports the load state of; null for a draft. */
  findThreadRef?: ScopedThreadRef | null;
  /** The chat surface's root, so Mod+F inside it opens this timeline's find. */
  findSurfaceRoot?: HTMLElement | null;
  isHostFindSurface?: boolean;
  /** Closing find returns focus to the composer. */
  onFindFocusComposer?: () => void;
  onReasoningRowToggle: () => void;
}

const NO_FIND_FOCUS = () => {};

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  attachmentUploads,
  onCancelAttachmentUpload,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  onListMount,
  followsEnd = true,
  nativeScrollPending = false,
  timelineEntries,
  queuedMessages,
  queuedStatuses,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onResolveTurnDelivery,
  resolvingTurnDeliveryMessageId,
  blockingDelivery,
  compactionFailedMessageId = null,
  instanceLabels,
  onSteerQueuedMessage,
  onSendNowQueuedMessage,
  onCancelQueuedMessage,
  resolvingQueuedMessageId,
  queuedMessageErrors,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  verboseChat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  onRowSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  onManualNavigation,
  findThreadRef = null,
  findSurfaceRoot = null,
  isHostFindSurface = false,
  onFindFocusComposer = NO_FIND_FOCUS,
  onReasoningRowToggle,
}: MessagesTimelineProps) {
  const [disclosures, setDisclosures] = useState<TimelineDisclosures>(EMPTY_TIMELINE_DISCLOSURES);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());

  const changeDisclosures = useCallback((change: TimelineDisclosureChange) => {
    setDisclosures((current) => applyTimelineDisclosureChange(current, change));
  }, []);
  // A toggle flips what the row shows, which Verbose chat opens by default.
  const onToggleTurnFold = useCallback(
    (turnId: TurnId, expanded: boolean) => changeDisclosures({ turns: [[turnId, !expanded]] }),
    [changeDisclosures],
  );
  const onSetEntryDisclosure = useCallback(
    (entryId: string, key: string, open: boolean) =>
      changeDisclosures({ entries: [[entryId, key, open]] }),
    [changeDisclosures],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, expanded: boolean, anchorElement?: HTMLElement) => {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null;

      flushSync(() => {
        changeDisclosures({ groups: [[groupId, !expanded]] });
      });

      if (anchorBottomBeforeToggle === null || !anchorElement) {
        return;
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle;
      if (Math.abs(delta) < 0.5) {
        return;
      }

      const list = listRef.current;
      const currentScroll = list?.getState?.().scroll;
      if (list && typeof currentScroll === "number") {
        list.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [changeDisclosures, listRef],
  );

  useFoldPreviousTurnOnNewTurn(latestTurn, setDisclosures);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        queuedMessages,
        queuedStatuses,
        latestTurn,
        runningTurnId,
        turnFoldChoices: disclosures.turns,
        workGroupChoices: disclosures.groups,
        entryDisclosures: disclosures.entries,
        verboseChat,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      queuedMessages,
      queuedStatuses,
      latestTurn,
      runningTurnId,
      disclosures,
      verboseChat,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapStepTargets, setMinimapStepTargets] = useState(NO_MINIMAP_STEP_TARGETS);
  const { listHeaderSize, onListMetricsChange } = useListHeaderSize();
  const { handleAnchorReady, handleAnchorSizeChanged } = useStableAnchorCallbacks(
    anchorMessageId,
    onAnchorReady,
    onAnchorSizeChanged,
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === "message" ? row.message.id : null,
    );
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined;
  }, [anchorMessageId, handleAnchorReady, handleAnchorSizeChanged, rows]);
  const readingAnchor = useTimelineReadingAnchor(listRef, timelineViewportElement);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);
    const itemTops: Array<number | null> = [];

    for (const item of minimapItems) {
      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      itemTops.push(rowTop);
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }

    // Changes only when the reading position crosses a turn, so scrolling within one renders nothing.
    const nextStepTargets = resolveTimelineMinimapStepTargets({
      itemTops,
      scrollTop,
      maxScrollTop: Math.max(
        0,
        (state.contentLength ?? Number.POSITIVE_INFINITY) - (state.scrollLength ?? 0),
      ),
      listStartOffset: listHeaderSize,
    });
    setMinimapStepTargets((current) =>
      current.previous === nextStepTargets.previous && current.next === nextStepTargets.next
        ? current
        : nextStepTargets,
    );
  }, [listHeaderSize, listRef, minimapItems, minimapStripMap, onIsAtEndChange]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onResolveTurnDelivery,
      resolvingTurnDeliveryMessageId,
      blockingDelivery,
      compactionFailedMessageId,
      instanceLabels,
      onSteerQueuedMessage,
      onSendNowQueuedMessage,
      onCancelQueuedMessage,
      resolvingQueuedMessageId,
      queuedMessageErrors,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onSetEntryDisclosure,
      onReasoningRowToggle,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onResolveTurnDelivery,
      resolvingTurnDeliveryMessageId,
      blockingDelivery,
      compactionFailedMessageId,
      instanceLabels,
      onSteerQueuedMessage,
      onSendNowQueuedMessage,
      onCancelQueuedMessage,
      resolvingQueuedMessageId,
      queuedMessageErrors,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onSetEntryDisclosure,
      onReasoningRowToggle,
    ],
  );
  const unsettledTurnId = deriveUnsettledTurnId(latestTurn, runningTurnId);
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
      unsettledTurnId,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking, unsettledTurnId],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  // The bottom inset LegendList lays the list out with. It grows with the bottom region only
  // while the timeline follows its end: LegendList scrolls by an inset's growth whenever the list
  // sits within its end threshold, which would move a reader who scrolled away. While they are
  // away it shrinks with the region but does not grow, until they return to the end.
  const [listInsetEnd, setListInsetEnd] = useState(contentInsetEndAdjustment);
  if (
    followsEnd
      ? listInsetEnd !== contentInsetEndAdjustment
      : contentInsetEndAdjustment < listInsetEnd
  ) {
    setListInsetEnd(contentInsetEndAdjustment);
  }

  // The list's ref, and the parent's word that it mounted or unmounted.
  const handleListRef = useCallback(
    (list: LegendListRef | null) => {
      listRef.current = list;
      onListMount?.(list);
    },
    [listRef, onListMount],
  );

  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div
        className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip"
        data-timeline-root="true"
        data-text-surface="background"
      >
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  const attachmentUploadState = useMemo(
    () => ({ uploads: attachmentUploads, onCancel: onCancelAttachmentUpload }),
    [attachmentUploads, onCancelAttachmentUpload],
  );
  const findInput = useMemo<ThreadFindInput>(
    () => ({
      timelineEntries,
      queuedMessages,
      queuedStatuses,
      latestTurn,
      runningTurnId,
      verboseChat,
      skills,
      cwd: markdownCwd,
      disclosures,
      rows,
    }),
    [
      disclosures,
      latestTurn,
      markdownCwd,
      queuedMessages,
      queuedStatuses,
      rows,
      runningTurnId,
      skills,
      timelineEntries,
      verboseChat,
    ],
  );
  // Kept at one place in the tree, beside the empty state and the list alike, so an open find
  // survives a thread loading its first rows and can say the thread is still loading.
  const threadFind = (
    <ThreadFind
      threadRef={findThreadRef}
      input={findInput}
      listRef={listRef}
      timelineElement={timelineViewportElement}
      contentInsetEndAdjustment={contentInsetEndAdjustment}
      changeDisclosures={changeDisclosures}
      onManualNavigation={onManualNavigation}
      onFocusComposer={onFindFocusComposer}
      surfaceRoot={findSurfaceRoot}
      isHostSurface={isHostFindSurface}
    />
  );

  return (
    <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
      {rows.length === 0 && !isWorking ? (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
        </div>
      ) : (
        <TimelineRowCtx value={sharedState}>
          <AttachmentUploadCtx value={attachmentUploadState}>
            <TimelineRowActivityCtx value={activityState}>
              <ReadingAnchorContext value={readingAnchor}>
                <LegendList<MessagesTimelineRow>
                  ref={handleListRef}
                  data={rows}
                  keyExtractor={keyExtractor}
                  getItemType={getItemType}
                  renderItem={renderItem}
                  estimatedItemSize={90}
                  initialScrollAtEnd
                  recycleItems={false}
                  {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
                  contentInsetEndAdjustment={listInsetEnd}
                  maintainScrollAtEnd={resolveTimelineMaintainScrollAtEnd({
                    anchored: !!anchoredEndSpace,
                    followsEnd,
                  })}
                  maintainVisibleContentPosition={resolveTimelineMaintainVisibleContentPosition(
                    nativeScrollPending,
                  )}
                  onScroll={handleScroll}
                  {...(onRowSizeChanged ? { onItemSizeChanged: onRowSizeChanged } : {})}
                  onMetricsChange={onListMetricsChange}
                  className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5"
                  contentContainerStyle={TIMELINE_LIST_CONTENT_STYLE}
                  ListHeaderComponent={TIMELINE_LIST_HEADER}
                />
              </ReadingAnchorContext>
              <TimelineMinimap
                items={minimapItems}
                bottomInset={contentInsetEndAdjustment}
                hasPersistentGutter={minimapHasPersistentGutter}
                stepTargets={minimapStepTargets}
                stripMap={minimapStripMap}
                onSelect={(item) => {
                  onManualNavigation();
                  void listRef.current?.scrollToIndex({
                    index: item.rowIndex,
                    animated: timelineScrollAnimates(),
                    viewOffset: TIMELINE_MINIMAP_JUMP_OFFSET,
                  });
                }}
              />
            </TimelineRowActivityCtx>
          </AttachmentUploadCtx>
        </TimelineRowCtx>
      )}
      {threadFind}
    </div>
  );
});

/**
 * An in-session interrupt leaves its turn expanded so the user keeps their place; the next
 * turn (or a reload, since this is local state) drops that and any other open choice on the
 * previous turn, so it folds unless Verbose chat keeps it open. A turn the user folded stays
 * folded.
 *
 * Kept out of `MessagesTimeline`'s own scope on purpose: every closure a component creates
 * shares one scope, so a memoized callback recreated on a different change than another
 * keeps the other's older scope (and its rows and minimap items) alive, render after render.
 */
function useFoldPreviousTurnOnNewTurn(
  latestTurn: TimelineLatestTurn | null,
  setDisclosures: (update: (existing: TimelineDisclosures) => TimelineDisclosures) => void,
) {
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setDisclosures((existing) =>
          applyTimelineDisclosureChange(existing, { turns: [[latestTurn.turnId, true]] }),
        );
      }
      return;
    }
    setDisclosures((existing) => {
      if (existing.turns.get(previous.turnId) !== true) {
        return existing;
      }
      const turns = new Map(existing.turns);
      turns.delete(previous.turnId);
      return { ...existing, turns };
    });
  }, [latestTurn, setDisclosures]);
}

/**
 * The list header's measured height. Row positions start below it, but a jump to a row scrolls
 * past it as well. Kept out of `MessagesTimeline`'s scope for the reason given on
 * `useFoldPreviousTurnOnNewTurn`.
 */
function useListHeaderSize() {
  const [listHeaderSize, setListHeaderSize] = useState(0);
  const onListMetricsChange = useCallback(
    (metrics: LegendListMetrics) => setListHeaderSize(metrics.headerSize),
    [],
  );
  return { listHeaderSize, onListMetricsChange };
}

/**
 * The reading anchor Mermaid diagrams commit their swaps through, created once for the life of
 * the timeline. It reads the viewport from a ref; kept out of `MessagesTimeline`'s scope for
 * the reason `useFoldPreviousTurnOnNewTurn` gives.
 */
function useTimelineReadingAnchor(
  listRef: React.RefObject<LegendListRef | null>,
  viewport: HTMLDivElement | null,
): ReadingAnchor {
  const latest = useRef({ viewport });
  useLayoutEffect(() => {
    latest.current = { viewport };
  }, [viewport]);
  const preserveReadingPosition = useCallback(
    (element: HTMLElement, commit: () => void) =>
      preserveTimelineReadingPosition(
        { list: listRef.current, ...latest.current },
        element,
        commit,
      ),
    [listRef],
  );
  const holdReadingPosition = useCallback(
    (element: HTMLElement) =>
      holdTimelineReadingPosition({ list: listRef.current, ...latest.current }, element),
    [listRef],
  );
  return useMemo(
    () => ({ preserveReadingPosition, holdReadingPosition }),
    [holdReadingPosition, preserveReadingPosition],
  );
}

/**
 * The anchored end space's callbacks, created once so the list holds the same functions for
 * the life of the timeline. They read the anchor and the parent's handlers from refs; one
 * recreated on every anchor change linked each render's scope to the one before (see
 * `useFoldPreviousTurnOnNewTurn`).
 */
function useStableAnchorCallbacks(
  anchorMessageId: MessageId | null,
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void,
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void,
) {
  const latest = useRef({ anchorMessageId, onAnchorReady, onAnchorSizeChanged });
  useLayoutEffect(() => {
    latest.current = { anchorMessageId, onAnchorReady, onAnchorSizeChanged };
  }, [anchorMessageId, onAnchorReady, onAnchorSizeChanged]);
  const handleAnchorReady = useCallback((info: { anchorIndex: number | undefined }) => {
    const { anchorMessageId: messageId, onAnchorReady: onReady } = latest.current;
    if (messageId !== null && info.anchorIndex !== undefined) {
      onReady(messageId, info.anchorIndex);
    }
  }, []);
  const handleAnchorSizeChanged = useCallback((size: number) => {
    const { anchorMessageId: messageId, onAnchorSizeChanged: onSizeChanged } = latest.current;
    if (messageId !== null) {
      onSizeChanged(messageId, size);
    }
  }, []);
  return { handleAnchorReady, handleAnchorSizeChanged };
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

type TimelineMinimapStepTargets = Record<TimelineMinimapStep, number | null>;

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

/** The most characters a minimap preview shows; its tooltip line is truncated anyway. */
const MINIMAP_PREVIEW_MAX_CHARS = 200;

/**
 * A short one-line preview of `text`. Only its beginning is normalized: normalizing the whole
 * message allocated a full-length copy of every user message on each derivation, and a long
 * thread kept many of them (#134).
 */
function compactMinimapPreview(text: string | null | undefined) {
  if (!text) {
    return null;
  }
  // Collapsing whitespace only shortens, so a few times the limit is always enough.
  const compact = text
    .slice(0, MINIMAP_PREVIEW_MAX_CHARS * 4)
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length === 0) {
    return null;
  }
  if (compact.length <= MINIMAP_PREVIEW_MAX_CHARS && text.length <= MINIMAP_PREVIEW_MAX_CHARS * 4) {
    return compact;
  }
  let end = Math.min(compact.length, MINIMAP_PREVIEW_MAX_CHARS);
  // Never split a surrogate pair.
  const last = compact.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${compact.slice(0, end).trimEnd()}…`;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function TimelineMinimap({
  bottomInset,
  hasPersistentGutter,
  items,
  stepTargets,
  stripMap,
  onSelect,
}: {
  bottomInset: number;
  hasPersistentGutter: boolean;
  items: ReadonlyArray<TimelineMinimapItem>;
  stepTargets: TimelineMinimapStepTargets;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/minimap pointer-events-auto absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div
        className="absolute top-1/2 left-3 w-10 -translate-y-1/2 select-none"
        style={{ height: resolveTimelineMinimapHeightStyle(items.length) }}
      >
        <TimelineMinimapStepButton
          step="previous"
          item={items[stepTargets.previous ?? -1] ?? null}
          onSelect={onSelect}
        />
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className="pointer-events-auto absolute inset-0 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{ top }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-none absolute left-8 w-80 rounded-xl border border-border/70 bg-popover/95 p-3 text-left text-popover-foreground shadow-xl shadow-black/25 backdrop-blur"
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                {activeItem.userText ?? "User message"}
              </span>
              {activeItem.assistantText ? (
                <span
                  className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 3,
                  }}
                >
                  {activeItem.assistantText}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
        <TimelineMinimapStepButton
          step="next"
          item={items[stepTargets.next ?? -1] ?? null}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

/**
 * Steps to the turn before or after the reading position. With nowhere to go it stays focusable
 * but inert (`aria-disabled`), so pressing it at the start or end of a thread keeps focus here.
 */
function TimelineMinimapStepButton({
  step,
  item,
  onSelect,
}: {
  step: TimelineMinimapStep;
  item: TimelineMinimapItem | null;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const label = step === "previous" ? "Previous turn" : "Next turn";
  const Icon = step === "previous" ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            aria-disabled={item === null}
            className={cn(
              "pointer-events-auto absolute left-0 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
              step === "previous" ? "bottom-full mb-1" : "top-full mt-1",
            )}
            onClick={() => {
              if (item) onSelect(item);
            }}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? (
        <WorkGroupSection groupedEntries={row.groupedEntries} expanded={row.expanded} />
      ) : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "queued-message" ? <QueuedTimelineRow row={row} /> : null}
    </div>
  );
});

const QueuedTimelineRow = memo(function QueuedTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "queued-message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const displayed = deriveDisplayedUserMessageState(row.message.text);
  return (
    <QueuedMessageTimelineRow
      message={row.message}
      status={row.status}
      isHead={row.isHead}
      timestampFormat={ctx.timestampFormat}
      resolving={ctx.resolvingQueuedMessageId === row.message.id}
      error={ctx.queuedMessageErrors[`${ctx.routeThreadKey}:${row.message.id}`] ?? null}
      onSteer={ctx.onSteerQueuedMessage}
      onSendNow={ctx.onSendNowQueuedMessage}
      onCancel={ctx.onCancelQueuedMessage}
    >
      <CollapsibleUserMessageBody
        entryId={row.id}
        disclosure={row.disclosure}
        text={displayed.visibleText}
        terminalContexts={displayed.contexts}
        skills={ctx.skills}
        markdownCwd={ctx.markdownCwd}
      />
    </QueuedMessageTimelineRow>
  );
});

const AttachmentUploadTimelineNotice = memo(function AttachmentUploadTimelineNotice({
  messageId,
}: {
  messageId: MessageId;
}) {
  const state = use(AttachmentUploadCtx);
  const progress = state.uploads[messageId];
  return progress ? (
    <AttachmentUploadNotice progress={progress} onCancel={() => state.onCancel(messageId)} />
  ) : null;
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const sentBody = deriveSentUserMessageBody(row.message.text);
  const { elementContexts, previewAnnotations, terminalContexts } = sentBody;
  const previewImages = userImages.filter(
    (
      attachment,
    ): attachment is Extract<
      NonNullable<TimelineMessage["attachments"]>[number],
      { type: "image" }
    > => attachment.type === "image" && attachment.name.startsWith("preview-annotation-"),
  );
  const regularImages = userImages.filter(
    (
      attachment,
    ): attachment is Extract<
      NonNullable<TimelineMessage["attachments"]>[number],
      { type: "image" }
    > => attachment.type === "image" && !attachment.name.startsWith("preview-annotation-"),
  );
  const regularFiles = userImages.filter((attachment) => attachment.type === "file");
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(regularImages, image.id);
                      if (!preview) return;
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-xs text-muted-foreground">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {regularFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {regularFiles.map((file) => (
              <div
                key={file.id}
                className="flex min-w-44 items-center gap-2 rounded-lg border border-border/80 bg-background/70 px-2 py-1.5"
              >
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-xs">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                </span>
              </div>
            ))}
          </div>
        )}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          entryId={row.id}
          disclosure={row.disclosure}
          text={sentBody.bodyText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <AttachmentUploadTimelineNotice messageId={row.message.id} />
      {row.message.delivery ? (
        <TurnDeliveryNotice
          delivery={row.message.delivery}
          providerLabel={deliveryProviderLabel(row.message.delivery, ctx.instanceLabels)}
          waitingBehind={
            row.message.delivery.state === "pending" &&
            waitsBehind(row.message, ctx.blockingDelivery)
              ? ctx.blockingDelivery
              : null
          }
          recovery={
            row.message.id === ctx.compactionFailedMessageId
              ? "resending"
              : row.message.resendOf !== undefined
                ? "resent"
                : null
          }
          disabled={ctx.resolvingTurnDeliveryMessageId === row.message.id}
          onRetry={() => ctx.onResolveTurnDelivery(row.message.id, "retry")}
          onDismiss={() => ctx.onResolveTurnDelivery(row.message.id, "dismiss")}
        />
      ) : null}
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {sentBody.copyText && <MessageCopyButton text={sentBody.copyText} variant="ghost" />}
          </div>
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="group/timeline-row flex items-center border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId, row.expanded)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
      <TimelineRowTime createdAt={row.createdAt} className="ms-auto pe-1" />
    </div>
  );
}

/**
 * A tool or fold row's time, shown while the row is hovered or focused, as a message's time is.
 * Hidden, it takes no room, so a tool row's preview keeps its full width.
 */
function TimelineRowTime({ createdAt, className }: { createdAt: string; className: string }) {
  const { timestampFormat } = use(TimelineRowCtx);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-timeline-row-time
            className={cn(
              "hidden shrink-0 text-muted-foreground text-xs tabular-nums group-focus-within/timeline-row:inline group-hover/timeline-row:inline",
              className,
            )}
          />
        }
      >
        {formatShortTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <TimelineChatMarkdown
          entryId={row.id}
          disclosure={row.disclosure}
          // The placeholder for an empty reply is not the reply's text.
          scope={row.message.text ? ASSISTANT_MESSAGE_FIND_SCOPE : undefined}
          text={messageText}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(row.message.streaming)}
          skills={ctx.skills}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onSetEntryDisclosure } = ctx;
  const entryId = row.id;
  const onExpandedChange = useCallback(
    (expanded: boolean) => onSetEntryDisclosure(entryId, PROPOSED_PLAN_DISCLOSURE_KEY, expanded),
    [entryId, onSetEntryDisclosure],
  );
  const onDetailsOpenChange = useCallback(
    (ordinal: number, open: boolean) =>
      onSetEntryDisclosure(entryId, detailsDisclosureKey(PLAN_BODY_FIND_SCOPE, ordinal), open),
    [entryId, onSetEntryDisclosure],
  );

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        expanded={row.disclosure?.get(PROPOSED_PLAN_DISCLOSURE_KEY) ?? false}
        onExpandedChange={onExpandedChange}
        detailsOpen={detailsOpenForScope(row.disclosure, PLAN_BODY_FIND_SCOPE)}
        onDetailsOpenChange={onDetailsOpenChange}
      />
    </div>
  );
}

const WORKING_INDICATOR_DOTS = [
  ["left-0.5 top-0.5", "0ms"],
  ["left-[6.75px] top-0.5", "-980ms"],
  ["right-0.5 top-0.5", "-840ms"],
  ["right-0.5 top-[6.75px]", "-700ms"],
  ["right-0.5 bottom-0.5", "-560ms"],
  ["left-[6.75px] bottom-0.5", "-420ms"],
  ["left-0.5 bottom-0.5", "-280ms"],
  ["left-0.5 top-[6.75px]", "-140ms"],
] as const;

function WorkingIndicatorIcon() {
  return (
    <span aria-hidden="true" className="relative size-4 shrink-0" data-working-indicator="reversed">
      {WORKING_INDICATOR_DOTS.map(([position, animationDelay], index) => (
        <span
          key={position}
          className={cn(
            "working-indicator-dot absolute size-[2.5px] rounded-full bg-current",
            position,
          )}
          data-working-indicator-dot={index + 1}
          style={{ animationDelay }}
        />
      ))}
    </span>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-xs text-muted-foreground tabular-nums">
        <WorkingIndicatorIcon />
        {/* The timer never truncates; the thought takes what is left of the one line. */}
        <span className="shrink-0">
          {row.answerDelivered
            ? "Answer delivered — waiting for the provider to close the turn "
            : "Waiting for "}
          <WorkingTimer createdAt={row.createdAt} />
        </span>
        {row.latestThought !== null ? (
          <span className="min-w-0 truncate" data-working-latest-thought="">
            {`· ${row.latestThought}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live elapsed label for the active waiting row. */
function WorkingTimer({ createdAt }: { createdAt: string | null }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const elapsedFloorRef = useRef(0);
  // Rendered once: the frame loop below owns the text after mount.
  const [initialText] = useState(() =>
    formatWorkingElapsedMs(
      createdAt === null ? 0 : (readWorkingTimerElapsedMs(createdAt, Date.now()) ?? 0),
    ),
  );

  useEffect(() => {
    const sourceElapsedMs =
      createdAt === null ? 0 : readWorkingTimerElapsedMs(createdAt, Date.now());
    if (sourceElapsedMs === null) {
      return;
    }

    const elapsedAtAnchorMs = Math.max(elapsedFloorRef.current, sourceElapsedMs);
    const monotonicAnchorMs = performance.now();
    let frameId = 0;
    const updateText = (monotonicNowMs: number) => {
      const elapsedMs = elapsedAtAnchorMs + Math.max(0, monotonicNowMs - monotonicAnchorMs);
      elapsedFloorRef.current = Math.max(elapsedFloorRef.current, elapsedMs);
      const nextText = formatWorkingElapsedMs(elapsedFloorRef.current);
      if (textRef.current && textRef.current.textContent !== nextText) {
        textRef.current.textContent = nextText;
      }
      frameId = requestAnimationFrame(updateText);
    };

    updateText(monotonicAnchorMs);
    return () => cancelAnimationFrame(frameId);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  expanded,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  expanded: boolean;
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  // A thought reads as a step beside tool calls, not as a log entry that needs a heading.
  const onlyToolEntries = nonEmptyEntries.every(
    (entry) => workLogEntryIsToolLike(entry) || entry.tone === "reasoning",
  );
  const [singularNoun, pluralNoun] = nonEmptyEntries.some((entry) => entry.tone === "reasoning")
    ? ["step", "steps"]
    : ["tool call", "tool calls"];
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? `1 ${singularNoun}`
      : `${nonEmptyEntries.length} ${pluralNoun}`
    : "Work Log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-xs text-muted-foreground">{groupLabel}</p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) =>
          workEntry.reasoning !== undefined ? (
            <ReasoningWorkEntryRow
              key={workEntry.id}
              workEntry={workEntry}
              reasoning={workEntry.reasoning}
              expanded={expanded}
            />
          ) : (
            <SimpleWorkEntryRow
              key={workEntry.id}
              workEntry={workEntry}
              workspaceRoot={workspaceRoot}
              expanded={expanded}
            />
          ),
        )}
      </div>
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const singularNoun = row.hidesReasoning
    ? "step"
    : row.onlyToolEntries
      ? "tool call"
      : "log entry";
  const pluralNoun = row.hidesReasoning
    ? "steps"
    : row.onlyToolEntries
      ? "tool calls"
      : "log entries";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-xs leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) => {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>("[data-timeline-row-id]") ?? event.currentTarget;
        ctx.onToggleWorkGroup(row.groupId, row.expanded, anchorElement);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">Show fewer {pluralNoun}</span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {row.hiddenCount === 1 ? singularNoun : pluralNoun}
        </span>
      )}
    </button>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="sticky top-2 z-10 mb-1.5 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }> | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  entryId: string;
  disclosure: EntryDisclosure | undefined;
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const { onSetEntryDisclosure } = use(TimelineRowCtx);
  const expanded = props.disclosure?.get(MESSAGE_BODY_DISCLOSURE_KEY) ?? false;
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            entryId={props.entryId}
            disclosure={props.disclosure}
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() =>
                onSetEntryDisclosure(props.entryId, MESSAGE_BODY_DISCLOSURE_KEY, !expanded)
              }
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  entryId: string;
  disclosure: EntryDisclosure | undefined;
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const layout = deriveUserMessageBodyLayout(props.text, props.terminalContexts);
  // Parts are numbered in render order, as Find in thread numbers them.
  const scopeByPart = new Map(
    userMessageMarkdownParts(layout).map((part, index) => [part, markdownFindScope(index)]),
  );
  const renderMarkdown = (part: UserMessageMarkdownPart) => {
    const scope = scopeByPart.get(part);
    if (scope === undefined) return null;
    return (
      <TimelineChatMarkdown
        key={part.key}
        entryId={props.entryId}
        disclosure={props.disclosure}
        scope={scope}
        text={part.text}
        cwd={props.markdownCwd}
        threadRef={ctx.threadRef ?? undefined}
        skills={props.skills}
        className="text-foreground"
        lineBreaks
      />
    );
  };
  const renderInlinePart = (part: UserMessageMarkdownPart) => (
    <Fragment key={part.key}>
      {part.leadingWhitespace ? <span aria-hidden="true">{part.leadingWhitespace}</span> : null}
      {renderMarkdown(part)}
      {part.trailingWhitespace ? <span aria-hidden="true">{part.trailingWhitespace}</span> : null}
    </Fragment>
  );

  switch (layout.kind) {
    case "review-comments":
      return (
        <div className="space-y-3 text-sm leading-relaxed text-foreground">
          {layout.parts.map((part) =>
            part.kind === "markdown" ? (
              <div key={part.key} className="wrap-break-word">
                {renderMarkdown(part)}
              </div>
            ) : (
              <UserMessageReviewCommentCard key={part.comment.id} comment={part.comment} />
            ),
          )}
        </div>
      );
    case "inline-terminal-contexts":
      return (
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          {layout.parts.map((part) =>
            part.kind === "markdown" ? (
              renderInlinePart(part)
            ) : (
              <UserMessageTerminalContextInlineLabel key={part.key} context={part.context} />
            ),
          )}
        </div>
      );
    case "leading-terminal-contexts": {
      if (!layout.markdown && buildInlineTerminalContextText(layout.contexts).length === 0) {
        return null;
      }
      return (
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          {layout.contexts.map((context) => (
            <Fragment key={`user-terminal-context-inline:${context.header}`}>
              <UserMessageTerminalContextInlineLabel context={context} />
              <span aria-hidden="true"> </span>
            </Fragment>
          ))}
          {layout.markdown ? renderMarkdown(layout.markdown) : null}
        </div>
      );
    }
    case "markdown":
      return layout.markdown ? renderMarkdown(layout.markdown) : null;
  }
});

/**
 * `ChatMarkdown` for a timeline entry: its `<details>` blocks follow the timeline's disclosure
 * owner, and its text is marked as one Find in thread scope.
 */
const TimelineChatMarkdown = memo(function TimelineChatMarkdown(props: {
  entryId: string;
  disclosure: EntryDisclosure | undefined;
  scope: string | undefined;
  text: string;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  isStreaming?: boolean;
  className?: string;
  lineBreaks?: boolean;
}) {
  const { onSetEntryDisclosure } = use(TimelineRowCtx);
  const { entryId, scope } = props;
  const detailsScope = scope ?? "";
  const onDetailsOpenChange = useCallback(
    (ordinal: number, open: boolean) =>
      onSetEntryDisclosure(entryId, detailsDisclosureKey(detailsScope, ordinal), open),
    [detailsScope, entryId, onSetEntryDisclosure],
  );
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.cwd}
      threadRef={props.threadRef}
      skills={props.skills}
      {...(props.isStreaming !== undefined ? { isStreaming: props.isStreaming } : {})}
      {...(props.className !== undefined ? { className: props.className } : {})}
      {...(props.lineBreaks !== undefined ? { lineBreaks: props.lineBreaks } : {})}
      detailsOpen={detailsOpenForScope(props.disclosure, detailsScope)}
      onDetailsOpenChange={onDetailsOpenChange}
      findScope={scope}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-xs text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const [stabilizeRows] = useState(createMessagesTimelineRowStabilizer);
  return useMemo(() => stabilizeRows(rows), [rows, stabilizeRows]);
}

/** Per-instance memoizer that reuses unchanged rows from the previous call. */
function createMessagesTimelineRowStabilizer() {
  let previous: StableMessagesTimelineRowsState = {
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  };
  return (rows: MessagesTimelineRow[]): MessagesTimelineRow[] => {
    previous = computeStableMessagesTimelineRows(rows, previous);
    return previous.result;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function readWorkingTimerElapsedMs(startIso: string, nowMs: number): number | null {
  const startedAtMs = Date.parse(startIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }

  return Math.max(0, nowMs - startedAtMs);
}

function formatWorkingElapsedMs(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const secondsLabel = `${elapsedSeconds % 60}s`;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secondsLabel}`;
  }

  return minutes > 0 ? `${minutes}m ${secondsLabel}` : secondsLabel;
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "warning") {
    // Distinct from `error` (the turn survived) and from `tool` (this is not a
    // tool call): an upstream retry or rate limit the user should notice.
    return {
      iconName: "circle-alert",
      className: "text-warning-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

interface ToolCallExpandedBlock {
  readonly text: string;
  /** The command, which Find in thread searches; the rest is output and changed files. */
  readonly isCommand: boolean;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): ToolCallExpandedBlock[] | null {
  const blocks: ToolCallExpandedBlock[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push({
      text: `MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`,
      isCommand: false,
    });
  }
  const command = toolCallDisplayedCommand(workEntry);
  if (command) {
    blocks.push({ text: command, isCommand: true });
  }
  if (workEntry.detail?.trim()) {
    blocks.push({ text: workEntry.detail.trim(), isCommand: false });
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push({
      text: changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
      isCommand: false,
    });
  }
  return blocks.length > 0 ? blocks : null;
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return "hammer";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle && !workEntry.sourceActivityKind?.startsWith("tool.")) {
    return capitalizePhrase(workEntry.label);
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  expanded: boolean;
}) {
  const { workEntry, workspaceRoot, expanded } = props;
  const { onSetEntryDisclosure } = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const toggleExpanded = () => {
    onSetEntryDisclosure(workEntry.id, TOOL_ROW_DISCLOSURE_KEY, !expanded);
  };
  const iconConfig = workToneIcon(workEntry.tone);
  const entryIconName = workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showDestructiveRowStyle
      ? "text-destructive"
      : workEntry.tone === "tool" || showFailedIndicator
        ? "text-muted-foreground"
        : iconConfig.className,
  );
  const headingClass = showDestructiveRowStyle
    ? "font-medium text-destructive"
    : "font-medium text-foreground/82";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "group/timeline-row flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground">
            <TimelineRowTime createdAt={workEntry.createdAt} className="me-1" />
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground select-text">
            {expandedBody.map((block, index) => (
              <Fragment key={block.isCommand ? "command" : index}>
                {index > 0 ? "\n\n" : null}
                {block.isCommand ? (
                  <span data-find-scope={TOOL_COMMAND_FIND_SCOPE}>{block.text}</span>
                ) : (
                  block.text
                )}
              </Fragment>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  );
});

/** Within this distance of its end, an expanded live trace keeps following its newest text. */
const REASONING_TRACE_FOLLOW_SLACK_PX = 4;

/**
 * A provider's thought (#173). Collapsed, one line reads "Thought - <what it is about>", or
 * "Thinking - …" while it streams; the whole line is the toggle, opened by Verbose chat as
 * tool rows are. Expanded, it shows the full trace. Its disclosure is the tool row's, so the
 * user's choice wins and, until then, Verbose chat opens settled thoughts.
 */
const ReasoningWorkEntryRow = memo(function ReasoningWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  reasoning: OrchestrationReasoning;
  expanded: boolean;
}) {
  const { workEntry, reasoning, expanded } = props;
  const { onSetEntryDisclosure, onReasoningRowToggle } = use(TimelineRowCtx);
  const toggleExpanded = () => {
    onSetEntryDisclosure(workEntry.id, TOOL_ROW_DISCLOSURE_KEY, !expanded);
    onReasoningRowToggle();
  };
  const preview = reasoningPreview(reasoning);

  return (
    <div className="flex flex-col" data-reasoning-id={reasoning.id}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-xs leading-5 text-muted-foreground transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={toggleExpanded}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <BrainIcon className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{reasoningLabel(reasoning)}</span>
          {preview !== null ? ` - ${preview}` : null}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 opacity-70 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>
      {expanded ? <ReasoningTrace text={reasoning.text} streaming={reasoning.streaming} /> : null}
    </div>
  );
});

/**
 * The full trace, rendered as the assistant's Markdown is. While it streams it follows its
 * newest text, until the reader scrolls up; scrolling back to within a few pixels of the end
 * resumes following.
 */
function ReasoningTrace({ text, streaming }: { text: string; streaming: boolean }) {
  const ctx = use(TimelineRowCtx);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  useLayoutEffect(() => {
    // Layout is read only while the trace streams, each time its text grows.
    if (!streaming || text.length === 0 || !followingRef.current) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [streaming, text]);
  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (scroller) {
      followingRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
        REASONING_TRACE_FOLLOW_SLACK_PX;
    }
  };

  return (
    <div className="mt-1 ms-7 border-s border-border/45 ps-3 pt-0.5">
      <div
        ref={scrollerRef}
        className="max-h-64 overflow-auto"
        data-reasoning-trace=""
        onScroll={onScroll}
      >
        <div data-text-surface="background" className="text-muted-foreground select-text">
          <ChatMarkdown
            text={text}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={streaming}
            skills={ctx.skills}
          />
        </div>
      </div>
    </div>
  );
}
