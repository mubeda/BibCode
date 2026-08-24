// @vitest-environment happy-dom

import type { DesktopUpdateState } from "@bibcode/contracts";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/dialog", async () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogPanel: passthrough,
    DialogPopup: passthrough,
    DialogTitle: passthrough,
  };
});
vi.mock("../ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => <button {...props} aria-pressed={checked} onClick={() => onCheckedChange?.(!checked)} />,
}));

import { UpdateProtectionDialog } from "./UpdateProtectionDialog";

const baseState: DesktopUpdateState = {
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

let container: HTMLDivElement;
let root: Root;

async function render(state: DesktopUpdateState, installUpdate = vi.fn(), onDiagnostics = vi.fn()) {
  await act(async () => {
    root.render(
      <UpdateProtectionDialog
        open
        state={state}
        onOpenChange={() => undefined}
        installUpdate={installUpdate}
        onDiagnostics={onDiagnostics}
      />,
    );
  });
  return installUpdate;
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((entry) =>
    entry.textContent?.includes(text),
  );
  expect(match).toBeDefined();
  return match!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("UpdateProtectionDialog", () => {
  it("never offers exclusion when primary protection failed", async () => {
    const onDiagnostics = vi.fn();
    const installUpdate = vi.fn();
    await render(
      {
        ...baseState,
        protection: [
          {
            environmentId: "primary",
            label: "Local",
            status: "failed",
            message: "Backup failed.",
          },
        ],
      },
      installUpdate,
      onDiagnostics,
    );

    expect(container.textContent).toContain("Local");
    expect(container.textContent).toContain("Retry protection");
    expect(container.textContent).toContain("Diagnostics");
    expect(container.textContent).not.toContain("Exclude Local");
    const installWithoutBackup = button("Install without backup");
    const unprotectedInstallGroup = container.querySelector<HTMLElement>(
      '[role="group"][aria-label="Continue without a backup"]',
    );
    expect(unprotectedInstallGroup).not.toBeNull();
    expect(unprotectedInstallGroup!.contains(installWithoutBackup)).toBe(true);
    expect(installWithoutBackup.disabled).toBe(true);
    const acknowledgement = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Acknowledge update without backup"]',
    );
    expect(acknowledgement).not.toBeNull();
    await act(async () => acknowledgement!.click());
    expect(installWithoutBackup.disabled).toBe(false);
    await act(async () => installWithoutBackup.click());
    expect(installUpdate).toHaveBeenCalledWith({ skipProtection: true });
    await act(async () => button("Diagnostics").click());
    expect(onDiagnostics).toHaveBeenCalledOnce();
  });

  it("requires an exact named secondary exclusion before retrying install", async () => {
    const installUpdate = await render({
      ...baseState,
      protection: [
        { environmentId: "primary", label: "Local", status: "protected", message: null },
        {
          environmentId: "wsl:Ubuntu",
          label: "WSL (Ubuntu)",
          status: "failed",
          message: "Distribution unavailable.",
        },
      ],
    });

    const install = button("Install with exclusions");
    expect(install.disabled).toBe(true);
    const exclusion = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Exclude WSL (Ubuntu)"]',
    );
    expect(exclusion).not.toBeNull();
    await act(async () => exclusion!.click());
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(installUpdate).toHaveBeenCalledWith({ excludedEnvironmentIds: ["wsl:Ubuntu"] });
  });

  it("shows protecting progress and prevents duplicate installation", async () => {
    await render({
      ...baseState,
      phase: "protecting",
      protection: [
        {
          environmentId: "primary",
          label: "Local",
          status: "pending",
          message: null,
          stage: "waiting-for-mutations",
          elapsedMs: 12_000,
          blockedOperationCount: 1,
        },
      ],
    });

    expect(container.textContent).toContain("Protecting Local");
    expect(container.textContent).toContain("Waiting for active operations");
    expect(container.textContent).toContain("1 active operation");
    expect(container.textContent).toContain("12s elapsed");
    expect(button("Protecting projects").disabled).toBe(true);
  });
});
