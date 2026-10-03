// @effect-diagnostics globalFetch:off - Fixed authenticated QA primary snapshot stays inside the page.
/** In-memory-only binding captured from the initially imported primary workspace. */
export interface ReloadPrimaryWorkspace {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly sessionLinePresent: boolean;
}

/** Reject malformed/accessor evidence without retaining or reading arbitrary values. */
export function decodeReloadPrimaryWorkspace(
  input: unknown,
  expected: ReloadPrimaryWorkspace | null = null,
): ReloadPrimaryWorkspace | null {
  if (input === null || typeof input !== "object") return null;
  try {
    if (Array.isArray(input)) return null;
    const values: string[] = [];
    for (const key of ["environmentId", "projectId", "threadId"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(descriptor.value)
      )
        return null;
      values.push(descriptor.value);
    }
    const session = Object.getOwnPropertyDescriptor(input, "sessionLinePresent");
    if (
      !session?.enumerable ||
      !Object.hasOwn(session, "value") ||
      typeof session.value !== "boolean"
    )
      return null;
    const result = {
      environmentId: values[0]!,
      projectId: values[1]!,
      threadId: values[2]!,
      sessionLinePresent: session.value,
    };
    if (expected !== null) {
      const bound = decodeReloadPrimaryWorkspace(expected);
      if (
        bound === null ||
        result.environmentId !== bound.environmentId ||
        result.projectId !== bound.projectId ||
        result.threadId !== bound.threadId ||
        result.sessionLinePresent !== bound.sessionLinePresent
      )
        return null;
    }
    return result;
  } catch {
    return null;
  }
}

/** Self-contained public DOM reader; candidate mode never claims thread selection. */
export function readReloadPrimaryWorkspace(input: {
  projectName: string;
  environmentId: string | null;
  projectId: string | null;
  threadId: string | null;
  sessionLinePresent: boolean | null;
  requireSelected: boolean;
}): ReloadPrimaryWorkspace | boolean | null {
  try {
    const value = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    };
    const projectName = value("projectName"),
      environmentId = value("environmentId"),
      projectId = value("projectId"),
      threadId = value("threadId"),
      sessionLinePresent = value("sessionLinePresent"),
      requireSelected = value("requireSelected");
    const identity = (item: unknown): item is string =>
      typeof item === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(item);
    const initial =
      environmentId === null &&
      projectId === null &&
      threadId === null &&
      sessionLinePresent === null;
    if (
      typeof projectName !== "string" ||
      projectName.length < 1 ||
      projectName.length > 64 ||
      typeof requireSelected !== "boolean" ||
      (initial && !requireSelected) ||
      (!initial &&
        (!identity(environmentId) ||
          !identity(projectId) ||
          !identity(threadId) ||
          typeof sessionLinePresent !== "boolean")) ||
      location.origin !== "http://localhost:4901" ||
      location.search !== "" ||
      location.hash !== "" ||
      document
        .querySelector('[data-testid="environment-rail-local"]')
        ?.getAttribute("aria-checked") !== "true"
    )
      return null;
    const cards = Array.from(
      document.querySelectorAll('[data-testid^="primary-card-button-"]'),
    ).filter((card) =>
      requireSelected
        ? card.getAttribute("aria-current") === "page"
        : card.getAttribute("data-testid") === "primary-card-button-" + projectId,
    );
    if (cards.length !== 1) return null;
    const card = cards[0]!;
    const observedProject = card.getAttribute("data-testid")?.slice("primary-card-button-".length);
    if (!identity(observedProject) || (!initial && observedProject !== projectId)) return null;
    if (
      document.querySelectorAll(`[data-testid="primary-card-button-${observedProject}"]`).length !==
      1
    )
      return null;
    const row = card.closest(`[data-testid="primary-card-${observedProject}"]`);
    const group = card.closest('[data-slot="sidebar-menu-item"]');
    const header = group?.querySelectorAll('[data-sidebar="menu-button"][aria-expanded]');
    if (!row || !header || header.length !== 1 || header[0]?.textContent?.trim() !== projectName)
      return null;
    // Untouched existing threads legitimately have no session description.
    // Capture its presence from the initially selected existing primary card,
    // then require the same footprint without starting a provider session.
    const sessions = (card.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((id) => id.endsWith("-session"));
    if (
      sessions.length > 1 ||
      row.querySelectorAll('[id$="-session"]').length !== sessions.length ||
      (sessions.length === 1 &&
        document
          .getElementById(sessions[0]!)
          ?.closest(`[data-testid="primary-card-${observedProject}"]`) !== row) ||
      (!initial && (sessions.length === 1) !== sessionLinePresent)
    )
      return null;
    if (!requireSelected) return true;
    const parts = location.pathname.split("/");
    if (parts.length !== 3) return null;
    const observedEnvironment = decodeURIComponent(parts[1]!),
      observedThread = decodeURIComponent(parts[2]!);
    if (
      !identity(observedEnvironment) ||
      !identity(observedThread) ||
      location.pathname !==
        "/" + encodeURIComponent(observedEnvironment) + "/" + encodeURIComponent(observedThread) ||
      (!initial && (observedEnvironment !== environmentId || observedThread !== threadId))
    )
      return null;
    return {
      environmentId: observedEnvironment,
      projectId: observedProject,
      threadId: observedThread,
      sessionLinePresent: sessions.length === 1,
    };
  } catch {
    return null;
  }
}

/** Read the actual raw HTTP projection shape; only existence proof leaves the page. */
export async function readReloadPrimaryThread(
  input: ReloadPrimaryWorkspace & { readonly snapshotPath: string },
): Promise<boolean> {
  try {
    const own = (object: unknown, key: string) => {
      if (object === null || typeof object !== "object" || Array.isArray(object)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    };
    const environmentId = own(input, "environmentId"),
      projectId = own(input, "projectId"),
      threadId = own(input, "threadId");
    if (
      ![environmentId, projectId, threadId].every(
        (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
      ) ||
      typeof own(input, "sessionLinePresent") !== "boolean" ||
      own(input, "snapshotPath") !== "/api/orchestration/snapshot" ||
      location.origin !== "http://localhost:4901" ||
      location.search !== "" ||
      location.hash !== "" ||
      document
        .querySelector('[data-testid="environment-rail-local"]')
        ?.getAttribute("aria-checked") !== "true"
    )
      return false;
    const response = await fetch("http://localhost:4887/api/orchestration/snapshot", {
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return false;
    const snapshot: unknown = JSON.parse(text);
    const projects = own(snapshot, "projects"),
      threads = own(snapshot, "threads");
    if (!Array.isArray(projects) || !Array.isArray(threads)) return false;
    // This endpoint currently serializes raw unrenamed Rust projection rows.
    // Its existing camelCase contract disagrees; do not add compatibility aliases.
    const project = projects.filter((value) => own(value, "project_id") === projectId);
    const thread = threads.filter((value) => own(value, "thread_id") === threadId);
    return (
      project.length === 1 &&
      own(project[0], "deleted_at") === null &&
      thread.length === 1 &&
      own(thread[0], "project_id") === projectId &&
      own(thread[0], "kind") === "default" &&
      own(thread[0], "archived_at") === null &&
      own(thread[0], "deleted_at") === null &&
      own(thread[0], "branch") === null &&
      own(thread[0], "worktree_path") === null
    );
  } catch {
    return false;
  }
}
