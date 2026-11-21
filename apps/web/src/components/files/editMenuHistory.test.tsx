// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type FilesEditHistory,
  registerFilesEditRegion,
  runEditMenuAction,
  textFieldHistoryChord,
  useEditMenuActions,
  useFilesEditRegion,
} from "./editMenuHistory";

function history() {
  return { undo: vi.fn<() => void>(), redo: vi.fn<() => void>() };
}

function editable(parent: Node): HTMLDivElement {
  const element = document.createElement("div");
  element.contentEditable = "true";
  element.tabIndex = 0;
  parent.appendChild(element);
  return element;
}

describe("runEditMenuAction", () => {
  let execCommand: ReturnType<typeof vi.fn<(command: string) => boolean>>;
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    execCommand = vi.fn<(command: string) => boolean>(() => true);
    document.execCommand = execCommand as unknown as Document["execCommand"];
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
  });

  function region(target: FilesEditHistory): HTMLDivElement {
    const element = document.createElement("div");
    document.body.append(element);
    cleanups.push(registerFilesEditRegion(element, target));
    return element;
  }

  it("moves only the focused Files history, one step, with no native undo", () => {
    const first = history();
    const second = history();
    editable(region(first));
    editable(region(second)).focus();

    runEditMenuAction("edit-undo", false);

    expect(second.undo).toHaveBeenCalledTimes(1);
    expect(first.undo).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("redoes the focused Files history", () => {
    const files = history();
    editable(region(files)).focus();

    runEditMenuAction("edit-redo", false);

    expect(files.redo).toHaveBeenCalledTimes(1);
    expect(files.undo).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("reaches the source editor's content inside a shadow root", () => {
    const files = history();
    const host = document.createElement("div");
    region(files).append(host);
    const content = editable(host.attachShadow({ mode: "open" }));
    content.focus();

    runEditMenuAction("edit-undo", false);

    expect(files.undo).toHaveBeenCalledTimes(1);
  });

  it("reaches a focusable node nested in the rendered editor, such as a table cell", () => {
    const files = history();
    const cell = document.createElement("td");
    cell.tabIndex = 0;
    editable(region(files)).append(cell);
    cell.focus();

    runEditMenuAction("edit-undo", false);

    expect(files.undo).toHaveBeenCalledTimes(1);
  });

  it("leaves a text field inside Files, like the comment textarea, to its native undo", () => {
    const files = history();
    const comment = document.createElement("textarea");
    region(files).append(comment);
    comment.focus();

    runEditMenuAction("edit-undo", false);

    expect(files.undo).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("undo");
  });

  it("leaves editable text outside Files, like the composer, to its native undo and redo", () => {
    region(history());
    editable(document.body).focus();

    runEditMenuAction("edit-undo", false);
    runEditMenuAction("edit-redo", false);

    expect(execCommand.mock.calls).toEqual([["undo"], ["redo"]]);
  });

  it("keeps the native path during a composition in Files", () => {
    const files = history();
    editable(region(files)).focus();

    runEditMenuAction("edit-undo", true);

    expect(files.undo).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("undo");
  });

  it("forgets a region once it is unregistered", () => {
    const files = history();
    const element = document.createElement("div");
    document.body.append(element);
    const unregister = registerFilesEditRegion(element, files);
    editable(element).focus();
    unregister();

    runEditMenuAction("edit-undo", false);

    expect(files.undo).not.toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("undo");
  });
});

describe("useEditMenuActions and useFilesEditRegion", () => {
  afterEach(() => {
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    document.body.replaceChildren();
  });

  it("runs the menu actions while mounted, ignores other actions, and stops after unmount", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const execCommand = vi.fn<(command: string) => boolean>(() => true);
    document.execCommand = execCommand as unknown as Document["execCommand"];
    let listener: ((action: string) => void) | null = null;
    const unsubscribe = vi.fn(() => {
      listener = null;
    });
    Object.assign(window, {
      desktopBridge: {
        onMenuAction: (next: (action: string) => void) => {
          listener = next;
          return unsubscribe;
        },
      },
    });
    const files = history();
    function Probe() {
      useEditMenuActions();
      const region = useRef<HTMLDivElement>(null);
      useFilesEditRegion(region, files);
      return (
        <div ref={region}>
          <div contentEditable suppressContentEditableWarning tabIndex={0} data-testid="text" />
        </div>
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    container.querySelector<HTMLElement>('[data-testid="text"]')!.focus();
    const send = (action: string) => (listener as ((action: string) => void) | null)?.(action);

    send("edit-undo");
    send("open-settings");
    expect(files.undo).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    send("edit-undo");
    expect(files.undo).toHaveBeenCalledTimes(1);
  });

  it("forgets a composition whose editor went away before it ended", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const execCommand = vi.fn<(command: string) => boolean>(() => true);
    document.execCommand = execCommand as unknown as Document["execCommand"];
    let listener: ((action: string) => void) | null = null;
    Object.assign(window, {
      desktopBridge: {
        onMenuAction: (next: (action: string) => void) => {
          listener = next;
          return () => {};
        },
      },
    });
    function Listener() {
      useEditMenuActions();
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Listener />));
    const files = history();
    const regionElement = document.createElement("div");
    document.body.append(regionElement);
    const unregister = registerFilesEditRegion(regionElement, files);
    const first = editable(regionElement);
    first.focus();
    first.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
    );
    first.remove();
    editable(regionElement).focus();

    (listener as ((action: string) => void) | null)?.("edit-undo");

    expect(files.undo).toHaveBeenCalledTimes(1);
    expect(execCommand).not.toHaveBeenCalled();
    unregister();
    await act(async () => root.unmount());
  });

  // WebKit may start a composition on the text node or child element holding the caret, or on the
  // editing host while a focusable descendant such as a table cell has focus.
  for (const [name, arrange] of [
    [
      "a text node inside the editor",
      (host: HTMLElement) => {
        const paragraph = document.createElement("p");
        paragraph.append("marked");
        host.append(paragraph);
        host.focus();
        return paragraph.firstChild!;
      },
    ],
    [
      "a child element of the editor",
      (host: HTMLElement) => {
        const paragraph = document.createElement("p");
        host.append(paragraph);
        host.focus();
        return paragraph;
      },
    ],
    [
      "the editor while a table cell inside it has focus",
      (host: HTMLElement) => {
        const cell = document.createElement("td");
        cell.tabIndex = 0;
        host.append(cell);
        cell.focus();
        return host;
      },
    ],
  ] as const) {
    it(`keeps the native path during a composition started on ${name}`, async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const execCommand = vi.fn<(command: string) => boolean>(() => true);
      document.execCommand = execCommand as unknown as Document["execCommand"];
      let listener: ((action: string) => void) | null = null;
      Object.assign(window, {
        desktopBridge: {
          onMenuAction: (next: (action: string) => void) => {
            listener = next;
            return () => {};
          },
        },
      });
      function Listener() {
        useEditMenuActions();
        return null;
      }
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<Listener />));
      const files = history();
      const regionElement = document.createElement("div");
      document.body.append(regionElement);
      const unregister = registerFilesEditRegion(regionElement, files);
      const target = arrange(editable(regionElement));
      target.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
      );

      (listener as ((action: string) => void) | null)?.("edit-undo");

      expect(files.undo).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("undo");
      unregister();
      await act(async () => root.unmount());
    });
  }
});

