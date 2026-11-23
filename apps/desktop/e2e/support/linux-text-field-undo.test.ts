// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - The test loads the injected preview script from disk.
// @effect-diagnostics globalTimers:off - The test waits for the script's own timer, as the page does.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../../src-tauri/src/preview/linux_text_field_undo.js"),
  "utf8",
);
const execCommand = vi.fn();

// happy-dom marks no event trusted; WebKitGTK does for real input.
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

function typeInto(element: HTMLElement): void {
  element.dispatchEvent(trusted(new InputEvent("input", { bubbles: true, composed: true })));
}

function ctrlZ(element: HTMLElement, isTrusted = true): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  element.focus();
  element.dispatchEvent(isTrusted ? trusted(event) : event);
  return event;
}

async function afterDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  document.execCommand = execCommand;
  // oxlint-disable-next-line no-new-func -- evaluates the classic script the webview injects.
  new Function(source)();
});

beforeEach(() => {
  document.body.replaceChildren();
  execCommand.mockClear();
});

describe("Linux preview text field undo", () => {
  it("undoes the user's edit in the focused textarea without cancelling the chord", async () => {
    const textarea = document.body.appendChild(document.createElement("textarea"));
    typeInto(textarea);
    const event = ctrlZ(textarea);
    expect(event.defaultPrevented).toBe(false);
    await afterDispatch();
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("undo");
  });

  it("leaves another editor's edit alone when an untouched input has focus", async () => {
    const editor = document.body.appendChild(document.createElement("div"));
    editor.contentEditable = "true";
    const input = document.body.appendChild(document.createElement("input"));
    typeInto(editor);
    ctrlZ(input);
    await afterDispatch();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("leaves a chord the page's own later window listener cancelled", async () => {
    const textarea = document.body.appendChild(document.createElement("textarea"));
    const siteUndo = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", siteUndo);
    try {
      typeInto(textarea);
      ctrlZ(textarea);
      await afterDispatch();
    } finally {
      window.removeEventListener("keydown", siteUndo);
    }
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("ignores a synthetic chord the page dispatches", async () => {
    const textarea = document.body.appendChild(document.createElement("textarea"));
    typeInto(textarea);
    ctrlZ(textarea, false);
    await afterDispatch();
    expect(execCommand).not.toHaveBeenCalled();
  });
});
