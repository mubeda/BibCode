// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual public components with inert typed callbacks, no app runtime or pixels.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  runSettingsFollowupRename,
  runSettingsFollowupUsage,
  type SettingsFollowupRenameInput,
  type SettingsFollowupUsageInput,
} from "./release-visual-settings-followups-public.ts";
import { ServerProviderUsageSnapshot } from "../../../../packages/contracts/src/providerUsage.ts";
const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
const React = require("react") as {
  act: (run: () => void | Promise<void>) => Promise<void>;
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  useState: <T>(initial: T) => [T, (value: T) => void];
};
const { createRoot } = require("react-dom/client") as {
  createRoot: (node: HTMLElement) => { render: (value: unknown) => void; unmount: () => void };
};
const mounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of mounts.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function mountedRename(mode = "success") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const path = "../../../web/src/components/settings/remote-servers/RenameServerDialog.tsx";
  const { RenameServerDialog } = await import(path);
  const nativeId = EnvironmentId.make("owned-remote");
  let label = "Owned saved host",
    open: () => void = () => {},
    calls: string[] = [],
    captures = 0,
    unsafe = 0,
    checks = 0;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  function Harness() {
    const [request, setRequest] = React.useState<object | null>(null);
    open = () => setRequest({ environmentId: nativeId, label, serverLabel: "Owned reported host" });
    return React.createElement(RenameServerDialog, {
      request,
      onClose: () => setRequest(null),
      onRename: async (id: unknown, next: string) => {
        expect(id).toBe(nativeId);
        calls.push(next);
        if (mode === "save-failure" && next === "Owned renamed host")
          return "Couldn't save the name on this device. Try again.";
        label = next;
        return null;
      },
    });
  }
  await React.act(async () => root.render(React.createElement(Harness, null)));
  mounts.push(async () => {
    await React.act(async () => root.unmount());
    node.remove();
  });
  const select = (selector: string) => {
    if (selector.endsWith("button=Save") || selector.endsWith("button=Cancel")) {
      const label = selector.endsWith("button=Save") ? "Save" : "Cancel";
      return Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-popup"] button'),
      ).filter((value) => value.textContent?.trim() === label);
    }
    return Array.from(document.querySelectorAll<HTMLElement>(selector));
  };
  const browser = {
    $$: (selector: string) => ({ length: select(selector).length }),
    $: (selector: string) => ({
      waitForDisplayed: async () => {
        expect(select(selector)).toHaveLength(1);
      },
      waitForEnabled: async () => {
        expect(select(selector)[0]?.hasAttribute("disabled")).toBe(false);
      },
      isDisplayed: async () => select(selector).length === 1,
      getValue: async () =>
        select(selector)[0] instanceof HTMLInputElement
          ? (select(selector)[0] as HTMLInputElement).value
          : "",
      setValue: async (value: string) => {
        const input = select(selector)[0];
        if (!(input instanceof HTMLInputElement)) throw new Error("Inert input absent.");
        await React.act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      },
      click: async () => {
        const button = select(selector)[0];
        if (!button) throw new Error("Inert control absent.");
        await React.act(async () => button.click());
      },
    }),
  } as unknown as SettingsFollowupRenameInput["browser"];
  const args: SettingsFollowupRenameInput = {
    browser,
    owner: {
      until: async (predicate) => {
        for (let attempt = 0; attempt < 3; attempt++) if (await predicate()) return;
        throw new Error("Inert expected save did not arrive.");
      },
    },
    originalLabel: "Owned saved host",
    nextLabel: "Owned renamed host",
    openDialog: async () => {
      await React.act(async () => open());
    },
    readLabel: async () => label,
    verifyIdentity: async () => {
      checks++;
    },
    captureDialog: async () => {
      captures++;
      expect(document.body.textContent).toContain("The new name shows on this device only.");
      expect(document.querySelector<HTMLInputElement>('[aria-label="Server name"]')?.value).toBe(
        "Owned saved host",
      );
    },
    afterSave: async () => {
      expect(label).toBe("Owned renamed host");
      if (mode === "after-save-failure") throw original;
    },
    observeUnsafeCleanup: () => {
      unsafe++;
    },
  };
  const original = new Error("Inert original capture refusal.");
  return {
    args,
    calls,
    original,
    label: () => label,
    captures: () => captures,
    unsafe: () => unsafe,
    checks: () => checks,
  };
}
it("drives actual Rename server Save and restoration callbacks with the same environment", async () => {
  const f = await mountedRename();
  await expect(runSettingsFollowupRename(f.args)).resolves.toMatchObject({
    originalLabelRestored: true,
  });
  expect(f.calls).toEqual(["Owned renamed host", "Owned saved host"]);
  expect(f.captures()).toBe(1);
  expect(f.checks()).toBeGreaterThan(2);
  expect(f.label()).toBe("Owned saved host");
  expect(f.unsafe()).toBe(0);
});
it("preserves an original post-save failure while publicly restoring the exact original name", async () => {
  const f = await mountedRename("after-save-failure");
  await expect(runSettingsFollowupRename(f.args)).rejects.toBe(f.original);
  expect(f.label()).toBe("Owned saved host");
  expect(f.calls).toEqual(["Owned renamed host", "Owned saved host"]);
  expect(f.unsafe()).toBe(0);
});
it("refuses a real rejected Save, cancels only its dialog and retains the original name", async () => {
  const f = await mountedRename("save-failure");
  await expect(runSettingsFollowupRename(f.args)).rejects.toThrow();
  expect(f.calls).toEqual(["Owned renamed host"]);
  expect(f.label()).toBe("Owned saved host");
  expect(document.body.textContent).not.toContain("Rename server");
  expect(f.unsafe()).toBe(0);
});
it("uses the actual Codex popover with decoded target-owned snapshots and never carries A values into unavailable B", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const controlPath = "../../../web/src/components/status-bar/ProviderUsageControl.tsx",
    presentationPath = "../../../web/src/components/status-bar/providerUsagePresentation.ts";
  const { ProviderUsageControl } = await import(controlPath),
    { buildProviderUsageViewModel } = await import(presentationPath);
  const Schema = require("effect/Schema");
  const decode = (available: boolean): ServerProviderUsageSnapshot =>
    Schema.decodeUnknownSync(Schema.toCodecJson(ServerProviderUsageSnapshot))({
      provider: "codex",
      status: available ? "ok" : "unavailable",
      session: available
        ? {
            usedPercent: 41,
            windowMinutes: 300,
            resetsAt: "2026-10-06T01:00:00Z",
            resetDescription: null,
          }
        : null,
      weekly: null,
      fableWeekly: null,
      planType: null,
      rateLimitResetCredits: null,
      updatedAt: "2026-10-06T00:00:00Z",
      error: available ? null : "Codex not signed in.",
      metadata: { source: available ? "app-server" : "unavailable" },
    });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounts.push(async () => {
    await React.act(async () => root.unmount());
    node.remove();
  });
  const select = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
      (value) => value.closest("[hidden]") === null,
    );
  const browser = {
    $$: (selector: string) => ({ length: select(selector).length }),
    $: (selector: string) => ({
      waitForDisplayed: async () => {
        expect(select(selector)).toHaveLength(1);
      },
      waitForEnabled: async () => {},
      isDisplayed: async () => select(selector).length === 1,
      isFocused: async () => document.activeElement === select(selector)[0],
      click: async () => {
        await React.act(async () => select(selector)[0]!.click());
      },
    }),
    keys: async (key: string) => {
      expect(key).toBe("Escape");
      await React.act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keyup", { key: "Escape", bubbles: true }),
        );
      });
    },
  } as unknown as SettingsFollowupUsageInput["browser"];
  let settingActions = 0;
  for (const [id, available] of [
    ["owned-A", true],
    ["owned-B", false],
  ] as const) {
    const snapshot = decode(available),
      view = buildProviderUsageViewModel(snapshot, { now: snapshot.updatedAt });
    await React.act(async () =>
      root.render(
        React.createElement(
          "div",
          { "data-testid": "app-status-bar" },
          React.createElement(ProviderUsageControl, {
            key: id,
            viewModel: view,
            statusBarUsageMode: "detailed",
            iconOnly: false,
            onOpenProviderSettings: () => {
              settingActions++;
            },
          }),
        ),
      ),
    );
    let captures = 0,
      usageChecks = 0;
    await expect(
      runSettingsFollowupUsage({
        browser,
        owner: {
          until: async (predicate) => {
            for (let count = 0; count < 3; count++) if (await predicate()) return;
            throw new Error("Inert usage cleanup did not settle.");
          },
        },
        verifyIdentity: async () => {},
        verifyUsage: async () => {
          usageChecks++;
          expect(snapshot.status).toBe(available ? "ok" : "unavailable");
        },
        capture: async () => {
          captures++;
          const detail = select('[data-testid="provider-usage-detail"]')[0];
          expect(detail?.textContent).toContain(available ? "59%" : "Codex not signed in.");
          if (!available) {
            expect(detail?.querySelector('[role="progressbar"]')).toBeNull();
            expect(detail?.textContent).not.toContain("59%");
            expect(detail?.textContent).not.toContain("Showing last available usage");
          }
        },
        observeUnsafeCleanup: () => {
          throw new Error("Inert unexpected unsafe cleanup.");
        },
      }),
    ).resolves.toMatchObject({ usagePopoverClosed: true });
    expect(captures).toBe(1);
    expect(usageChecks).toBeGreaterThanOrEqual(2);
    expect(select('[data-testid="provider-usage-detail"]')).toHaveLength(0);
  }
  expect(settingActions).toBe(0);
});
