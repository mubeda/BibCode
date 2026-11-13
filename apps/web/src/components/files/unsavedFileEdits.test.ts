// @vitest-environment happy-dom
import type { DesktopBridge, DesktopCloseRequest } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  askBeforeLeaving,
  attachLeaveQuestionHost,
  getLeaveQuestion,
  registerUnsavedSource,
  respondToDesktopCloseRequests,
  releaseLeaveHolds,
  windowUnsavedFiles,
  type UnsavedSource,
} from "./unsavedFileEdits";

function fakeSource(paths: string[] = []) {
  const release = vi.fn();
  const source = {
    paths,
    unsavedSessions: () => source.paths.map((path) => ({ path })),
    saveAll: vi.fn(async () => {
      source.paths = [];
      return "saved" as const;
    }),
    holdSavingForLeave: vi.fn(() => release),
    release,
  };
  return source satisfies UnsavedSource;
}

const cleanups: (() => void)[] = [];
function register<S extends UnsavedSource>(source: S): S {
  cleanups.push(registerUnsavedSource(source));
  return source;
}

beforeEach(() => {
  cleanups.push(attachLeaveQuestionHost());
});
afterEach(() => {
  getLeaveQuestion()?.answer("cancel");
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
  releaseLeaveHolds();
  delete window.desktopBridge;
});

