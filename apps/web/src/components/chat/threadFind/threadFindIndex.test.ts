import { describe, expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "../../../session-logic";
import {
  deriveFindEntries,
  firstMatchFrom,
  matchPosition,
  reconcileActiveMatch,
  stepMatch,
  ThreadFindIndex,
  type FindCounts,
  type FindEntry,
  type FindProjector,
  type FindScheduler,
} from "./threadFindIndex";
import { prepareFindQuery, projectFindSource } from "./threadFindText";

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  second: number,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at(second),
    message: {
      id: id as never,
      role,
      text,
      turnId: null,
      createdAt: at(second),
      updatedAt: at(second),
      streaming: false,
    },
  };
}

function work(
  id: string,
  command: string,
  second: number,
  options: { inProgress?: boolean } = {},
): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: at(second),
    entry: {
      id: `${id}-log`,
      createdAt: at(second),
      label: "Run",
      command,
      tone: "tool",
      detail: "output mentions build too",
      ...(options.inProgress ? { toolLifecycleStatus: "inProgress" as const } : {}),
    },
  };
}

function plan(id: string, planMarkdown: string, second: number): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: at(second),
    proposedPlan: {
      id,
      turnId: null,
      planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at(second),
      updatedAt: at(second),
    } as never,
  };
}

const CONTEXT = { cwd: undefined };
const NO_SCHEDULER_COST: FindScheduler = { now: () => 0, yield: () => Promise.resolve() };

async function scanCounts(
  entries: ReadonlyArray<FindEntry>,
  query: string,
  index = new ThreadFindIndex(),
) {
  const outcome = await index.scan({
    entries,
    context: CONTEXT,
    query: prepareFindQuery(query)!,
    startIndex: 0,
    signal: { aborted: false },
  });
  return outcome!;
}

describe("deriveFindEntries", () => {
  const timeline = [
    message("user-1", "user", "Please run the build", 0),
    message("system-1", "system", "build system note", 1),
    message("answer-1", "assistant", "The build passed.", 2),
    message("empty-1", "assistant", "", 3),
    work("tool-1", "npm run build", 4),
    work("tool-busy", "npm run build --watch", 5, { inProgress: true }),
    plan("plan-1", "# Build plan\n\nRun the build twice.", 6),
  ];
  const queued = {
    ...(
      message("queued-1", "user", "and build docs", 7) as Extract<
        TimelineEntry,
        { kind: "message" }
      >
    ).message,
    delivery: { state: "queued" as const, provider: "codex" as never },
  };
  const entries = deriveFindEntries({
    timelineEntries: timeline,
    queuedMessages: [queued, { ...queued, id: "queued-2" as never }],
    queuedStatuses: [{} as never],
    skills: [],
  });

  it("lists what the timeline shows in row order, queued messages last", () => {
    expect(entries.map((entry) => entry.entryId)).toEqual([
      "user-1",
      "answer-1",
      "tool-1",
      "plan-1",
      "queued-message:queued-1",
    ]);
    // A tool row's own disclosures live under its work entry id.
    expect(entries.find((entry) => entry.entryId === "tool-1")?.disclosureId).toBe("tool-1-log");
  });

  it("counts each entry's displayed text, but not tool output or an empty reply", async () => {
    const { counts, total } = await scanCounts(entries, "build");
    // User, reply, command (not its output), plan title and body, queued message.
    expect(counts).toEqual([1, 1, 1, 2, 1]);
    expect(total).toBe(6);
    expect((await scanCounts(entries, "(empty response)")).total).toBe(0);
    expect((await scanCounts(entries, "output")).total).toBe(0);
  });

  it("opens a long body, a long plan, and every tool row to show its match", () => {
    const longText = Array.from({ length: 12 }, (_, line) => `line ${line}`).join("\n");
    const [user, longPlan] = deriveFindEntries({
      timelineEntries: [
        message("long", "user", longText, 0),
        plan("long-plan", `# Title\n\n${longText}\n${longText}`, 1),
      ],
      skills: [],
    });
    expect(user?.reveal?.key).toBe("body");
    expect(longPlan?.reveal).toMatchObject({ key: "plan" });
    expect(longPlan?.reveal?.scopes.has("plan-title")).toBe(false);
    expect(entries.find((entry) => entry.entryId === "tool-1")?.reveal?.key).toBe("tool");
    expect(entries.find((entry) => entry.entryId === "answer-1")?.reveal).toBeNull();
  });

  it("projects a user body's Markdown parts around terminal-context labels", async () => {
    const [entry] = deriveFindEntries({
      timelineEntries: [
        message(
          "ctx",
          "user",
          "Check @terminal-1:1-2 then fix\n\n<terminal_context>\n- Terminal 1 lines 1-2:\n  1 | npm test\n</terminal_context>",
          0,
        ),
      ],
      skills: [],
    });
    expect(entry?.sources.map((source) => source.scope)).toEqual(["md:0", "md:1"]);
    expect((await scanCounts([entry!], "npm test")).total).toBe(0);
    expect((await scanCounts([entry!], "fix")).total).toBe(1);
  });
});

