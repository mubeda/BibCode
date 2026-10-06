// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Compile only the exact repository widget into an inert mounted test.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { transformWithOxc } from "vite-plus";
import {
  readSettingsFollowup,
  validateSettingsFollowupWitness,
  type SettingsFollowupObservation,
} from "./release-visual-settings-followups.ts";

const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
const React = require("react"),
  { createRoot } = require("react-dom/client");
let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const observation: SettingsFollowupObservation = {
  scene: "receiving-settings-row",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  environmentId: "owned-remote",
  environmentLabel: "Owned remote",
  projectTitle: "Owned project",
  threadId: "owned-thread",
  projectId: "owned-project",
  workspaceKind: "primary",
  originalLabel: "Owned remote",
  reportedLabel: "Owned server",
  spanCount: 0,
  failureCount: 0,
  usageLabels: [],
  formerUsageLabels: [],
  processLabels: [],
  unmeasuredSpanName: "agent_activity_enabled",
  unmeasuredCount: 0,
  failureCause: "",
};

/** Keep the product file private: no copied widget body, generated repo module, or product export. */
async function actualRow() {
  const source = NodeFS.readFileSync(
    NodePath.resolve("apps/web/src/components/settings/remote-servers/ConnectTab.tsx"),
    "utf8",
  );
  const start = source.indexOf("function RemoteServerRow({"),
    end = source.indexOf("function RemoteServerRowFromSession(");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(source.indexOf("function RemoteServerRow({", start + 1)).toBe(-1);
  const declaration = source.slice(start, end);
  expect(declaration.length).toBeLessThan(20000);
  const paths = [
    "../../../web/src/components/ui/button.tsx",
    "../../../web/src/components/ui/badge.tsx",
    "../../../web/src/components/ui/menu.tsx",
    "../../../web/src/components/ui/tooltip.tsx",
    "../../../web/src/components/ui/collapsible.tsx",
    "../../../web/src/components/settings/remote-servers/shared.tsx",
    "../../../web/src/components/settings/remote-servers/connectPresentation.ts",
    "../../../web/src/components/settings/remoteUpdatePresentation.ts",
    "../../../web/src/components/settings/ServerUpdateBadge.tsx",
    "../../../web/src/hooks/useCopyToClipboard.ts",
    "../../../web/src/versionSkew.ts",
    "../../../web/src/connection/desktopLocal.ts",
    "../../../web/src/lib/utils.ts",
  ];
  const modules = await Promise.all(paths.map((path) => import(path)));
  const ports = Object.assign(
    {},
    React,
    {
      React,
      Option: require("effect/Option"),
      ...require("lucide-react"),
      ...(await import("../../../../packages/client-runtime/src/connection/presentation.ts")),
      ...(await import("../../../../packages/client-runtime/src/state/remoteUpdateCoordinator.ts")),
    },
    ...modules,
  );
  const compiled = await transformWithOxc(declaration, "ConnectTab.tsx", {
    jsx: { runtime: "classic" },
  });
  return new Function(...Object.keys(ports), compiled.code + "\nreturn RemoteServerRow;")(
    ...Object.values(ports),
  );
}