describe("unsaved file edits across the window", () => {
  it("lists the unsaved files of every registered registry once", () => {
    register(fakeSource(["a.md", "b.md"]));
    register(fakeSource(["b.md", "c.md"]));
    expect(windowUnsavedFiles()).toEqual([{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }]);
  });

  it("a registry that leaves the set is no longer asked", () => {
    const leave = registerUnsavedSource(fakeSource(["a.md"]));
    leave();
    expect(windowUnsavedFiles()).toEqual([]);
  });

  it("on a Settings route with no registry the close proceeds at once", async () => {
    await expect(askBeforeLeaving("close")).resolves.toBe("proceed");
    expect(getLeaveQuestion()).toBeNull();
  });

  it("a clean panel registry cannot allow a close while the host registry has an unsaved edit", async () => {
    register(fakeSource(["notes.md"]));
    register(fakeSource());
    const answer = askBeforeLeaving("close");
    await vi.waitFor(() => expect(getLeaveQuestion()?.files).toEqual(["notes.md"]));
    getLeaveQuestion()!.answer("cancel");
    await expect(answer).resolves.toBe("stay");
  });

  it("a second ask while the question is open gets the same answer", async () => {
    register(fakeSource(["notes.md"]));
    const first = askBeforeLeaving("close");
    const second = askBeforeLeaving("quit");
    await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
    getLeaveQuestion()!.answer("discard");
    await expect(first).resolves.toBe("proceed");
    await expect(second).resolves.toBe("proceed");
  });

  it("the question holds every save, Cancel releases the hold and Discard keeps it until released", async () => {
    const source = register(fakeSource(["notes.md"]));
    const cancelled = askBeforeLeaving("close");
    await vi.waitFor(() => expect(source.holdSavingForLeave).toHaveBeenCalledOnce());
    getLeaveQuestion()!.answer("cancel");
    await cancelled;
    expect(source.release).toHaveBeenCalledOnce();

    const discarded = askBeforeLeaving("restart");
    await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
    getLeaveQuestion()!.answer("discard");
    await expect(discarded).resolves.toBe("proceed");
    expect(source.release).toHaveBeenCalledOnce();
    releaseLeaveHolds();
    expect(source.release).toHaveBeenCalledTimes(2);
  });

  it("blurs the focused element before it reads the registries, so a composition is committed", async () => {
    const source = register(fakeSource());
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.addEventListener("blur", () => {
      source.paths = ["composed.md"];
    });
    const answer = askBeforeLeaving("close");
    await vi.waitFor(() => expect(getLeaveQuestion()?.files).toEqual(["composed.md"]));
    getLeaveQuestion()!.answer("cancel");
    await expect(answer).resolves.toBe("stay");
    input.remove();
  });

  it("a host that unmounts with the question open answers stay", async () => {
    register(fakeSource(["notes.md"]));
    const detach = cleanups.shift()!;
    const answer = askBeforeLeaving("close");
    await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
    detach();
    await expect(answer).resolves.toBe("stay");
    expect(getLeaveQuestion()).toBeNull();
  });

  it("browser mode warns before unload only while an edit is unsaved", () => {
    const source = register(fakeSource());
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    source.paths = ["notes.md"];
    expect(unload()).toBe(true);
    window.desktopBridge = {} as DesktopBridge;
    expect(unload()).toBe(false);
  });

  describe("desktop close requests", () => {
    let endInstall: (() => void) | null = null;
    afterEach(() => {
      // Module state outlives a test: end any install a test left blocked.
      endInstall?.();
      endInstall = null;
      window.sessionStorage.clear();
    });

    function fakeBridge() {
      let listener: ((request: DesktopCloseRequest) => void) | null = null;
      const replies: [number, string][] = [];
      return {
        replies,
        send: (request: DesktopCloseRequest) => listener?.(request),
        onUpdateInstallEnded: (next: () => void) => {
          endInstall = next;
          return () => {};
        },
        onCloseRequest: (next: (request: DesktopCloseRequest) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
        replyCloseRequest: vi.fn(async (requestId: number, reply: string) => {
          replies.push([requestId, reply]);
        }),
      };
    }

    it("with nothing unsaved the close is acknowledged and allowed", async () => {
      const bridge = fakeBridge();
      cleanups.push(respondToDesktopCloseRequests(bridge));
      bridge.send({ requestId: 7, reason: "close" });
      await vi.waitFor(() =>
        expect(bridge.replies).toEqual([
          [7, "acknowledge"],
          [7, "allow"],
        ]),
      );
    });

    it("waits for the person with keepalives and answers stay on Cancel", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        register(fakeSource(["notes.md"]));
        const bridge = fakeBridge();
        cleanups.push(respondToDesktopCloseRequests(bridge));
        bridge.send({ requestId: 3, reason: "quit" });
        await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
        await vi.advanceTimersByTimeAsync(3_000);
        expect(
          bridge.replies.filter(([, reply]) => reply === "keepalive").length,
        ).toBeGreaterThanOrEqual(2);
        getLeaveQuestion()!.answer("cancel");
        await vi.waitFor(() => expect(bridge.replies.at(-1)).toEqual([3, "stay"]));
        const count = bridge.replies.length;
        await vi.advanceTimersByTimeAsync(3_000);
        expect(bridge.replies).toHaveLength(count);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a remote update install is asked about like a close", async () => {
      register(fakeSource(["notes.md"]));
      const bridge = fakeBridge();
      cleanups.push(respondToDesktopCloseRequests(bridge));
      bridge.send({ requestId: 6, reason: "update" });
      await vi.waitFor(() => expect(getLeaveQuestion()?.files).toEqual(["notes.md"]));
      getLeaveQuestion()!.answer("cancel");
      await vi.waitFor(() => expect(bridge.replies.at(-1)).toEqual([6, "stay"]));
    });

    it("a source registered during an update install is held until the install ends", async () => {
      register(fakeSource());
      const bridge = fakeBridge();
      cleanups.push(respondToDesktopCloseRequests(bridge));
      bridge.send({ requestId: 11, reason: "update" });
      await vi.waitFor(() => expect(bridge.replies.at(-1)).toEqual([11, "allow"]));

      const late = register(fakeSource());
      expect(late.holdSavingForLeave).toHaveBeenCalledOnce();
      expect(late.release).not.toHaveBeenCalled();
      endInstall!();
      endInstall = null;
      expect(late.release).toHaveBeenCalledOnce();
    });

    it("Save all answers allow once every file is saved", async () => {
      const source = register(fakeSource(["notes.md"]));
      const bridge = fakeBridge();
      cleanups.push(respondToDesktopCloseRequests(bridge));
      bridge.send({ requestId: 4, reason: "close" });
      await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
      getLeaveQuestion()!.answer("save");
      await vi.waitFor(() => expect(bridge.replies.at(-1)).toEqual([4, "allow"]));
      expect(source.saveAll).toHaveBeenCalledOnce();
    });

    it("unsubscribing with a request pending answers stay", async () => {
      register(fakeSource(["notes.md"]));
      const bridge = fakeBridge();
      const stop = respondToDesktopCloseRequests(bridge);
      bridge.send({ requestId: 5, reason: "close" });
      await vi.waitFor(() => expect(getLeaveQuestion()).not.toBeNull());
      stop();
      expect(bridge.replies.at(-1)).toEqual([5, "stay"]);
    });
  });
});
