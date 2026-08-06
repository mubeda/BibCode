import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@bibcode/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  primaryEnvironmentId: "environment-primary" as EnvironmentId | null,
  panelProps: null as Record<string, unknown> | null,
  gitProps: null as Record<string, unknown> | null,
  projectController: {
    scripts: [] as unknown[],
    primaryScript: null as unknown,
    openAddDialog: vi.fn(),
    openEditDialog: vi.fn(),
    runScript: vi.fn(),
  },
  projectControllerProps: [] as Array<Record<string, unknown>>,
  expandedControllers: [] as unknown[],
  dialogControllers: [] as unknown[],
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => harness.primaryEnvironmentId,
}));

vi.mock("./ChatHeaderPanelMenu", () => ({
  ChatHeaderPanelMenu: (props: Record<string, unknown>) => {
    harness.panelProps = props;
    return <div data-testid="panel-menu" />;
  },
}));

vi.mock("../ProjectScriptsControl", () => ({
  default: () => <div data-testid="scripts-control" />,
  useProjectScriptsController: (props: Record<string, unknown>) => {
    harness.projectControllerProps.push(props);
    harness.projectController.scripts = props["scripts"] as unknown[];
    harness.projectController.primaryScript = harness.projectController.scripts[0] ?? null;
    return harness.projectController;
  },
  ProjectScriptsExpandedActions: ({ controller }: { controller: unknown }) => {
    harness.expandedControllers.push(controller);
    return harness.projectController.primaryScript ? <div data-testid="scripts-control" /> : null;
  },
  ProjectScriptsDialogs: ({ controller }: { controller: unknown }) => {
    harness.dialogControllers.push(controller);
    return null;
  },
}));

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => <div data-testid="open-in-picker" />,
}));

vi.mock("../GitActionsControl", () => ({
  default: (props: Record<string, unknown>) => {
    harness.gitProps = props;
    return <div data-testid="git-actions" />;
  },
}));

import { ChatHeaderActions } from "./ChatHeaderActions";

const environmentId = EnvironmentId.make("environment-primary");

function props(
  overrides: Partial<ComponentProps<typeof ChatHeaderActions>> = {},
): ComponentProps<typeof ChatHeaderActions> {
  return {
    activeThreadEnvironmentId: environmentId,
    activeThreadId: ThreadId.make("thread-1"),
    activeProjectName: undefined,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: {} as never,
    availableEditors: [],
    reserveTitlebarControls: true,
    gitCwd: null,
    providerStatuses: [],
    settings: {
      providerInstances: DEFAULT_SERVER_SETTINGS.providerInstances,
      providers: DEFAULT_SERVER_SETTINGS.providers,
      providerSessionDefaults: DEFAULT_SERVER_SETTINGS.providerSessionDefaults,
    },
    canCreatePanel: false,
    onCreateChatPanel: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenProviderTerminalPanel: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(),
    onUpdateProjectScript: vi.fn(),
    onDeleteProjectScript: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  harness.primaryEnvironmentId = environmentId;
  harness.panelProps = null;
  harness.gitProps = null;
  harness.projectController.openAddDialog.mockReset();
  harness.projectControllerProps.length = 0;
  harness.expandedControllers.length = 0;
  harness.dialogControllers.length = 0;
});

describe("ChatHeaderActions rendering", () => {
  it("renders a fixed action cluster without the thread title", () => {
    const markup = renderToStaticMarkup(<ChatHeaderActions {...props()} />);

    expect(markup).toContain("data-chat-header-actions");
    expect(markup).toContain("relative z-10");
    expect(markup).toContain("bg-background");
    expect(markup).not.toContain("Thread title");
    expect(markup).toContain("pr-16");
  });

  it("omits project actions when no project is active", () => {
    const markup = renderToStaticMarkup(<ChatHeaderActions {...props()} />);

    expect(markup).toContain("pr-16");
    expect(markup).not.toContain("scripts-control");
    expect(markup).not.toContain("open-in-picker");
    expect(markup).not.toContain("git-actions");
  });

  it("renders every project action and forwards a draft identity", () => {
    const onOpenProviderTerminalPanel = vi.fn();
    const markup = renderToStaticMarkup(
      <ChatHeaderActions
        {...props({
          activeProjectName: "Project",
          activeProjectScripts: [
            {
              id: "dev",
              name: "Dev",
              command: "vp dev",
              icon: "play",
              runOnWorktreeCreate: false,
            },
          ],
          reserveTitlebarControls: false,
          draftId: "draft-1" as never,
          onOpenProviderTerminalPanel,
        })}
      />,
    );

    expect(markup).toContain("pr-0");
    expect(markup).toContain("scripts-control");
    expect(markup).toContain("open-in-picker");
    expect(markup).toContain("git-actions");
    expect(harness.gitProps).toMatchObject({ draftId: "draft-1", hideTrigger: true });
    expect(harness.panelProps?.["onOpenProviderTerminalPanel"]).toBe(onOpenProviderTerminalPanel);

    (harness.panelProps!["onAddCustomAction"] as () => void)();
  });

  it("owns one project-script controller for expanded actions, panel Add, and dialogs", () => {
    renderToStaticMarkup(
      <ChatHeaderActions {...props({ activeProjectName: "Project", activeProjectScripts: [] })} />,
    );

    expect(harness.projectControllerProps).toHaveLength(1);
    expect(harness.expandedControllers).toEqual([harness.projectController]);
    expect(harness.dialogControllers).toEqual([harness.projectController]);

    (harness.panelProps!["onAddCustomAction"] as () => void)();
    expect(harness.projectController.openAddDialog).toHaveBeenCalledOnce();
  });

  it("omits the local editor picker for a remote environment", () => {
    harness.primaryEnvironmentId = EnvironmentId.make("different");
    const markup = renderToStaticMarkup(
      <ChatHeaderActions
        {...props({ activeProjectName: "Remote project", activeProjectScripts: [] })}
      />,
    );

    expect(markup).not.toContain("open-in-picker");
    expect(markup).toContain("git-actions");
    expect(harness.gitProps).not.toHaveProperty("draftId");
  });

  it("reserves titlebar space only when requested by the focused pane", () => {
    const reserved = renderToStaticMarkup(
      <ChatHeaderActions {...props()} reserveTitlebarControls />,
    );
    const unreserved = renderToStaticMarkup(
      <ChatHeaderActions {...props()} reserveTitlebarControls={false} />,
    );

    expect(reserved).toContain("pr-16");
    expect(unreserved).toContain("pr-0");
  });
});
