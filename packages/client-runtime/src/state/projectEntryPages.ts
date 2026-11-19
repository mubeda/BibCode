import type {
  ProjectEntry,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";

/** How often a list whose index changed mid-read starts over before the error is shown. */
export const PROJECT_ENTRY_PAGE_RESTARTS = 3;

function isStaleCursor(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly failure?: unknown }).failure === "search_index_cursor_stale"
  );
}

/**
 * Reads the whole entry list page by page (#390), so no single reply carries it. A page whose
 * cursor names an index the server no longer holds starts the read over, at most
 * `PROJECT_ENTRY_PAGE_RESTARTS` times, so pages of two snapshots are never joined. A server that
 * predates paging answers the whole list without `nextCursor`, which is a complete single page.
 * Only the complete list is returned, so a caller keeps showing its previous list until then.
 */
export function readProjectEntryPages<E, R>(
  input: ProjectListEntriesInput,
  requestPage: (input: ProjectListEntriesInput) => Effect.Effect<ProjectListEntriesResult, E, R>,
): Effect.Effect<ProjectListEntriesResult, E, R> {
  const { cwd } = input;
  const readAll = (first: ProjectListEntriesInput) =>
    Effect.gen(function* () {
      let page = yield* requestPage(first);
      if (page.nextCursor === undefined)
        return { entries: page.entries, truncated: page.truncated };
      const entries: ProjectEntry[] = [...page.entries];
      while (page.nextCursor !== undefined) {
        page = yield* requestPage({ cwd, cursor: page.nextCursor });
        for (const entry of page.entries) entries.push(entry);
      }
      return { entries, truncated: page.truncated };
    });
  const attempt = (restarts: number): Effect.Effect<ProjectListEntriesResult, E, R> =>
    readAll(restarts === 0 ? { ...input, paged: true } : { cwd, paged: true }).pipe(
      Effect.catchIf(
        (error) => restarts < PROJECT_ENTRY_PAGE_RESTARTS && isStaleCursor(error),
        () => attempt(restarts + 1),
      ),
    );
  return attempt(0);
}
