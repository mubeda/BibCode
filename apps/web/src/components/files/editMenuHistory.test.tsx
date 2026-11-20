// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type FilesEditHistory,
  registerFilesEditRegion,
  runEditMenuAction,
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
