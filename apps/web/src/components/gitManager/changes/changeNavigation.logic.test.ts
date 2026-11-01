import { describe, expect, it } from "vite-plus/test";

import { resolveChangeStep } from "./changeNavigation.logic";

const at = (fileIndex: number, changeIndex: number, changeCount: number, fileCount = 3) => ({
  fileIndex,
  fileCount,
  changeIndex,
  changeCount,
});

describe("resolveChangeStep", () => {
  it("steps between the changes of one file", () => {
    expect(resolveChangeStep({ ...at(1, 0, 3), direction: 1 })).toEqual({
      kind: "change",
      index: 1,
    });
    expect(resolveChangeStep({ ...at(1, 2, 3), direction: -1 })).toEqual({
      kind: "change",
      index: 1,
    });
  });

  it("enters the first change when no change of the file has been visited", () => {
    expect(resolveChangeStep({ ...at(0, -1, 2), direction: 1 })).toEqual({
      kind: "change",
      index: 0,
    });
  });

  it("moves to the first change of the next file after the last change", () => {
    expect(resolveChangeStep({ ...at(0, 2, 3), direction: 1 })).toEqual({
      kind: "file",
      fileIndex: 1,
      edge: "first",
    });
  });

  it("moves to the last change of the previous file before the first change", () => {
    expect(resolveChangeStep({ ...at(2, 0, 3), direction: -1 })).toEqual({
      kind: "file",
      fileIndex: 1,
      edge: "last",
    });
    expect(resolveChangeStep({ ...at(2, -1, 3), direction: -1 })).toEqual({
      kind: "file",
      fileIndex: 1,
      edge: "last",
    });
  });

  it("passes over a file that has no changes to step through", () => {
    expect(resolveChangeStep({ ...at(0, -1, 0), direction: 1 })).toEqual({
      kind: "file",
      fileIndex: 1,
      edge: "first",
    });
  });

  it("stops at the last change of the last file and the first change of the first file", () => {
    expect(resolveChangeStep({ ...at(2, 1, 2), direction: 1 })).toEqual({ kind: "stop" });
    expect(resolveChangeStep({ ...at(0, 0, 2), direction: -1 })).toEqual({ kind: "stop" });
    expect(resolveChangeStep({ ...at(0, -1, 2), direction: -1 })).toEqual({ kind: "stop" });
  });

  it("stops in a single-file list once its changes are used up", () => {
    expect(resolveChangeStep({ ...at(0, 0, 1, 1), direction: 1 })).toEqual({ kind: "stop" });
    expect(resolveChangeStep({ ...at(0, 0, 1, 1), direction: -1 })).toEqual({ kind: "stop" });
  });
});