describe("ThreadFindIndex", () => {
  it("does not parse unchanged text again", async () => {
    const project = vi.fn(projectFindSource);
    const index = new ThreadFindIndex({ projector: { project }, scheduler: NO_SCHEDULER_COST });
    const entries = deriveFindEntries({
      timelineEntries: [
        message("a", "assistant", "alpha beta", 0),
        message("b", "user", "beta", 1),
      ],
      skills: [],
    });
    await scanCounts(entries, "beta", index);
    expect(project).toHaveBeenCalledTimes(2);

    // New entry objects with the same text, as a resync or an activity change makes.
    const rederived = deriveFindEntries({
      timelineEntries: [
        message("a", "assistant", "alpha beta", 0),
        message("b", "user", "beta", 1),
      ],
      skills: [],
    });
    await scanCounts(rederived, "alpha", index);
    expect(project).toHaveBeenCalledTimes(2);

    // A streamed delta parses only the entry that changed, and drops its old projection.
    const streamed = deriveFindEntries({
      timelineEntries: [
        message("a", "assistant", "alpha beta gamma", 0),
        message("b", "user", "beta", 1),
      ],
      skills: [],
    });
    expect((await scanCounts(streamed, "gamma", index)).total).toBe(1);
    expect(project).toHaveBeenCalledTimes(3);
    expect(index.cachedSourceCount).toBe(2);
  });

  it("shares a projection still in flight with the scan that supersedes its own", async () => {
    const pending: Array<() => void> = [];
    const project = vi.fn(
      (source: Parameters<typeof projectFindSource>[0], context: typeof CONTEXT) =>
        new Promise<ReturnType<typeof projectFindSource>>((resolve) => {
          pending.push(() => resolve(projectFindSource(source, context)));
        }),
    );
    const index = new ThreadFindIndex({ projector: { project }, scheduler: NO_SCHEDULER_COST });
    const entries = deriveFindEntries({
      timelineEntries: [message("a", "assistant", "a large reply", 0)],
      skills: [],
    });
    const first = { aborted: false };
    const superseded = index.scan({
      entries,
      context: CONTEXT,
      query: "large",
      startIndex: 0,
      signal: first,
    });
    // Typing on supersedes the scan while its worker request is queued.
    first.aborted = true;
    const latest = index.scan({
      entries,
      context: CONTEXT,
      query: "large r",
      startIndex: 0,
      signal: { aborted: false },
    });
    expect(project).toHaveBeenCalledTimes(1);

    for (const resolve of pending.splice(0)) resolve();
    expect(await superseded).toBeNull();
    expect((await latest)?.total).toBe(1);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it("yields between entries after a slice's budget, and finishes an oversized entry in one", async () => {
    let clock = 0;
    const yields: number[] = [];
    const projector: FindProjector = {
      project: (source, context) => {
        // The second entry alone runs far past the slice budget.
        clock += source.text.includes("huge") ? 40 : 1;
        return projectFindSource(source, context);
      },
    };
    const scheduler: FindScheduler = {
      now: () => clock,
      yield: () => {
        yields.push(clock);
        return Promise.resolve();
      },
    };
    const index = new ThreadFindIndex({ projector, scheduler });
    const entries = deriveFindEntries({
      timelineEntries: [
        message("a", "user", "small one", 0),
        message("b", "assistant", "huge reply", 1),
        message("c", "user", "small two", 2),
      ],
      skills: [],
    });
    const outcome = await scanCounts(entries, "small", index);
    expect(outcome.counts).toEqual([1, 0, 1]);
    // One yield, after the oversized entry, and the scan went on.
    expect(yields).toEqual([41]);
  });

  it("starts at the viewport's entry and reports the first match from there", async () => {
    const index = new ThreadFindIndex({ scheduler: NO_SCHEDULER_COST });
    const entries = deriveFindEntries({
      timelineEntries: [
        message("a", "user", "needle first", 0),
        message("b", "assistant", "nothing", 1),
        message("c", "user", "needle later", 2),
      ],
      skills: [],
    });
    const firsts: number[] = [];
    const outcome = await index.scan({
      entries,
      context: CONTEXT,
      query: prepareFindQuery("needle")!,
      startIndex: 1,
      signal: { aborted: false },
      onFirstMatch: (entryIndex) => firsts.push(entryIndex),
    });
    expect(firsts).toEqual([2]);
    expect(outcome?.counts).toEqual([1, 0, 1]);
  });

  it("stops when the scan is superseded", async () => {
    const signal = { aborted: false };
    let clock = 0;
    const scheduler: FindScheduler = {
      // Every entry runs a whole slice.
      now: () => (clock += 10),
      yield: () => {
        signal.aborted = true;
        return Promise.resolve();
      },
    };
    const index = new ThreadFindIndex({ scheduler });
    const entries = deriveFindEntries({
      timelineEntries: [message("a", "user", "x", 0), message("b", "user", "x", 1)],
      skills: [],
    });
    expect(
      await index.scan({
        entries,
        context: CONTEXT,
        query: "x",
        startIndex: 0,
        signal,
      }),
    ).toBeNull();
  });

  it("accepts queries of 1 and 256 units", async () => {
    const long = "y".repeat(256);
    const entries = deriveFindEntries({
      timelineEntries: [message("a", "user", `x ${long}`, 0)],
      skills: [],
    });
    expect((await scanCounts(entries, "x")).total).toBe(1);
    expect((await scanCounts(entries, long)).total).toBe(1);
  });
});

describe("match selection", () => {
  const counts = (pairs: ReadonlyArray<readonly [string, number]>): FindCounts => ({
    entries: pairs.map(([entryId]) => ({ entryId })),
    counts: pairs.map(([, count]) => count),
  });
  const base = counts([
    ["a", 2],
    ["b", 0],
    ["c", 1],
  ]);

  it("starts at or below the viewport and wraps to the first match", () => {
    expect(firstMatchFrom(base, 1)).toEqual({ entryId: "c", occurrence: 0 });
    expect(
      firstMatchFrom(
        counts([
          ["a", 1],
          ["b", 0],
        ]),
        1,
      ),
    ).toEqual({ entryId: "a", occurrence: 0 });
    expect(firstMatchFrom(counts([["a", 0]]), 0)).toBeNull();
  });

  it("steps through matches in order and wraps at both ends", () => {
    const first = { entryId: "a", occurrence: 0 };
    const second = stepMatch(base, first, "next")!;
    expect(second).toEqual({ entryId: "a", occurrence: 1 });
    const third = stepMatch(base, second, "next")!;
    expect(third).toEqual({ entryId: "c", occurrence: 0 });
    expect(stepMatch(base, third, "next")).toEqual(first);
    expect(stepMatch(base, first, "previous")).toEqual(third);
    expect(stepMatch(base, third, "previous")).toEqual(second);
    expect(matchPosition(base, third)).toBe(2);
  });

  it("keeps the selection when an earlier match arrives, or a streaming entry grows", () => {
    const active = { entryId: "c", occurrence: 0 };
    const inserted = counts([
      ["new", 3],
      ["a", 2],
      ["b", 0],
      ["c", 1],
    ]);
    expect(reconcileActiveMatch(inserted, active, ["a", "b", "c"])).toBe(active);
    expect(matchPosition(inserted, active)).toBe(5);
    const grown = counts([
      ["a", 2],
      ["b", 0],
      ["c", 4],
    ]);
    expect(reconcileActiveMatch(grown, active, ["a", "b", "c"])).toBe(active);
  });

  it("moves to the next match when the active occurrence disappears", () => {
    const shrunk = counts([
      ["a", 1],
      ["b", 0],
      ["c", 1],
    ]);
    expect(reconcileActiveMatch(shrunk, { entryId: "a", occurrence: 1 }, ["a", "b", "c"])).toEqual({
      entryId: "c",
      occurrence: 0,
    });
    const removed = counts([
      ["a", 2],
      ["c", 1],
    ]);
    expect(reconcileActiveMatch(removed, { entryId: "b", occurrence: 0 }, ["a", "b", "c"])).toEqual(
      {
        entryId: "c",
        occurrence: 0,
      },
    );
  });
});
