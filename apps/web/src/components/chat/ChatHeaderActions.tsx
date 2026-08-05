import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@bibcode/contracts";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { memo, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { type ProviderInstanceEntry } from "~/providerInstances";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { ChatHeaderPanelMenu } from "./ChatHeaderPanelMenu";
import { OpenInPicker } from "./OpenInPicker";
import { type ProviderTerminalAction } from "./providerTerminalActions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "~/lib/utils";

interface ChatHeaderActionsProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: Pick<ServerSettings, "providerInstances" | "providers" | "providerSessionDefaults">;
  canCreatePanel: boolean;
  onCreateChatPanel: (entry: ProviderInstanceEntry) => void;
  onOpenTerminalPanel: () => void;
  onOpenProviderTerminalPanel: (action: ProviderTerminalAction) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeaderActions = memo(function ChatHeaderActions({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  providerStatuses,
  settings,
  canCreatePanel,
  onCreateChatPanel,
  onOpenTerminalPanel,
  onOpenProviderTerminalPanel,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderActionsProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  // Bumped to ask ProjectScriptsControl to open its "Add action" dialog — the
  // entry point that replaces its old bare "+" (now driven from the panel menu).
  const [addDialogRequestId, setAddDialogRequestId] = useState(0);
  return (
    <div
      data-chat-header-actions
      className={cn(
        "@container/header-actions relative z-10 flex shrink-0 items-center justify-end gap-2 bg-background @3xl/header-actions:gap-3",
        rightPanelOpen ? "pr-0" : "pr-16",
      )}
    >
      <ChatHeaderPanelMenu
        providerStatuses={providerStatuses}
        settings={settings}
        canCreatePanel={canCreatePanel}
        onCreateChatPanel={onCreateChatPanel}
        onOpenTerminalPanel={onOpenTerminalPanel}
        onOpenProviderTerminalPanel={onOpenProviderTerminalPanel}
        onAddCustomAction={() => setAddDialogRequestId((id) => id + 1)}
      />
      {activeProjectScripts && (
        <ProjectScriptsControl
          scripts={activeProjectScripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          addDialogRequestId={addDialogRequestId}
          onRunScript={onRunProjectScript}
          onAddScript={onAddProjectScript}
          onUpdateScript={onUpdateProjectScript}
          onDeleteScript={onDeleteProjectScript}
        />
      )}
      {showOpenInPicker && (
        <OpenInPicker
          environmentId={activeThreadEnvironmentId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
        />
      )}
      {activeProjectName && (
        <GitActionsControl
          gitCwd={gitCwd}
          activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
          {...(draftId ? { draftId } : {})}
          // Trigger hidden: git actions live in the Source Control panel, but
          // the control must stay mounted for its thread-branch sync effect.
          hideTrigger
        />
      )}
    </div>
  );
});
