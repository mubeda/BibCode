// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ui/dialog", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogPanel: passthrough,
    DialogPopup: passthrough,
    DialogTitle: passthrough,
  };
});
vi.mock("./ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

import {
  monitorConnectionDatabaseOpenRequest,
  reportConnectionDatabaseUnavailable,
  resetConnectionDatabaseHealthForTest,
} from "../connection/databaseHealth";
import { ConnectionDatabaseRecoveryDialog } from "./ConnectionDatabaseRecoveryDialog";

class FakeRequest {
  error: DOMException | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

let container: HTMLDivElement;
let root: Root;

function button(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((entry) =>
    entry.textContent?.includes(text),
  );
  expect(match).toBeDefined();
  return match!;
}

function publishOpenEvent(type: "blocked" | "error", error?: DOMException): void {
  const request = new FakeRequest();
  request.error = error ?? null;
  monitorConnectionDatabaseOpenRequest(request as unknown as IDBOpenDBRequest);
  request.fire(type);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetConnectionDatabaseHealthForTest();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConnectionDatabaseHealthForTest();
});

describe("ConnectionDatabaseRecoveryDialog", () => {
  it("lists every deleted category and requires confirmation before reset", async () => {
    publishOpenEvent("error", new DOMException("newer database", "VersionError"));
    const deleteDatabase = vi.fn(async () => "blocked" as const);
    const reloadPage = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionDatabaseRecoveryDialog
          deleteDatabase={deleteDatabase}
          reloadPage={reloadPage}
        />,
      );
    });

    for (const text of [
      "Saved remote servers",
      "Connection credentials",
      "Accepted storage identities",
      "Cached environment shell state",
      "Cached thread state",
    ]) {
      expect(container.textContent).toContain(text);
    }
    expect(deleteDatabase).not.toHaveBeenCalled();
    await act(async () => button("Reset saved connection data").click());
    expect(container.textContent).toContain("cannot be undone");
    await act(async () => button("Confirm reset").click());
    expect(deleteDatabase).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Close other BiBCode tabs and windows");
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("reloads only after successful deletion", async () => {
    publishOpenEvent("error", new DOMException("newer database", "VersionError"));
    const reloadPage = vi.fn();
    await act(async () => {
      root.render(
        <ConnectionDatabaseRecoveryDialog
          deleteDatabase={async () => "deleted"}
          reloadPage={reloadPage}
        />,
      );
    });

    await act(async () => button("Reset saved connection data").click());
    await act(async () => button("Confirm reset").click());
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it("keeps blocked and generic unavailable recovery non-destructive", async () => {
    publishOpenEvent("blocked");
    const reloadPage = vi.fn();
    await act(async () => {
      root.render(<ConnectionDatabaseRecoveryDialog reloadPage={reloadPage} />);
    });
    expect(container.textContent).toContain("Connection database is blocked");
    expect(container.textContent).not.toContain("Reset saved connection data");

    reportConnectionDatabaseUnavailable("open denied");
    const copyText = vi.fn(async () => undefined);
    await act(async () => {
      root.render(<ConnectionDatabaseRecoveryDialog reloadPage={reloadPage} copyText={copyText} />);
    });
    await act(async () => button("Copy diagnostics").click());
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});
