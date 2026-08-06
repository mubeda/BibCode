import type {
  ScopedThreadRef,
  TerminalCloseInput,
  TerminalLaunchCommand,
  TerminalOpenInput,
} from "@bibcode/contracts";

import type {
  CenterTerminalPlacement,
  CenterTerminalPlacementValidation,
  OpenTerminalPanelOptions,
} from "./centerPanelStore";

export interface CenterTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
  readonly label?: string;
  readonly command?: TerminalLaunchCommand;
}

export interface CreateCenterTerminalInput {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly placement: CenterTerminalPlacement;
  readonly launch: CenterTerminalLaunch | null;
}

export type CenterTerminalCreationResult =
  | { readonly status: "opened"; readonly terminalId: string }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export interface CenterTerminalActionDependencies {
  readonly validatePlacement: (
    placement: CenterTerminalPlacement,
  ) => CenterTerminalPlacementValidation;
  readonly canSplit: (groupId: string, direction: "right" | "down") => boolean;
  readonly openSession: (
    input: TerminalOpenInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  readonly place: (
    terminalId: string,
    placement: CenterTerminalPlacement,
    options?: OpenTerminalPanelOptions,
  ) => boolean;
  readonly closeSession: (input: TerminalCloseInput) => Promise<void>;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasLaunchContext(input: CreateCenterTerminalInput): input is CreateCenterTerminalInput & {
  readonly launch: CenterTerminalLaunch;
} {
  return Boolean(
    input.threadRef &&
    hasText(input.threadRef.environmentId) &&
    hasText(input.threadRef.threadId) &&
    hasText(input.terminalId) &&
    input.launch &&
    hasText(input.launch.cwd) &&
    (input.launch.worktreePath === null || hasText(input.launch.worktreePath)),
  );
}

function placementRejectionReason(
  validation: Exclude<CenterTerminalPlacementValidation, { readonly ok: true }>,
): string {
  return validation.reason === "pane-limit"
    ? "Center pane limit reached."
    : "Center pane is no longer available.";
}

export async function createCenterTerminal(
  input: CreateCenterTerminalInput,
  dependencies: CenterTerminalActionDependencies,
): Promise<CenterTerminalCreationResult> {
  if (!hasLaunchContext(input)) {
    return { status: "rejected", reason: "Terminal launch context is unavailable." };
  }

  const validation = dependencies.validatePlacement(input.placement);
  if (!validation.ok) {
    return { status: "rejected", reason: placementRejectionReason(validation) };
  }
  if (
    input.placement.type === "split" &&
    !dependencies.canSplit(input.placement.groupId, input.placement.direction)
  ) {
    return { status: "rejected", reason: "Center pane is too small to split." };
  }

  const launch = input.launch;
  const openResult = await dependencies.openSession({
    threadId: input.threadRef.threadId,
    terminalId: input.terminalId,
    cwd: launch.cwd,
    worktreePath: launch.worktreePath,
    env: launch.env,
    ...(launch.command !== undefined ? { command: launch.command } : {}),
  });
  if (!openResult.ok) {
    return { status: "failed", reason: openResult.reason };
  }

  const placed = dependencies.place(input.terminalId, input.placement, {
    ...(launch.label !== undefined ? { label: launch.label } : {}),
    ...(launch.command !== undefined ? { command: launch.command } : {}),
  });
  if (!placed) {
    await dependencies.closeSession({
      threadId: input.threadRef.threadId,
      terminalId: input.terminalId,
      deleteHistory: true,
    });
    return { status: "failed", reason: "Center terminal placement is no longer available." };
  }

  return { status: "opened", terminalId: input.terminalId };
}
