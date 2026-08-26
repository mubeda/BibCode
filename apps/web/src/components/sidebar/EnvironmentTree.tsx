import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import {
  type EnvironmentTreeEnvironmentRow,
  type EnvironmentTreeProjectRow,
  type EnvironmentTreeProjection,
  type EnvironmentTreeRow,
} from "../../environmentTree";
import { EnvironmentRow } from "./EnvironmentRow";
import { ProjectRow } from "./ProjectRow";
import { ThreadRow } from "./ThreadRow";

const TYPEAHEAD_RESET_MS = 750;
const ESTIMATED_ROW_HEIGHT = 32;

export interface EnvironmentTreeContextMenuRequest {
  readonly source: "pointer" | "keyboard";
  readonly clientX: number;
  readonly clientY: number;
}

export interface EnvironmentTreeProps {
  readonly projection: EnvironmentTreeProjection;
  readonly pinnedThreadKeys?: ReadonlySet<string> | readonly string[];
  readonly unreadThreadKeys?: ReadonlySet<string> | readonly string[];
  readonly onToggle: (row: EnvironmentTreeEnvironmentRow | EnvironmentTreeProjectRow) => void;
  readonly onSelect: (row: EnvironmentTreeRow) => void;
  readonly onContextMenu: (
    row: EnvironmentTreeRow,
    request: EnvironmentTreeContextMenuRequest,
  ) => void;
  readonly onClearSearch: () => void;
}

function asSet(values: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function isExpandable(
  row: EnvironmentTreeRow,
): row is EnvironmentTreeEnvironmentRow | EnvironmentTreeProjectRow {
  return row.kind !== "thread";
}

function nextTypeaheadMatch(
  rows: readonly EnvironmentTreeRow[],
  currentIndex: number,
  query: string,
): EnvironmentTreeRow | null {
  if (rows.length === 0 || query.length === 0) return null;
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const row = rows[(currentIndex + offset) % rows.length];
    if (row?.label.toLocaleLowerCase().startsWith(query)) return row;
  }
  return null;
}

function deferredFocus(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
  } else {
    queueMicrotask(callback);
  }
}