describe("Linux text-field undo chords (#408)", () => {
  function keydown(target: EventTarget, init: KeyboardEventInit & { key: string }): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  it("maps Ctrl+Z, Shift+Ctrl+Z and Ctrl+Y in an input or a textarea", () => {
    const area = document.createElement("textarea");
    const input = document.createElement("input");
    document.body.append(area, input);
    const seen: (string | null)[] = [];
    const record = (event: Event) => seen.push(textFieldHistoryChord(event as KeyboardEvent));
    document.addEventListener("keydown", record);

    keydown(area, { key: "z", ctrlKey: true });
    keydown(area, { key: "Z", ctrlKey: true, shiftKey: true });
    keydown(input, { key: "y", ctrlKey: true });

    document.removeEventListener("keydown", record);
    expect(seen).toEqual(["undo", "redo", "redo"]);
  });

  it("leaves editable text, cancelled chords and other modifiers alone", () => {
    const area = document.createElement("textarea");
    const text = document.createElement("div");
    text.contentEditable = "true";
    document.body.append(area, text);
    const seen: (string | null)[] = [];
    const record = (event: Event) => seen.push(textFieldHistoryChord(event as KeyboardEvent));
    area.addEventListener("keydown", (event) => {
      if (event.key === "y") event.preventDefault();
    });
    document.addEventListener("keydown", record);

    keydown(text, { key: "z", ctrlKey: true });
    keydown(area, { key: "y", ctrlKey: true });
    keydown(area, { key: "z", metaKey: true });
    keydown(area, { key: "z", ctrlKey: true, altKey: true });
    keydown(area, { key: "z" });

    document.removeEventListener("keydown", record);
    expect(seen).toEqual([null, null, null, null, null]);
  });

  it("leaves composing keystrokes and controls that hold no editable text alone", () => {
    const area = document.createElement("textarea");
    const url = document.createElement("input");
    url.type = "url";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const button = document.createElement("input");
    button.type = "button";
    const readOnly = document.createElement("input");
    readOnly.readOnly = true;
    const disabled = document.createElement("textarea");
    disabled.disabled = true;
    document.body.append(area, url, checkbox, button, readOnly, disabled);
    const seen: (string | null)[] = [];
    const record = (event: Event) => seen.push(textFieldHistoryChord(event as KeyboardEvent));
    document.addEventListener("keydown", record);

    keydown(area, { key: "z", ctrlKey: true, isComposing: true });
    keydown(area, { key: "z", ctrlKey: true, keyCode: 229 });
    keydown(url, { key: "z", ctrlKey: true });
    keydown(checkbox, { key: "z", ctrlKey: true });
    keydown(button, { key: "z", ctrlKey: true });
    keydown(readOnly, { key: "z", ctrlKey: true });
    keydown(disabled, { key: "z", ctrlKey: true });
    // The terminal's own input textarea: xterm leaves Shift+Ctrl+Z uncancelled, for the shell.
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const terminalInput = document.createElement("textarea");
    terminalInput.className = "xterm-helper-textarea";
    terminal.append(terminalInput);
    document.body.append(terminal);
    keydown(terminalInput, { key: "Z", ctrlKey: true, shiftKey: true });

    document.removeEventListener("keydown", record);
    expect(seen).toEqual([null, null, "undo", null, null, null, null, null]);
  });

  it("runs the native undo for an uncancelled chord on the Linux desktop only", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const execCommand = vi.fn<(command: string) => boolean>(() => true);
    document.execCommand = execCommand as unknown as Document["execCommand"];
    Object.assign(window, { desktopBridge: { onMenuAction: () => () => {} } });
    const platform = vi.spyOn(navigator, "platform", "get");
    function Probe() {
      useEditMenuActions();
      return <textarea data-testid="field" />;
    }
    for (const value of ["Linux x86_64", "Win32"]) {
      platform.mockReturnValue(value);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<Probe />));
      const field = container.querySelector("textarea")!;
      field.focus();
      const event = keydown(field, { key: "z", ctrlKey: true });
      // As in a browser, the event's path is empty once its dispatch has ended.
      event.composedPath = () => [];
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      await act(async () => root.unmount());
    }
    platform.mockRestore();

    expect(execCommand.mock.calls).toEqual([["undo"]]);
  });

  it("lets an app shortcut bound to the chord take it first", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const execCommand = vi.fn<(command: string) => boolean>(() => true);
    document.execCommand = execCommand as unknown as Document["execCommand"];
    Object.assign(window, { desktopBridge: { onMenuAction: () => () => {} } });
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    function Probe() {
      useEditMenuActions();
      return <textarea data-testid="field" />;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    // Like the command palette: a window listener that resolves a configured `ctrl+z` binding.
    const shortcut = (event: KeyboardEvent) => {
      if (!event.defaultPrevented) event.preventDefault();
    };
    window.addEventListener("keydown", shortcut);
    const field = container.querySelector("textarea")!;
    field.focus();
    keydown(field, { key: "z", ctrlKey: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    window.removeEventListener("keydown", shortcut);
    await act(async () => root.unmount());
    platform.mockRestore();

    expect(execCommand).not.toHaveBeenCalled();
  });
});
