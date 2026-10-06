// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Execute the actual serialized DOM reader against inert public markup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { afterEach, expect, it, vi } from "vite-plus/test";
const source = NodeFS.readFileSync(
  NodePath.resolve("apps/desktop/e2e/support/release-visual-provider-chat-producer.ts"),
  "utf8",
);
const start = source.indexOf("export function readProviderChatPublicContext("),
  end = source.indexOf("export interface ProviderChatProducerInput", start);
const read = () =>
  NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, "") +
      "\nreadProviderChatPublicContext",
    {
      document,
      location: { origin: "http://127.0.0.1:4885", pathname: "/local/host", search: "", hash: "" },
      getComputedStyle,
    },
  ) as (input: object) => boolean;
const input = {
  origin: "http://127.0.0.1:4885",
  hostThreadId: "host",
  targetThreadId: "panel",
  branch: "codex/delivery-retry-light",
  provider: "codex",
};
function markup() {
  document.body.innerHTML =
    '<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="thread-card-button-host" aria-current="page" aria-describedby="host-branch"></button><div id="host-branch"><span data-slot="tooltip-trigger">codex/delivery-retry-light</span></div><div data-center-surface-host="chat:host" data-visible="false"><button data-chat-provider-model-picker="true" aria-label="Claude · Opus 5"></button></div><div data-center-surface-host="chat:panel" data-visible="true"><button data-chat-provider-model-picker="true" aria-label="Codex · GPT-5.4"></button></div>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 200, 100),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
it("admits the exact visible Codex panel while the public selected route/card remains its host", () => {
  markup();
  expect(read()(input)).toBe(true);
});
it.each([
  "host-surface",
  "duplicate-surface",
  "branch",
  "provider",
  "transparent",
  "disconnected",
  "selected-card",
])("refuses a mismatched public host/panel context: %s", (mode) => {
  markup();
  const panel = document.querySelector('[data-center-surface-host="chat:panel"]')!;
  if (mode === "host-surface") panel.setAttribute("data-center-surface-host", "chat:host");
  if (mode === "duplicate-surface")
    document
      .querySelector('[data-center-surface-host="chat:host"]')!
      .setAttribute("data-visible", "true");
  if (mode === "branch")
    document.querySelector('[data-slot="tooltip-trigger"]')!.textContent = "main";
  if (mode === "provider")
    panel.querySelector("button")!.setAttribute("aria-label", "Claude · Opus 5");
  if (mode === "transparent") panel.setAttribute("style", "opacity:0");
  if (mode === "disconnected") document.querySelector('[data-status="connected"]')!.remove();
  if (mode === "selected-card")
    document.querySelector('[aria-current="page"]')!.removeAttribute("aria-current");
  expect(read()(input)).toBe(false);
});
