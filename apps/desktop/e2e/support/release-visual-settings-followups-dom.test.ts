// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual public widgets with decoded inert inputs; no native process, browser or pixel execution.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "../../../../packages/contracts/src/baseSchemas.ts";
import { readSettingsFollowupCallerState } from "./release-visual-settings-followups-producer.ts";
import {
  readSettingsFollowup,
  validateSettingsFollowupWitness,
  settingsFollowupCommonFacts,
  settingsFollowupFacts,
  type SettingsFollowupObservation,
} from "./release-visual-settings-followups.ts";
import {
  settingsSourceFixture,
  settingsUsageFixture,
} from "./release-visual-settings-followups-test-fixtures.ts";
const state = vi.hoisted(() => ({ environment: null as unknown }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => async () => {} }));
vi.mock("../../../web/src/connection/catalog.ts", () => ({
  environmentCatalog: { disconnect: "inert-disconnect" },
}));
vi.mock("../../../web/src/state/entities.ts", () => ({
  useActiveEnvironmentId: () => "remote:remote-store",
}));
vi.mock("../../../web/src/state/environments.ts", () => ({
  useEnvironment: () => state.environment,
}));
vi.mock("../../../web/src/state/use-atom-command.ts", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json")),
  React = require("react"),
  { createRoot } = require("react-dom/client");
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  state.environment = null;
});

it.each(["owned-thread", "owned:thread"])(
  "executes the serialized caller reader against the installed router's encoded remote route for %s",
  (threadId) => {
    const router = require("@tanstack/react-router");
    const input = {
      origin: "http://127.0.0.1:4885",
      environmentId: "remote:owned-store",
      environmentLabel: "Owned remote",
      threadId,
    };
    const pathname = router.interpolatePath({
      path: "/$environmentId/$threadId",
      params: { environmentId: input.environmentId, threadId },
    }).interpolatedPath;
    expect(pathname).toBe("/remote%3Aowned-store/" + encodeURIComponent(threadId));
    const rail = document.createElement("button");
    rail.setAttribute("data-testid", "environment-rail-entry-" + input.environmentId);
    rail.setAttribute("aria-checked", "true");
    rail.setAttribute("aria-label", input.environmentLabel);
    document.body.append(rail);
    vi.stubGlobal("location", { origin: input.origin, pathname, search: "", hash: "" });
    const serialized = new Function(
      "argument",
      "return (" + readSettingsFollowupCallerState.toString() + ")(JSON.parse(argument));",
    );
    const execute = () => serialized(JSON.stringify(input));
    expect(execute()).toEqual({
      route: "workspace",
      selectedMatched: true,
      labelMatched: true,
      credentialAbsent: true,
      bootShellAbsent: true,
    });
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/" + input.environmentId + "/" + threadId,
      search: "",
      hash: "",
    });
    expect(execute().route).toBe("other");
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/remote%3Aforeign/" + encodeURIComponent(threadId),
      search: "",
      hash: "",
    });
    expect(execute().route).toBe("other");
  },
);

