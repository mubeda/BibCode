import { type KeyboardEventHandler, type ReactNode, useId } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";

import { GitManagerPaneSeparator } from "./GitManagerPaneSeparator";

// Persisted per browser, like the Pull Requests file column's width.
const LIST_HEIGHT_KEY = "bibcode:git-changes-list-height";
const LIST_DEFAULT_HEIGHT = 200;
const LIST_MIN_HEIGHT = 64;
const LIST_MAX_HEIGHT = 640;
const COMMIT_HEIGHT_KEY = "bibcode:git-changes-commit-height";
// A ceiling the form's own height stays under until it is narrowed, so the default is no cap.
const COMMIT_DEFAULT_HEIGHT = 480;
const COMMIT_MIN_HEIGHT = 120;
const COMMIT_MAX_HEIGHT = 720;

/**
 * The changed-file list above the selected file's diff, divided by a handle that sets the
 * list's height and gives the diff the rest. Without a diff the list takes the whole area. On
 * a short window the list gives way before the diff does.
 */
export function GitManagerChangesSplit({
  list,
  diff,
  onKeyDown,
}: {
  readonly list: ReactNode;
  readonly diff: ReactNode;
  readonly onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}) {
  const listId = useId();
  const { width, handlers, commitWidth } = useResizableWidth({
    storageKey: LIST_HEIGHT_KEY,
    defaultWidth: LIST_DEFAULT_HEIGHT,
    minWidth: LIST_MIN_HEIGHT,
    maxWidth: LIST_MAX_HEIGHT,
    edge: "right",
    axis: "y",
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div
        id={listId}
        className={diff === null ? "flex min-h-0 flex-1 flex-col" : "flex min-h-16 shrink flex-col"}
        style={diff === null ? undefined : { flexBasis: width }}
      >
        {list}
      </div>
      {diff === null ? null : (
        <>
          <GitManagerPaneSeparator
            controls={listId}
            growKey="ArrowDown"
            handlers={handlers}
            label="Resize changed files list"
            max={LIST_MAX_HEIGHT}
            min={LIST_MIN_HEIGHT}
            value={width}
            onReset={() => commitWidth(LIST_DEFAULT_HEIGHT)}
            onResize={commitWidth}
          />
          <div className="flex min-h-24 min-w-0 flex-1 flex-col">{diff}</div>
        </>
      )}
    </div>
  );
}

/**
 * The commit form under a handle that caps its height, so a long form scrolls instead of taking
 * the room the diff above needs.
 */
export function GitManagerCommitPane({ children }: { readonly children: ReactNode }) {
  const paneId = useId();
  const { width, handlers, commitWidth } = useResizableWidth({
    storageKey: COMMIT_HEIGHT_KEY,
    defaultWidth: COMMIT_DEFAULT_HEIGHT,
    minWidth: COMMIT_MIN_HEIGHT,
    maxWidth: COMMIT_MAX_HEIGHT,
    edge: "left",
    axis: "y",
  });
  return (
    <>
      <GitManagerPaneSeparator
        controls={paneId}
        growKey="ArrowUp"
        handlers={handlers}
        label="Resize commit form"
        max={COMMIT_MAX_HEIGHT}
        min={COMMIT_MIN_HEIGHT}
        value={width}
        onReset={() => commitWidth(COMMIT_DEFAULT_HEIGHT)}
        onResize={commitWidth}
      />
      <div id={paneId} className="min-h-0 shrink overflow-y-auto" style={{ maxHeight: width }}>
        {children}
      </div>
    </>
  );
}
