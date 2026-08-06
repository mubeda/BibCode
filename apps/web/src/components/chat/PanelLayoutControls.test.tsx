import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ toggles: [] as Array<Record<string, unknown>> }));

vi.mock("../ui/toggle", () => ({
  Toggle: (props: Record<string, unknown>) => {
    harness.toggles.push(props);
    return (
      <button aria-label={props["aria-label"] as string}>
        {props.children as React.ReactNode}
      </button>
    );
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import { PanelLayoutControls, RightPanelMaximizeControl } from "./PanelLayoutControls";

beforeEach(() => {
  harness.toggles.length = 0;
});

describe("PanelLayoutControls", () => {
  it("renders only the right-panel toggle with its optional shortcut", () => {
    const onToggleRightPanel = vi.fn();
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel="Ctrl+Shift+P"
        onToggleRightPanel={onToggleRightPanel}
      />,
    );

    expect(markup).toContain("Toggle right panel (Ctrl+Shift+P)");
    expect(harness.toggles).toHaveLength(1);
    (harness.toggles[0]!.onPressedChange as () => void)();
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });

  it("explains when the right panel is unavailable", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel="Ctrl+Shift+P"
        onToggleRightPanel={vi.fn()}
      />,
    );
    expect(markup).toContain("Right panel is unavailable");
    expect(harness.toggles).toEqual([expect.objectContaining({ disabled: true })]);
  });

  it("formats the right-panel control without a shortcut", () => {
    const withoutShortcuts = renderToStaticMarkup(
      <PanelLayoutControls
        rightPanelAvailable
        rightPanelOpen
        rightPanelShortcutLabel={null}
        onToggleRightPanel={vi.fn()}
      />,
    );
    expect(withoutShortcuts).toContain("Toggle right panel");
  });
});

describe("RightPanelMaximizeControl", () => {
  it("switches between maximize and restore presentations", () => {
    expect(
      renderToStaticMarkup(<RightPanelMaximizeControl maximized={false} onToggle={vi.fn()} />),
    ).toContain("Maximize panel");
    harness.toggles.length = 0;
    expect(
      renderToStaticMarkup(<RightPanelMaximizeControl maximized onToggle={vi.fn()} />),
    ).toContain("Restore panel size");
  });
});