it.each([
  "usage-detail-available",
  "usage-detail",
  "remote-rename",
  "remote-rename-applied",
] as const)(
  "binds the actual %s widget to the strict public reader in both themes",
  async (scene) => {
    const paths = [
      "../../../web/src/components/status-bar/ProviderUsageControl.tsx",
      "../../../web/src/components/status-bar/providerUsagePresentation.ts",
      "../../../web/src/components/settings/remote-servers/RenameServerDialog.tsx",
      "../../../web/src/components/sidebar/EnvironmentContextCard.tsx",
    ];
    const [usage, presentation, rename, context] = await Promise.all(
      paths.map((path) => import(path)),
    );
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    const available = scene === "usage-detail-available",
      native = settingsSourceFixture("remote");
    state.environment = {
      environmentId: native.target.environmentId,
      label: "Owned renamed remote",
      entry: {
        target: { _tag: "BearerConnectionTarget", connectionId: "owned-remote" },
        profile: { _tag: "None" },
      },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: native.config,
    };
    const input: SettingsFollowupObservation = {
      scene,
      theme: "light",
      origin: "http://127.0.0.1:4885",
      environmentId: available ? "local" : native.target.environmentId,
      environmentLabel: scene === "remote-rename-applied" ? "Owned renamed remote" : "Owned remote",
      projectTitle: "Owned project",
      threadId: "owned-thread",
      projectId: "owned-project",
      workspaceKind: "primary",
      originalLabel: "Owned remote",
      reportedLabel: "Owned reported remote",
      spanCount: 0,
      failureCount: 0,
      usageLabels: available ? ["93% remaining", "59% remaining"] : [],
      formerUsageLabels: ["93% remaining", "59% remaining"],
      processLabels: [],
      unmeasuredSpanName: "agent_activity_disabled",
      unmeasuredCount: 0,
      failureCause: "",
    };
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname:
        scene === "remote-rename"
          ? "/settings/remote-servers"
          : "/" + encodeURIComponent(input.environmentId) + "/owned-thread",
      search: "",
      hash: "",
    });
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    unmount = async () => {
      await React.act(async () => root.unmount());
      node.remove();
    };
    const snapshot = settingsUsageFixture(available ? "available" : "unavailable").providers[0]!;
    await React.act(async () =>
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement(
            "button",
            {
              "data-testid": available
                ? "environment-rail-local"
                : "environment-rail-entry-" + native.target.environmentId,
              "aria-label": available ? "Local — this machine" : input.environmentLabel,
              "aria-checked": "true",
            },
            React.createElement("i", { "data-status": "connected" }),
          ),
          scene === "remote-rename"
            ? React.createElement(rename.RenameServerDialog, {
                request: {
                  environmentId: EnvironmentId.make(native.target.environmentId),
                  label: input.originalLabel,
                  serverLabel: input.reportedLabel,
                },
                onClose: () => {},
                onRename: async () => null,
              })
            : null,
          scene === "remote-rename-applied"
            ? React.createElement(context.EnvironmentContextCard, {})
            : null,
          React.createElement(
            "main",
            { "data-center-surface-host": "chat:host", "data-visible": "true" },
            scene.startsWith("usage")
              ? React.createElement(
                  "div",
                  { "data-testid": "app-status-bar" },
                  React.createElement(usage.ProviderUsageControl, {
                    viewModel: presentation.buildProviderUsageViewModel(snapshot, {
                      now: snapshot.updatedAt,
                    }),
                    statusBarUsageMode: "detailed",
                    iconOnly: false,
                    onOpenProviderSettings: () => {},
                  }),
                )
              : null,
          ),
        ),
      ),
    );
    if (scene.startsWith("usage"))
      await React.act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Codex usage"]')!.click(),
      );
    const layouts = new Map<Element, DOMRect>();
    const place = (selector: string, box: DOMRect) => {
      const node = document.querySelector(selector);
      if (node) layouts.set(node, box);
    };
    place('[aria-checked="true"]', new DOMRect(0, 0, 30, 30));
    place("main", new DOMRect(280, 40, 900, 800));
    place(
      '[data-slot="popover-popup"][aria-label="Codex usage details"]',
      new DOMRect(300, 100, 400, 500),
    );
    place('[data-testid="provider-usage-detail"]', new DOMRect(310, 200, 380, 250));
    Array.from(
      document.querySelectorAll('[data-testid="provider-usage-detail"] [role="progressbar"]'),
    ).forEach((meter, index) => layouts.set(meter, new DOMRect(330, 260 + index * 70, 340, 10)));
    place('[data-slot="dialog-popup"]', new DOMRect(300, 100, 400, 400));
    place('[aria-label="Server name"]', new DOMRect(320, 200, 350, 40));
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="dialog-popup"] button',
    )) {
      const name = button.textContent?.trim();
      if (name === "Save" || name === "Cancel")
        layouts.set(button, new DOMRect(name === "Save" ? 560 : 440, 400, 80, 40));
    }
    place('[data-testid="environment-context-card"]', new DOMRect(40, 100, 220, 120));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this === document.body || this === document.documentElement
          ? new DOMRect(0, 0, 1280, 960)
          : (layouts.get(this) ?? new DOMRect(280, 40, 900, 800));
      },
    );
    const hit = (x: number, y: number) =>
      Array.from(layouts.entries())
        .filter(([, box]) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
        .sort((a, b) => a[1].width * a[1].height - b[1].width * b[1].height)[0]?.[0] ??
      document.body;
    const hitTest = vi.spyOn(document, "elementFromPoint").mockImplementation(hit);
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      expect(readSettingsFollowup({ ...input, theme })).toEqual(
        Object.fromEntries(
          [...settingsFollowupCommonFacts, ...settingsFollowupFacts[scene]].map((key) => [
            key,
            true,
          ]),
        ),
      );
      expect(() =>
        validateSettingsFollowupWitness(scene, readSettingsFollowup({ ...input, theme })),
      ).not.toThrow();
    }
    const current = { ...input, theme: "dark" as const };
    if (scene === "remote-rename") {
      const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
      expect(backdrop).not.toBeNull();
      hitTest.mockImplementation((x, y) => (x < 280 ? backdrop : hit(x, y)));
      expect(() =>
        validateSettingsFollowupWitness(scene, readSettingsFollowup(current)),
      ).not.toThrow();
      hitTest.mockReturnValue(document.body);
      expect(() => validateSettingsFollowupWitness(scene, readSettingsFollowup(current))).toThrow();
      hitTest.mockImplementation((x, y) => (x < 280 ? backdrop : hit(x, y)));
    }
    const rail = document.querySelector('[aria-checked="true"]')!;
    rail.setAttribute("aria-checked", "false");
    expect(() => validateSettingsFollowupWitness(scene, readSettingsFollowup(current))).toThrow();
  },
);