async function mountReceiving() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", {
    origin: observation.origin,
    pathname: "/settings/remote-servers",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  const { presentConnectionState } =
    await import("../../../../packages/client-runtime/src/connection/presentation.ts");
  const connection = presentConnectionState({
    phase: "connecting",
    desired: true,
    network: "online",
    retryAt: null,
    attempt: 1,
    generation: 1,
    stage: "configuring",
    lastFailure: null,
    notice: "Receiving settings from Owned remote over a slow connection…",
  });
  const RemoteServerRow = await actualRow();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  unmount = async () => {
    await React.act(async () => root.unmount());
    node.remove();
  };
  await React.act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          {
            "data-testid": "environment-rail-entry-owned-remote",
            "aria-label": "Owned remote",
            "aria-checked": "true",
          },
          React.createElement("i", { "data-status": "disconnected" }),
        ),
        React.createElement(RemoteServerRow, {
          environment: {
            environmentId: "owned-remote",
            label: "Owned remote",
            entry: {
              target: { _tag: "BearerConnectionTarget", connectionId: "owned-remote" },
              profile: { _tag: "None" },
            },
            connection,
            serverConfig: null,
            relayManaged: false,
          },
          compat: null,
          remoteUpdateControl: false,
          updateStatus: { snapshot: null, error: null, pending: false },
          checkInFlight: false,
          run: null,
          removingEnvironmentId: null,
          onConnect: () => {},
          onDisconnect: () => {},
          onRequestRemove: () => {},
          onRequestRename: () => {},
          onCheckForUpdate: () => {},
          onRequestUpdate: () => {},
          onDismissUpdate: () => {},
          onRetryUpdate: () => {},
        }),
      ),
    ),
  );
  const name = document.querySelector("h3")!,
    row = name.parentElement!.parentElement!.parentElement!;
  const rail = document.querySelector('[data-testid="environment-rail-entry-owned-remote"]')!;
  const reason = row.querySelector('[role="status"]')!;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this === rail || rail.contains(this)
        ? new DOMRect(0, 0, 30, 30)
        : this === reason || reason.contains(this)
          ? new DOMRect(300, 80, 200, 50)
          : new DOMRect(100, 50, 1000, 200);
    },
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation((x) =>
    x < 50 ? rail : x >= 300 && x <= 500 ? reason : name,
  );
  return { row, rail, name };
}

it("admits the actual configuring server row with the real selected remote rail and disabled Connect", async () => {
  const { row } = await mountReceiving();
  expect(row.querySelector('[role="status"]')?.textContent).toContain(
    "Receiving settings from Owned remote",
  );
  expect(
    Array.from(row.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Connecting…",
    )?.disabled,
  ).toBe(true);
  expect(() =>
    validateSettingsFollowupWitness(observation.scene, readSettingsFollowup(observation)),
  ).not.toThrow();
});

it.each([
  "hidden",
  "transparent",
  "clipped",
  "covered",
  "duplicate",
  "credential",
  "modal",
  "wrong-label",
])("refuses a %s receiving row observation", async (failure) => {
  const { row, rail } = await mountReceiving();
  if (failure === "hidden") row.hidden = true;
  if (failure === "transparent") row.style.opacity = "0";
  if (failure === "clipped") {
    row.parentElement!.style.overflow = "hidden";
    vi.spyOn(row.parentElement!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 50, 10, 10),
    );
  }
  if (failure === "covered") vi.spyOn(document, "elementFromPoint").mockReturnValue(document.body);
  if (failure === "duplicate") document.body.append(row.cloneNode(true));
  if (failure === "credential") {
    const node = document.createElement("input");
    node.type = "password";
    document.body.append(node);
  }
  if (failure === "modal") {
    const node = document.createElement("div");
    node.setAttribute("role", "dialog");
    document.body.append(node);
  }
  if (failure === "wrong-label") rail.setAttribute("aria-label", "Foreign remote");
  expect(() =>
    validateSettingsFollowupWitness(observation.scene, readSettingsFollowup(observation)),
  ).toThrow();
});

