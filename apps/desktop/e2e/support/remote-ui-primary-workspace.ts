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

export interface ReloadPrimaryThreadWitness {
  requestAdmitted: boolean | null;
  httpStatus:
    | "success"
    | "unauthorized"
    | "forbidden"
    | "not-found"
    | "client-error"
    | "server-error"
    | "redirect"
    | "other"
    | null;
  body: "parsed" | "too-large" | "unreadable" | "invalid-json" | null;
  listsAdmitted: boolean | null;
  projectMatches: "none" | "one" | "multiple" | null;
  threadMatches: "none" | "one" | "multiple" | null;
  projectLive: boolean | null;
  threadProjectMatched: boolean | null;
  threadDefault: boolean | null;
  threadUnarchived: boolean | null;
  threadUndeleted: boolean | null;
  branchNull: boolean | null;
  expectedBranchMatched: boolean | null;
  worktreeNull: boolean | null;
}

/** Project only finite own data facts; observation cannot expose arbitrary properties/getters. */
export function projectReloadPrimaryThreadWitness(
  input: unknown,
): ReloadPrimaryThreadWitness | null {
  if (input === null || typeof input !== "object") return null;
  try {
    if (Array.isArray(input)) return null;
    const fields: Record<string, unknown> = {};
    for (const key of [
      "requestAdmitted",
      "httpStatus",
      "body",
      "listsAdmitted",
      "projectMatches",
      "threadMatches",
      "projectLive",
      "threadProjectMatched",
      "threadDefault",
      "threadUnarchived",
      "threadUndeleted",
      "branchNull",
      "expectedBranchMatched",
      "worktreeNull",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined) continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      fields[key] = descriptor.value;
    }
    const flag = (key: string) => (typeof fields[key] === "boolean" ? fields[key] : null);
    const choice = <T extends readonly string[]>(key: string, choices: T): T[number] | null =>
      typeof fields[key] === "string" && choices.includes(fields[key]) ? fields[key] : null;
    return {
      requestAdmitted: flag("requestAdmitted"),
      httpStatus: choice("httpStatus", [
        "success",
        "unauthorized",
        "forbidden",
        "not-found",
        "client-error",
        "server-error",
        "redirect",
        "other",
      ] as const),
      body: choice("body", ["parsed", "too-large", "unreadable", "invalid-json"] as const),
      listsAdmitted: flag("listsAdmitted"),
      projectMatches: choice("projectMatches", ["none", "one", "multiple"] as const),
      threadMatches: choice("threadMatches", ["none", "one", "multiple"] as const),
      projectLive: flag("projectLive"),
      threadProjectMatched: flag("threadProjectMatched"),
      threadDefault: flag("threadDefault"),
      threadUnarchived: flag("threadUnarchived"),
      threadUndeleted: flag("threadUndeleted"),
      branchNull: flag("branchNull"),
      expectedBranchMatched: flag("expectedBranchMatched"),
      worktreeNull: flag("worktreeNull"),
    };
  } catch {
    return null;
  }
}

export interface ReloadPrimaryThreadProof {
  matched: boolean;
  witness: ReloadPrimaryThreadWitness | null;
}

/** Preserve the read's verdict while discarding malformed optional observation. */
export function decodeReloadPrimaryThreadProof(input: unknown): ReloadPrimaryThreadProof | null {
  if (input === null || typeof input !== "object") return null;
  let matched: boolean;
  try {
    if (Array.isArray(input)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, "matched");
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "boolean"
    )
      return null;
    matched = descriptor.value;
  } catch {
    return null;
  }
  let witness: ReloadPrimaryThreadWitness | null = null;
  try {
    const observed = Object.getOwnPropertyDescriptor(input, "witness");
    if (observed?.enumerable && Object.hasOwn(observed, "value"))
      witness = projectReloadPrimaryThreadWitness(observed.value);
  } catch {
    // Optional witness reflection cannot replace the original admitted verdict.
  }
  return { matched, witness };
}

