// @vitest-environment happy-dom

import type { DesktopBridge, DesktopUpdateState } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The real update dialog and the real leave dialog: only the shell state and toasts are stubbed.
vi.mock("../../state/shell", () => ({ environmentAvailabilityCommands: { retry: {} } }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), close: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { FileEditingSession } from "../files/fileEditingSession";
import { FileEditingSessionRegistry } from "../files/fileEditingSessionRegistry";
import { UnsavedChangesCloseHost } from "../files/UnsavedChangesCloseDialog";
import { UpdateProtectionDialog } from "./UpdateProtectionDialog";

const state: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  phase: "failed",
  protection: [],
};

type Session = FileEditingSession<unknown, { readonly version?: string }, unknown>;

let container: HTMLDivElement;
let root: Root;
let registry: FileEditingSessionRegistry<Session>;
let originalGetAnimations: PropertyDescriptor | undefined;

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const byText = (text: string) => buttons().find((entry) => entry.textContent?.trim() === text);
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

beforeEach(async () => {
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.desktopBridge = {
    restartApp: vi.fn(),
    getUpdateState: vi.fn(),
  } as unknown as DesktopBridge;
  registry = new FileEditingSessionRegistry<Session>();
  registry
    .getOrCreate(
      "notes.md",
      () =>
        new FileEditingSession<unknown, { readonly version?: string }, unknown>({
          cwd: "/repo",
          relativePath: "notes.md",
          debounceMs: 500,
          base: { version: "v1", contents: "old\n" },
          persist: vi.fn(async () => AsyncResult.success({ version: "v2" })),
          onPendingChange: vi.fn(),
          onConfirmed: vi.fn(),
          onConflictChange: vi.fn(),
        }),
    )
    .changeFromRichEditor("my edit");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <UnsavedChangesCloseHost />
        <UpdateProtectionDialog
          open
          state={state}
          onOpenChange={() => undefined}
          installUpdate={vi.fn()}
          onDiagnostics={() => undefined}
        />
      </>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  await registry.dispose();
  container.remove();
  document.body.replaceChildren();
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("leave question opened from the update dialog", () => {
  it("returns focus to the install button after Cancel, and keeps it enabled meanwhile", async () => {
    const install = byText("Retry installation")!;
    install.focus();
    await act(async () => install.click());
    await settle();

    expect(byText("Discard")).toBeDefined();
    // Nearest observable fact: the opener must not be disabled while the question is open.
    expect(install.disabled).toBe(false);

    const leaveDialog = document.querySelector('[data-slot="alert-dialog-popup"]')!;
    const cancel = [...leaveDialog.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === "Cancel",
    )!;
    await act(async () => cancel.click());
    await settle();

    expect(document.activeElement).toBe(install);
  });
});