it("mounts the actual receiving banner, cached workspace card, availability notice and disabled Lexical editor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", {
    origin: observation.origin,
    pathname: "/owned-remote/owned-thread",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  const paths = [
    "../../../web/src/components/chat/ComposerBannerStack.tsx",
    "../../../web/src/components/ChatView.logic.ts",
    "../../../web/src/components/sidebar/WorkspaceCard.tsx",
    "../../../web/src/components/sidebar/SidebarProjectAvailability.tsx",
    "../../../web/src/components/Sidebar.logic.ts",
    "../../../web/src/components/ComposerPromptEditor.tsx",
  ];
  const [banner, logic, card, availability, sidebar, composer] = await Promise.all(
    paths.map((path) => import(path)),
  );
  const { presentConnectionState } =
    await import("../../../../packages/client-runtime/src/connection/presentation.ts");
  const connection = presentConnectionState({
    phase: "connecting",
    desired: true,
    network: "online",
    retryAt: null,
    attempt: 1,
    generation: 1,
    stage: "configuring",
    lastFailure: null,
    notice: "Receiving settings from Owned remote over a slow connection…",
  });
  const view = sidebar.resolveSidebarProjectAvailability({
    projectCount: 1,
    catalogReady: true,
    environments: [
      { environmentId: "owned-remote", status: "degraded", hasSnapshot: true, error: null },
    ],
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  unmount = async () => {
    await React.act(async () => root.unmount());
    node.remove();
  };
  await React.act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          {
            "data-testid": "environment-rail-entry-owned-remote",
            "aria-label": "Owned remote",
            "aria-checked": "true",
          },
          React.createElement("i", { "data-status": "disconnected" }),
        ),
        React.createElement(
          "ul",
          { "data-testid": "sidebar-project-list" },
          React.createElement("li", null, "Owned project"),
          React.createElement(
            card.WorkspaceCardShell,
            {
              idBase: "owned-card",
              isActive: true,
              testId: "primary-card-owned-project",
              buttonTestId: "primary-card-button-owned-project",
              hasFlags: false,
              hasBranchLine: true,
              hasSessionLine: false,
              status: { kind: "idle", label: "Idle" },
              onClick: () => {},
              onContextMenu: () => {},
              onButtonKeyDown: () => {},
            },
            React.createElement(card.WorkspaceCardTitleLine, {
              id: "owned-card-title",
              flagsId: "owned-card-flags",
              title: "Owned thread",
              unread: false,
              pinned: false,
            }),
            React.createElement(card.WorkspaceCardBranchLine, {
              id: "owned-card-branch",
              branch: "main",
              branchTooltip: "Owned project",
            }),
          ),
        ),
        React.createElement(availability.SidebarProjectAvailability, {
          view,
          environment: { label: "Owned remote", connection },
          showRetry: false,
          showConnectionSettings: false,
          onRetry: () => {},
          onOpenSettings: () => {},
          onViewDiagnostics: () => {},
          onAdoptStorage: () => {},
        }),
        React.createElement(
          "main",
          { "data-center-surface-host": "chat:host", "data-visible": "true" },
          React.createElement(banner.ComposerBannerStack, {
            items: [
              {
                id: "environment-unavailable:owned-remote",
                variant: "warning",
                icon: null,
                ...logic.describeUnavailableEnvironment({ label: "Owned remote", connection }),
              },
            ],
          }),
          React.createElement(
            "form",
            { "data-chat-composer-form": "true" },
            React.createElement(composer.ComposerPromptEditor, {
              value: "Owned visual review draft",
              cursor: 0,
              terminalContexts: [],
              skills: [],
              disabled: true,
              placeholder: "Owned remote is not connected",
              onRemoveTerminalContext: () => {},
              onChange: () => {},
            }),
          ),
        ),
      ),
    ),
  );
  expect(document.body.textContent).toContain("Cached projects remain visible.");
  const rail = document.querySelector('[data-testid="environment-rail-entry-owned-remote"]')!,
    button = document.querySelector('[data-testid="primary-card-button-owned-project"]')!,
    surface = document.querySelector("main")!,
    alert = surface.querySelector('[role="alert"]')!,
    editor = surface.querySelector('[data-testid="composer-editor"]')!;
  expect(editor.getAttribute("contenteditable")).toBe("false");
  expect(editor.getAttribute("role")).toBe("textbox");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this === rail || rail.contains(this)
        ? new DOMRect(0, 0, 30, 30)
        : this === button
          ? new DOMRect(40, 50, 200, 50)
          : this === alert || alert.contains(this)
            ? new DOMRect(400, 50, 500, 100)
            : this === editor || editor.contains(this)
              ? new DOMRect(400, 250, 500, 100)
              : new DOMRect(300, 40, 800, 800);
    },
  );
  vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) =>
    x < 35 ? rail : x < 250 ? button : y < 200 ? alert : y < 400 ? editor : surface,
  );
  const input = { ...observation, scene: "remote-receiving-settings" as const };
  expect(() =>
    validateSettingsFollowupWitness(input.scene, readSettingsFollowup(input)),
  ).not.toThrow();
  editor.setAttribute("contenteditable", "true");
  expect(() => validateSettingsFollowupWitness(input.scene, readSettingsFollowup(input))).toThrow();
  editor.setAttribute("contenteditable", "false");
  button.setAttribute("data-testid", "thread-card-button-owned-thread");
  expect(() => validateSettingsFollowupWitness(input.scene, readSettingsFollowup(input))).toThrow();
});
