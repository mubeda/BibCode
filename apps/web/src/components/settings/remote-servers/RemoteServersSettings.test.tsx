// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const connectTabProps = vi.hoisted(() => vi.fn());

vi.mock("./ConnectTab", () => ({
  ConnectTab: (props: unknown) => {
    connectTabProps(props);
    return <div data-testid="connect-tab" />;
  },
}));
vi.mock("./ShareThisHostTab", () => ({
  ShareThisHostTab: () => <div data-testid="share-tab" />,
}));

import { RemoteServersSettings } from "./RemoteServersSettings";

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, cleanup: () => act(async () => root.unmount()) };
}

describe("RemoteServersSettings", () => {
  it("renders both spec-named tabs with Connect selected by default", async () => {
    const { container, cleanup } = await render(<RemoteServersSettings />);
    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Connect to a host", "Share this host"]);
    expect(container.querySelector('[data-testid="connect-tab"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="share-tab"]')).toBeNull();
    await cleanup();
  });

  it("honors initialTab=share so deep links can land on the Share tab", async () => {
    const { container, cleanup } = await render(<RemoteServersSettings initialTab="share" />);
    expect(container.querySelector('[data-testid="share-tab"]')).not.toBeNull();
    await cleanup();
  });

  it("forwards an initial pairing code to the Connect tab", async () => {
    connectTabProps.mockClear();
    const onPairingCodeConsumed = vi.fn();
    const { cleanup } = await render(
      <RemoteServersSettings
        initialPairingCode="abc123"
        onPairingCodeConsumed={onPairingCodeConsumed}
      />,
    );
    expect(connectTabProps).toHaveBeenCalledWith({
      initialPairingCode: "abc123",
      onPairingCodeConsumed,
    });
    await cleanup();
  });
});