export const EnvironmentTree = memo(function EnvironmentTree({
  projection,
  pinnedThreadKeys,
  unreadThreadKeys,
  onToggle,
  onSelect,
  onContextMenu,
  onClearSearch,
}: EnvironmentTreeProps) {
  const rows = projection.rows;
  const listRef = useRef<LegendListRef | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const treeHasFocus = useRef(false);
  const typeahead = useRef({ value: "", lastInputAt: 0 });
  const selectedKey = rows.find((row) => row.isSelected)?.key ?? null;
  const [focusedKey, setFocusedKey] = useState<string | null>(
    () => selectedKey ?? rows[0]?.key ?? null,
  );
  const pinned = useMemo(() => asSet(pinnedThreadKeys), [pinnedThreadKeys]);
  const unread = useMemo(() => asSet(unreadThreadKeys), [unreadThreadKeys]);
  const environmentLabelById = useMemo(
    () =>
      new Map(
        rows.flatMap((row) =>
          row.kind === "environment" ? [[row.environmentId, row.label] as const] : [],
        ),
      ),
    [rows],
  );
  const projectLabelByKey = useMemo(
    () =>
      new Map(
        rows.flatMap((row) => (row.kind === "project" ? [[row.key, row.label] as const] : [])),
      ),
    [rows],
  );

  const focusRow = useCallback(
    (key: string) => {
      const index = projection.indexByKey.get(key);
      if (index === undefined) return;
      setFocusedKey(key);
      const focus = () => rowElements.current.get(key)?.focus({ preventScroll: true });
      const scroll = listRef.current?.scrollToIndex({ index, animated: false });
      if (scroll) {
        void scroll.then(
          () => deferredFocus(focus),
          () => deferredFocus(focus),
        );
      } else {
        deferredFocus(focus);
      }
    },
    [projection.indexByKey],
  );

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target === document.body) return;
      treeHasFocus.current = [...rowElements.current.values()].some((row) => row.contains(target));
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  useEffect(() => {
    if (focusedKey !== null && projection.indexByKey.has(focusedKey)) return;
    const replacementKey = selectedKey ?? rows[0]?.key ?? null;
    if (replacementKey === null) {
      setFocusedKey(null);
    } else if (treeHasFocus.current) {
      focusRow(replacementKey);
    } else {
      setFocusedKey(replacementKey);
    }
  }, [focusRow, focusedKey, projection.indexByKey, rows, selectedKey]);

  const activateRow = useCallback(
    (row: EnvironmentTreeRow) => {
      setFocusedKey(row.key);
      onSelect(row);
    },
    [onSelect],
  );

  const toggleRow = useCallback(
    (row: EnvironmentTreeEnvironmentRow | EnvironmentTreeProjectRow) => {
      setFocusedKey(row.key);
      onToggle(row);
    },
    [onToggle],
  );

  const requestPointerContextMenu = useCallback(
    (row: EnvironmentTreeRow, event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setFocusedKey(row.key);
      onContextMenu(row, {
        source: "pointer",
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    [onContextMenu],
  );

  const handleKeyDown = useCallback(
    (row: EnvironmentTreeRow, event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = projection.indexByKey.get(row.key);
      if (currentIndex === undefined) return;
      const focusIndex = (index: number) => {
        const candidate = rows[index];
        if (candidate) focusRow(candidate.key);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusIndex(Math.min(rows.length - 1, currentIndex + 1));
          return;
        case "ArrowUp":
          event.preventDefault();
          focusIndex(Math.max(0, currentIndex - 1));
          return;
        case "Home":
          event.preventDefault();
          focusIndex(0);
          return;
        case "End":
          event.preventDefault();
          focusIndex(rows.length - 1);
          return;
        case "ArrowRight": {
          event.preventDefault();
          if (isExpandable(row) && !row.isExpanded) {
            toggleRow(row);
            return;
          }
          const firstChild = rows[currentIndex + 1];
          if (firstChild?.parentKey === row.key) focusRow(firstChild.key);
          return;
        }
        case "ArrowLeft":
          event.preventDefault();
          if (isExpandable(row) && row.isExpanded) {
            toggleRow(row);
          } else if (row.parentKey !== null) {
            focusRow(row.parentKey);
          }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          activateRow(row);
          return;
        case "Escape":
          event.preventDefault();
          typeahead.current = { value: "", lastInputAt: 0 };
          onClearSearch();
          return;
        case "F10":
          if (!event.shiftKey) return;
          event.preventDefault();
          onContextMenu(row, { source: "keyboard", clientX: 0, clientY: 0 });
          return;
        default:
          break;
      }

      if (
        event.key.length !== 1 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.trim().length === 0
      ) {
        return;
      }
      const now = Date.now();
      const nextValue =
        now - typeahead.current.lastInputAt > TYPEAHEAD_RESET_MS
          ? event.key.toLocaleLowerCase()
          : `${typeahead.current.value}${event.key.toLocaleLowerCase()}`;
      typeahead.current = { value: nextValue, lastInputAt: now };
      const match = nextTypeaheadMatch(rows, currentIndex, nextValue);
      if (match) {
        event.preventDefault();
        focusRow(match.key);
      }
    },
    [activateRow, focusRow, onClearSearch, onContextMenu, projection.indexByKey, rows, toggleRow],
  );

  const renderRow = useCallback(
    ({ item: row }: { readonly item: EnvironmentTreeRow }) => {
      const shared = {
        focused: focusedKey === row.key,
        rowRef: (element: HTMLDivElement | null) => {
          if (element) rowElements.current.set(row.key, element);
          else rowElements.current.delete(row.key);
        },
        onFocus: () => {
          treeHasFocus.current = true;
          setFocusedKey(row.key);
        },
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => handleKeyDown(row, event),
        onSelect: () => activateRow(row),
        onContextMenu: (event: MouseEvent<HTMLElement>) => requestPointerContextMenu(row, event),
      };
      if (row.kind === "environment") {
        return <EnvironmentRow {...shared} row={row} onToggle={() => toggleRow(row)} />;
      }
      const environmentLabel = environmentLabelById.get(row.environmentId) ?? row.environmentId;
      if (row.kind === "project") {
        return (
          <ProjectRow
            {...shared}
            row={row}
            environmentLabel={environmentLabel}
            onToggle={() => toggleRow(row)}
          />
        );
      }
      return (
        <ThreadRow
          {...shared}
          row={row}
          environmentLabel={environmentLabel}
          projectLabel={(row.parentKey && projectLabelByKey.get(row.parentKey)) ?? row.projectId}
          pinned={pinned.has(row.key.replace(/^thread:/, ""))}
          unread={unread.has(row.key.replace(/^thread:/, ""))}
        />
      );
    },
    [
      activateRow,
      environmentLabelById,
      focusedKey,
      handleKeyDown,
      pinned,
      projectLabelByKey,
      requestPointerContextMenu,
      toggleRow,
      unread,
    ],
  );

  return (
    <LegendList<EnvironmentTreeRow>
      ref={listRef}
      role="tree"
      aria-label="Environments, projects, and threads"
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      renderItem={renderRow}
      estimatedItemSize={ESTIMATED_ROW_HEIGHT}
      drawDistance={ESTIMATED_ROW_HEIGHT * 12}
      recycleItems={false}
      className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain px-2 py-1"
    />
  );
});
