// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Replay the actual read-only QA reader against actual surface-host output.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { HOST_SURFACE_ID, type ThreadCenterPanelState } from "~/centerPanelStore";
import { ThreadId } from "@bibcode/contracts";
import { CenterPanelSurfaceHosts } from "./CenterPanelSurfaceHosts";

it.each([false, true])(
  "joins the source-derived primary host and refuses a visible sibling: %s",
  async (siblingActive) => {
    const host = { id: HOST_SURFACE_ID, kind: "chat-host" } as const;
    const sibling = {
      id: "chat:owned-thread",
      kind: "chat",
      threadId: ThreadId.make("owned-thread"),
    } as const;
    const state: ThreadCenterPanelState = {
      surfaces: [host, sibling],
      groups: [
        {
          id: "owned-group",
          surfaceIds: [host.id, sibling.id],
          activeSurfaceId: siblingActive ? sibling.id : host.id,
        },
      ],
      layout: { type: "leaf", groupId: "owned-group" },
      focusedGroupId: "owned-group",
    };
    const box = { left: 0, top: 0, width: 640, height: 480 };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("location", {
      origin: "http://127.0.0.1:4885",
      pathname: "/local/owned-thread",
      search: "",
      hash: "",
    });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    vi.spyOn(HTMLElement.prototype, "checkVisibility").mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      ...box,
      right: 640,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    try {
      await act(async () =>
        root.render(
          <>
            <div data-testid="environment-rail-local" aria-checked="true">
              <span data-status="connected" />
            </div>
            <button data-testid="primary-card-button-owned-project" aria-current="page" />
            <CenterPanelSurfaceHosts
              state={state}
              rects={new Map([["owned-group", box]])}
              readBodyRect={() => box}
              onFocusGroup={() => {}}
              renderSurface={() => (
                <form data-chat-composer-form="true">
                  <div data-testid="composer-editor" />
                  <button data-chat-provider-model-picker="true" aria-label="Claude · Opus 5" />
                </form>
              )}
            />
          </>,
        ),
      );
      const actualHost = container.querySelector('[data-center-surface-host="chat:host"]');
      expect(actualHost?.getAttribute("data-visible")).toBe(String(!siblingActive));
      const source = NodeFS.readFileSync(
        new NodeURL.URL(
          "../../../desktop/e2e/support/delivery-import-observation.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const read = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source).replace(/^export /gm, "") +
          "\nreadDeliveryImportObservation",
        { location, document, HTMLInputElement, HTMLButtonElement, innerWidth, innerHeight },
      ) as (input: object) => { modelFacts?: object | null } | null;
      const observed = read({
        origin: "http://127.0.0.1:4885",
        binding: { environmentId: "local", projectId: "owned-project", threadId: "owned-thread" },
      });
      expect(observed?.modelFacts).toEqual(
        siblingActive
          ? null
          : {
              expectedTriggerLabel: true,
              triggerDisabled: false,
              desiredOptionSelected: null,
              desiredOptionDisabled: null,
            },
      );
    } finally {
      await act(async () => root.unmount());
      document.body.replaceChildren();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);
