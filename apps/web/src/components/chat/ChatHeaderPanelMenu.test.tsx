import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  menuItems: [] as Array<Record<string, unknown>>,
  tooltipReasons: [] as string[],
  providerTerminalActionsAvailable: true,
  providerTerminalActionDisabledReason: null as string | null,
  providerTerminalFallback: null as Record<string, unknown> | null,
  subTriggers: [] as Array<Record<string, unknown>>,
  archived: {
    snapshots: [] as Array<{ environmentId: string; snapshot: { threads: unknown[] } }>,
    isLoading: false,
    error: null,
  },
}));

vi.mock("~/lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => harness.archived,
}));

vi.mock("~/providerInstances", () => ({
  applyProviderInstanceSettings: (entries: unknown) => entries,
  deriveProviderInstanceEntries: () => [],
}));
vi.mock("./ChatHeaderPanelMenu.logic", () => ({
  buildPanelMenuModel: () => harness.items,
}));
vi.mock("./providerTerminalActions", () => ({
  resolveProviderTerminalAction: (entry: Record<string, unknown>) =>
    harness.providerTerminalActionsAvailable
      ? {
          entry,
          label: `${entry.displayName} Terminal`,
          command: harness.providerTerminalActionDisabledReason
            ? null
            : {
                executable: String(entry.instanceId),
                args: ["--provider-terminal"],
                label: `${entry.displayName} Terminal`,
              },
          disabledReason: harness.providerTerminalActionDisabledReason,
          ...(harness.providerTerminalFallback
            ? { fallback: harness.providerTerminalFallback }
            : {}),
        }
      : null,
}));
vi.mock("./ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => <span data-provider-icon />,
}));
vi.mock("../CenterHeaderIconButton", () => ({
  CenterHeaderIconButton: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" data-center-header-icon-control {...props}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children, render }: { children?: React.ReactNode; render?: React.ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  MenuPopup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuSeparator: () => <hr />,
  MenuSub: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuSubTrigger: (props: Record<string, unknown>) => {
    harness.subTriggers.push(props);
    return (
      <button disabled={props.disabled as boolean}>{props.children as React.ReactNode}</button>
    );
  },
  MenuSubPopup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  MenuItem: (props: Record<string, unknown>) => {
    harness.menuItems.push(props);
    return (
      <button disabled={props.disabled as boolean}>{props.children as React.ReactNode}</button>
    );
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => {
    harness.tooltipReasons.push(String(children));
    return <span>{children}</span>;
  },
}));

import { ChatHeaderPanelMenu } from "./ChatHeaderPanelMenu";

beforeEach(() => {
  harness.items = [];
  harness.menuItems.length = 0;
  harness.tooltipReasons.length = 0;
  harness.providerTerminalActionsAvailable = true;
  harness.providerTerminalActionDisabledReason = null;
  harness.providerTerminalFallback = null;
  harness.subTriggers.length = 0;
  harness.archived = { snapshots: [], isLoading: false, error: null };
});

function panelItem(overrides: Record<string, unknown> = {}) {
  return {
    entry: {
      instanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      accentColor: null,
    },
    disabled: false,
    disabledReason: null,
    ...overrides,
  };
}

function render(canCreatePanel: boolean) {
  const props = {
    providerStatuses: [],
    settings: { providerInstances: {}, providers: {}, providerSessionDefaults: {} },
    canCreatePanel,
    environmentId: "environment-1",
    hostThreadId: "host-1",
    onCreateChatPanel: vi.fn(),
    onReopenChatPanel: vi.fn(),
    onOpenTerminalPanel: vi.fn(),
    onOpenProviderTerminalPanel: vi.fn(),
    onAddCustomAction: vi.fn(),
  } as unknown as React.ComponentProps<typeof ChatHeaderPanelMenu>;
  return { markup: renderToStaticMarkup(<ChatHeaderPanelMenu {...props} />), props };
}

describe("ChatHeaderPanelMenu", () => {
  it("renders enabled providers and terminal/custom actions", () => {
    harness.items = [panelItem()];
    const { markup, props } = render(true);

    expect(markup).toContain("Codex");
    expect(markup).toContain("Open Terminal");
    expect(markup).toContain("Codex Terminal");
    expect(markup).toContain("Add custom action");
    expect(markup).toContain('aria-label="New panel"');
    expect(markup).toContain('data-center-header-icon-control="true"');
    expect(markup.indexOf("Open Terminal")).toBeLessThan(markup.indexOf("Codex Terminal"));
    expect(markup.indexOf("Codex Terminal")).toBeLessThan(markup.indexOf("Add custom action"));
    expect(markup.match(/<hr/g)).toHaveLength(3);
    expect(harness.tooltipReasons).toEqual([]);
    (harness.menuItems[0]!.onClick as () => void)();
    (harness.menuItems[1]!.onClick as () => void)();
    (harness.menuItems[2]!.onClick as () => void)();
    (harness.menuItems[3]!.onClick as () => void)();
    expect(props.onCreateChatPanel).toHaveBeenCalledOnce();
    expect(props.onOpenTerminalPanel).toHaveBeenCalledOnce();
    expect(props.onOpenProviderTerminalPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Codex Terminal",
        command: expect.objectContaining({ executable: "codex" }),
      }),
    );
    expect(props.onAddCustomAction).toHaveBeenCalledOnce();
  });

  it("explains provider-specific and thread-level disabled states", () => {
    harness.items = [panelItem({ disabled: true, disabledReason: "Provider unavailable" })];
    render(true);
    expect(harness.tooltipReasons).toEqual(["Provider unavailable", "Provider unavailable"]);
    expect(harness.menuItems[0]).toMatchObject({ disabled: true });
    expect(harness.menuItems[2]).toMatchObject({ disabled: true });

    harness.menuItems.length = 0;
    harness.tooltipReasons.length = 0;
    harness.items = [panelItem({ disabled: false, disabledReason: null })];
    render(false);
    expect(harness.tooltipReasons).toEqual([
      "Available once this thread has started.",
      "Available once this thread has started.",
      "Available once this thread has started.",
      "Available once this thread has started.",
    ]);
    expect(harness.subTriggers[0]).toMatchObject({ disabled: true });
    expect(harness.menuItems[0]).toMatchObject({ disabled: true });
    expect(harness.menuItems[1]).toMatchObject({ disabled: true });
    expect(harness.menuItems[2]).toMatchObject({ disabled: true });
  });

  it("keeps reopen in the chat section when the provider list is empty", () => {
    const { markup } = render(true);
    expect(markup).toContain("Reopen closed chat");
    expect(markup.match(/<hr/g)).toHaveLength(2);
  });

  it("lists the host's ten newest closed chats and reopens the chosen one", () => {
    const panel = (index: number, overrides: Record<string, unknown> = {}) => ({
      id: `panel-${index}`,
      kind: "panel",
      hostThreadId: "host-1",
      title: `Panel — Chat ${index}`,
      archivedAt: `2026-10-08T00:00:${String(index).padStart(2, "0")}.000Z`,
      ...overrides,
    });
    harness.archived.snapshots = [
      {
        environmentId: "environment-1",
        snapshot: {
          threads: [
            ...Array.from({ length: 12 }, (_, index) => panel(index + 1)),
            panel(40, { hostThreadId: "other-host", title: "Panel — Other host" }),
            panel(41, { kind: "workspace", title: "Archived workspace" }),
          ],
        },
      },
    ];

    const { markup, props } = render(true);

    expect(harness.subTriggers[0]).toMatchObject({ disabled: false });
    expect(markup).not.toContain("No closed chats");
    expect(markup).not.toContain("Other host");
    expect(markup).not.toContain("Archived workspace");
    expect(markup).not.toContain("Chat 2<");
    expect(markup.indexOf("Chat 12")).toBeLessThan(markup.indexOf("Chat 3"));
    const reopenItems = harness.menuItems.filter((item) =>
      renderToStaticMarkup(<>{item.children as React.ReactNode}</>).includes("Chat "),
    );
    expect(reopenItems).toHaveLength(10);
    (reopenItems[0]!.onClick as () => void)();
    expect(props.onReopenChatPanel).toHaveBeenCalledWith("panel-12", "Chat 12");
  });

  it("explains an empty closed-chat list", () => {
    const { markup } = render(true);
    expect(harness.subTriggers[0]).toMatchObject({ disabled: true });
    expect(markup).toContain("No closed chats");
  });

  it("keeps a visible chat provider without a registered terminal action in the chat section", () => {
    harness.items = [
      panelItem({
        entry: {
          instanceId: "fork",
          driverKind: "forkDriver",
          displayName: "Fork",
          accentColor: null,
        },
      }),
    ];
    harness.providerTerminalActionsAvailable = false;

    const { markup, props } = render(true);

    expect(markup).toContain("Fork");
    expect(markup).not.toContain("Fork Terminal");
    expect(markup.match(/<hr/g)).toHaveLength(2);
    expect(harness.menuItems).toHaveLength(3);
    (harness.menuItems[0]!.onClick as () => void)();
    expect(props.onCreateChatPanel).toHaveBeenCalledOnce();
    expect(props.onOpenProviderTerminalPanel).not.toHaveBeenCalled();
  });

  it("keeps an invalid provider terminal action visible and explains why it is disabled", () => {
    harness.items = [panelItem()];
    harness.providerTerminalActionDisabledReason =
      "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.";

    const { markup, props } = render(true);

    expect(markup).toContain("Codex Terminal");
    expect(harness.menuItems[2]).toMatchObject({ disabled: true });
    expect(harness.tooltipReasons).toEqual([
      "Provider terminal command exceeds supported limits. Shorten the provider name or configured binary path.",
    ]);
    (harness.menuItems[2]!.onClick as () => void)();
    expect(props.onOpenProviderTerminalPanel).not.toHaveBeenCalled();
  });

  it("emits the safe structured fallback diagnostic only when the terminal action launches", () => {
    harness.items = [panelItem()];
    harness.providerTerminalFallback = {
      driver: "codex",
      instanceId: "codex",
      configuredModel: "retired-model",
      resolvedModel: "gpt-5.4",
      reason: "configured-model-unavailable",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { props } = render(true);
    expect(warning).not.toHaveBeenCalled();
    (harness.menuItems[2]!.onClick as () => void)();

    expect(warning).toHaveBeenCalledWith(
      "Provider session default fallback",
      harness.providerTerminalFallback,
    );
    expect(props.onOpenProviderTerminalPanel).toHaveBeenCalledOnce();
  });

  it.each([
    {
      state: "provider-disabled",
      item: panelItem({ disabled: true, disabledReason: "Provider unavailable" }),
      canCreatePanel: true,
    },
    {
      state: "thread-disabled",
      item: panelItem(),
      canCreatePanel: false,
    },
  ])("does not warn or launch a $state provider terminal action", ({ item, canCreatePanel }) => {
    harness.items = [item];
    harness.providerTerminalFallback = {
      driver: "codex",
      instanceId: "codex",
      configuredModel: "retired-model",
      resolvedModel: "gpt-5.4",
      reason: "configured-model-unavailable",
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    warning.mockClear();

    const { props } = render(canCreatePanel);
    expect(harness.menuItems[2]).toMatchObject({ disabled: true });
    (harness.menuItems[2]!.onClick as () => void)();

    expect(warning).not.toHaveBeenCalled();
    expect(props.onOpenProviderTerminalPanel).not.toHaveBeenCalled();
  });
});
