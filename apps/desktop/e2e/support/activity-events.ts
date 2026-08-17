// @effect-diagnostics globalDate:off - This synchronous WDIO fixture stamps native protocol events outside an Effect runtime.

export const desktopActivityFixture = {
  actor: {
    id: "bibcode-ui-reviewer-thread",
    name: "Fixture reviewer",
    role: "reviewer",
  },
  backgroundTask: {
    id: "bibcode-ui-background-task",
    command: "fixture background task",
  },
  project: {
    id: "bibcode-ui-activity-project",
    title: "BiBCode UI Fixture",
  },
  rootThreadId: "bibcode-ui-provider-thread",
  thread: {
    id: "bibcode-ui-activity-thread",
    title: "Activity acceptance fixture",
  },
} as const;

export const desktopActivityMarkerFileName =
  `.bibcode-task4-activity-${desktopActivityFixture.rootThreadId}` as const;

const desktopActivityModelSelection = {
  instanceId: "codex",
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "medium" }],
} as const;

/**
 * Returns the canonical orchestration sequence used by the packaged activity
 * spec. Dispatching the turn through the real RPC also starts the fixture
 * provider session, so the spec never depends on the add-project/new-chat UI.
 */
function activityCommandTimestamp(observedAtMs: number, offsetMs: number): string {
  return new Date(observedAtMs + offsetMs).toISOString();
}

export function desktopActivitySessionCommands(
  projectPath: string,
  observedAtMs: number = Date.now(),
) {
  return [
    {
      type: "project.create",
      commandId: "bibcode-ui-activity-project-create",
      projectId: desktopActivityFixture.project.id,
      title: desktopActivityFixture.project.title,
      workspaceRoot: projectPath,
      defaultModelSelection: desktopActivityModelSelection,
      createdAt: activityCommandTimestamp(observedAtMs, -2_000),
    },
    {
      type: "thread.create",
      commandId: "bibcode-ui-activity-thread-create",
      threadId: desktopActivityFixture.thread.id,
      projectId: desktopActivityFixture.project.id,
      title: desktopActivityFixture.thread.title,
      modelSelection: desktopActivityModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: activityCommandTimestamp(observedAtMs, -1_000),
    },
    {
      type: "thread.turn.start",
      commandId: "bibcode-ui-activity-turn-start",
      threadId: desktopActivityFixture.thread.id,
      message: {
        messageId: "bibcode-ui-activity-message",
        role: "user",
        text: "load deterministic activity",
        attachments: [],
      },
      modelSelection: desktopActivityModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: activityCommandTimestamp(observedAtMs, 0),
    },
  ] as const;
}

export function desktopActivityFollowupTurnCommand(observedAtMs: number = Date.now()) {
  return {
    type: "thread.turn.start",
    commandId: "bibcode-ui-activity-followup-turn-start",
    threadId: desktopActivityFixture.thread.id,
    message: {
      messageId: "bibcode-ui-activity-followup-message",
      role: "user",
      text: "publish deterministic live activity update",
      attachments: [],
    },
    modelSelection: desktopActivityModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: activityCommandTimestamp(observedAtMs, 0),
  } as const;
}

export function desktopActivityComposerFollowupTurnCommand(observedAtMs: number = Date.now()) {
  return {
    type: "thread.turn.start",
    commandId: "bibcode-ui-activity-composer-followup-turn-start",
    threadId: desktopActivityFixture.thread.id,
    message: {
      messageId: "bibcode-ui-activity-composer-followup-message",
      role: "user",
      text: "publish deterministic composer activity update",
      attachments: [],
    },
    modelSelection: desktopActivityModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: activityCommandTimestamp(observedAtMs, 0),
  } as const;
}

export const desktopActivityAccessibleNames = {
  collapsedSummary:
    "Expand activity summary: 1 active subagent, 0 done subagents, 1 active background task, 0 done background tasks",
  expandedSummary:
    "Collapse activity summary: 1 active subagent, 0 done subagents, 1 active background task, 0 done background tasks",
  subagents: "Open Subagents: 1 active, 0 done",
} as const;
