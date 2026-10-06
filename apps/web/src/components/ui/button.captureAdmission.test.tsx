// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Inspect the real qualification callback with inert rounded layout ports.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Button } from "./button";
const source = NodeFS.readFileSync(
  new NodeURL.URL("../../../../desktop/e2e/qualify-remote-updates.ts", import.meta.url),
  "utf8",
);
const css = NodeFS.readFileSync(new NodeURL.URL("../../index.css", import.meta.url), "utf8");
const radius = Number(css.match(/--radius:\s*([0-9.]+)rem;/)![1]) * 16 - 2;
const start = source.indexOf("          (input) => {", source.indexOf("async function capture("));
const end = source.indexOf("\n          {\n            selector:", start);
const argsEnd = source.indexOf("\n          },\n        ),", end);
const callback = source.slice(start, end).trim().replace(/,$/, "");
const corner = callback
  .replace("const insetX = box.width / 4;", "const insetX = Math.min(2, box.width / 4);")
  .replace("const insetY = box.height / 4;", "const insetY = Math.min(2, box.height / 4);");
const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
  toJSON: () => ({}),
});
function inRounded(b: ReturnType<typeof box>, x: number, y: number) {
  if (x < b.left || x > b.right || y < b.top || y > b.bottom) return false;
  const r = Math.min(radius, b.width / 2, b.height / 2);
  const cx = Math.max(b.left + r, Math.min(x, b.right - r));
  const cy = Math.max(b.top + r, Math.min(y, b.bottom - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
it.each(["light", "dark"])(
  "runs the actual dismissed read against actual rounded xs Buttons: %s",
  async (theme) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("location", new URL("http://localhost:4901/local/owned"));
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    document.documentElement.classList.toggle("dark", theme === "dark");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(
            "section",
            {
              className: "owned-row",
              role: "radio",
              "aria-label": "Owned host",
              "aria-checked": "true",
            },
            createElement(Button, { size: "xs", variant: "ghost" }, "Check"),
            createElement(Button, { size: "xs" }, "Update to v9.9.1…"),
            createElement(Button, { size: "xs", variant: "outline" }, "Disconnect"),
          ),
        ),
      );
      const row = container.querySelector("section")!;
      const buttons = [...row.querySelectorAll("button")];
      expect(buttons).toHaveLength(3);
      expect(radius).toBe(8);
      const boxes = buttons.map((_, i) => box([935, 995, 1120][i]!, 219, [45, 110, 90][i]!, 24));
      buttons.forEach((button, i) => {
        expect(button.classList.contains("rounded-md")).toBe(true);
        button.getBoundingClientRect = () => boxes[i]!;
        button.getClientRects = () =>
          Object.assign([boxes[i]!], { item: (index: number) => (index === 0 ? boxes[i]! : null) });
      });
      row.getBoundingClientRect = () => box(467, 182, 768, 99);
      const nativeStyle = getComputedStyle;
      vi.stubGlobal("getComputedStyle", (node: Element) => {
        const style = nativeStyle(node);
        return {
          display: style.display || "block",
          visibility: style.visibility || "visible",
          opacity: style.opacity || "1",
        };
      });
      const hit = vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
        const i = boxes.findIndex((b) => inRounded(b, x, y));
        return i >= 0 ? buttons[i]! : row;
      });
      const input = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "(" + source.slice(end, argsEnd + "\n          }".length).trim() + ")",
        ),
        {
          target: ".owned-row",
          scene: "dismissed",
          host: { label: "Owned host", port: 4888 },
          expected: "Update to v9.9.1…",
          currentTheme: theme,
          webOrigin: "http://localhost:4901",
        },
      );
      const context = {
        document,
        location,
        HTMLElement,
        HTMLButtonElement,
        innerWidth: 1280,
        innerHeight: 960,
        getComputedStyle,
      };
      const before = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes("(" + corner + ")"),
        context,
      );
      const after = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes("(" + callback + ")"),
        context,
      );
      expect(before(input).targetInView).toBe(false);
      expect(after(input).targetInView).toBe(true);
      const viewport = document.createElement("div");
      viewport.setAttribute("data-slot", "toast-viewport");
      const toast = document.createElement("div");
      toast.setAttribute("data-position", "top-right");
      toast.style.pointerEvents = "none";
      toast.getBoundingClientRect = () => box(889, 84, 359, 148);
      viewport.append(toast);
      document.body.append(viewport);
      expect(after(input).targetInView).toBe(false);
      viewport.remove();
      hit.mockImplementation((x, y) => {
        const i = boxes.findIndex((b) => inRounded(b, x, y));
        if (
          i >= 0 &&
          x < boxes[i]!.left + boxes[i]!.width / 3 &&
          y < boxes[i]!.top + boxes[i]!.height / 3
        )
          return row;
        return i >= 0 ? buttons[i]! : row;
      });
      expect(after(input).targetInView).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      document.documentElement.classList.remove("dark");
    }
  },
);