/** Same existing read and verdict; only closed categories/flags leave the page. */
export async function readReloadPrimaryThread(
  input: ReloadPrimaryWorkspace & { readonly snapshotPath: string },
): Promise<ReloadPrimaryThreadProof> {
  const witness: ReloadPrimaryThreadWitness = {
    requestAdmitted: null,
    httpStatus: null,
    body: null,
    listsAdmitted: null,
    projectMatches: null,
    threadMatches: null,
    projectLive: null,
    threadProjectMatched: null,
    threadDefault: null,
    threadUnarchived: null,
    threadUndeleted: null,
    branchNull: null,
    expectedBranchMatched: null,
    worktreeNull: null,
  };
  const finish = (matched: boolean) => ({ matched, witness });
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
    ) {
      witness.requestAdmitted = false;
      return finish(false);
    }
    witness.requestAdmitted = true;
    const response = await fetch("http://localhost:4887/api/orchestration/snapshot", {
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    try {
      const status = response.status;
      if (Number.isInteger(status) && status >= 100 && status <= 599)
        witness.httpStatus =
          status >= 200 && status <= 299
            ? "success"
            : status === 401
              ? "unauthorized"
              : status === 403
                ? "forbidden"
                : status === 404
                  ? "not-found"
                  : status >= 400 && status <= 499
                    ? "client-error"
                    : status >= 500
                      ? "server-error"
                      : status >= 300 && status <= 399
                        ? "redirect"
                        : "other";
    } catch {
      // Optional HTTP category cannot change the original response/body admission.
    }
    if (!response.ok) return finish(false);
    witness.body = "unreadable";
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) {
      witness.body = "too-large";
      return finish(false);
    }
    witness.body = "invalid-json";
    const snapshot: unknown = JSON.parse(text);
    witness.body = "parsed";
    const projects = own(snapshot, "projects"),
      threads = own(snapshot, "threads");
    witness.listsAdmitted = Array.isArray(projects) && Array.isArray(threads);
    if (!Array.isArray(projects) || !Array.isArray(threads)) return finish(false);
    // This endpoint currently serializes raw unrenamed Rust projection rows.
    // Its existing camelCase contract disagrees; do not add compatibility aliases.
    const project = projects.filter((value) => own(value, "project_id") === projectId);
    const thread = threads.filter((value) => own(value, "thread_id") === threadId);
    const count = (size: number) => (size === 0 ? "none" : size === 1 ? "one" : "multiple");
    witness.projectMatches = count(project.length);
    witness.threadMatches = count(thread.length);
    const flag = (row: unknown, key: string, predicate: (value: unknown) => boolean) => {
      const value = own(row, key);
      return value === undefined ? null : predicate(value);
    };
    if (project.length === 1)
      witness.projectLive = flag(project[0], "deleted_at", (value) => value === null);
    if (thread.length === 1) {
      witness.threadProjectMatched = flag(thread[0], "project_id", (value) => value === projectId);
      witness.threadDefault = flag(thread[0], "kind", (value) => value === "default");
      witness.threadUnarchived = flag(thread[0], "archived_at", (value) => value === null);
      witness.threadUndeleted = flag(thread[0], "deleted_at", (value) => value === null);
      witness.branchNull = flag(thread[0], "branch", (value) => value === null);
      witness.expectedBranchMatched = flag(thread[0], "branch", (value) => value === "main");
      witness.worktreeNull = flag(thread[0], "worktree_path", (value) => value === null);
    }
    return finish(
      project.length === 1 &&
        own(project[0], "deleted_at") === null &&
        thread.length === 1 &&
        own(thread[0], "project_id") === projectId &&
        own(thread[0], "kind") === "default" &&
        own(thread[0], "archived_at") === null &&
        own(thread[0], "deleted_at") === null &&
        // initializeGitProject owns this fixture's main branch. The active UI may
        // synchronize its initially null default-thread branch from live Git.
        (own(thread[0], "branch") === null || own(thread[0], "branch") === "main") &&
        own(thread[0], "worktree_path") === null,
    );
  } catch {
    return finish(false);
  }
}
