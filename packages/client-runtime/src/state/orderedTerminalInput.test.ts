import { describe, expect, it } from "@effect/vitest";
import { TerminalInputError, ThreadId, WS_METHODS, type ServerConfig } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  createOrderedTerminalInputBinding,
  createTerminalInputBindingRegistry,
  splitTerminalInputFrames,
} from "./orderedTerminalInput.ts";

const target = { threadId: ThreadId.make("thread"), terminalId: "terminal" };
function harness(capable = true) {
  const frames: Array<{ sequence: number; data: string }> = [];
  let begins = 0;
  const attachmentSequences: number[] = [];
  let cancels = 0;
  let fail = false;
  const session: RpcSession = {
    client: {
      [WS_METHODS.terminalBeginInput]: (input: { attachmentSequence: number }) =>
        Effect.sync(() => {
          attachmentSequences.push(input.attachmentSequence);
          begins++;
          return { inputId: "lease" };
        }),
      [WS_METHODS.terminalWriteInput]: (frame: { sequence: number; data: string }) =>
        Effect.sync(() => {
          frames.push(frame);
          return { inputId: fail ? "wrong" : "lease", sequence: frame.sequence };
        }),
      [WS_METHODS.terminalCancelInput]: () =>
        Effect.sync(() => {
          cancels++;
        }),
      [WS_METHODS.terminalWrite]: (frame: { data: string }) =>
        Effect.sync(() => {
          frames.push({ sequence: -1, data: frame.data });
        }),
    } as unknown as WsRpcProtocolClient,
    initialConfig: Effect.succeed({
      environment: { capabilities: { terminalOrderedInput: capable } },
    } as ServerConfig),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
  return {
    session,
    frames,
    begins: () => begins,
    attachmentSequences,
    cancels: () => cancels,
    fail: () => {
      fail = true;
    },
  };
}

describe("ordered terminal input binding", () => {
  it.effect(
    "shares one prepared lease across callers and validates monotonically sequenced replies",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const binding = createOrderedTerminalInputBinding(
          h.session,
          "env",
          target,
          yield* Effect.context(),
        );
        yield* binding.prepare;
        yield* Effect.all([binding.write("a"), binding.write("b")], { concurrency: "unbounded" });
        expect(h.begins()).toBe(1);
        expect(h.frames.map((f) => [f.sequence, f.data])).toEqual([
          [0, "a"],
          [1, "b"],
        ]);
        binding.dispose();
        yield* Effect.yieldNow;
        expect(h.cancels()).toBe(1);
      }),
  );
  it.effect("fences mismatched acknowledgement and never falls through to legacy writes", () =>
    Effect.gen(function* () {
      const h = harness();
      h.fail();
      const binding = createOrderedTerminalInputBinding(
        h.session,
        "env",
        target,
        yield* Effect.context(),
      );
      yield* binding.write("a").pipe(Effect.flip);
      yield* binding.write("b").pipe(Effect.flip);
      expect(h.frames.map((f) => f.data)).toEqual(["a"]);
    }),
  );
  it.effect("marks each frame with who produced its input, and nothing when unsaid (#348)", () =>
    Effect.gen(function* () {
      for (const ordered of [true, false]) {
        const h = harness(ordered);
        const sent: Array<Record<string, unknown>> = [];
        const client = h.session.client as unknown as Record<
          string,
          (frame: Record<string, unknown>) => Effect.Effect<unknown>
        >;
        for (const method of [WS_METHODS.terminalWriteInput, WS_METHODS.terminalWrite]) {
          const send = client[method]!;
          client[method] = (frame) => {
            sent.push(frame);
            return send(frame);
          };
        }
        // A binding a write created keeps that write's input as its target.
        const binding = createOrderedTerminalInputBinding(
          h.session,
          "env",
          { ...target, data: "first", userInputClaim: "claim" } as typeof target,
          yield* Effect.context(),
        );
        yield* binding.write("typed", "claim");
        yield* binding.write("\u001b[0n", null);
        yield* binding.write("unmarked");
        expect(sent.map(({ data, userInputClaim }) => ({ data, userInputClaim }))).toEqual([
          { data: "typed", userInputClaim: "claim" },
          { data: "\u001b[0n", userInputClaim: null },
          { data: "unmarked", userInputClaim: undefined },
        ]);
        expect(sent[2]).not.toHaveProperty("userInputClaim");
        binding.dispose();
      }
    }),
  );
  it.effect("does not begin a lease for an older server", () =>
    Effect.gen(function* () {
      const h = harness(false);
      const binding = createOrderedTerminalInputBinding(
        h.session,
        "env",
        target,
        yield* Effect.context(),
      );
      yield* binding.write("a");
      expect(h.begins()).toBe(0);
      expect(h.frames).toEqual([{ sequence: -1, data: "a" }]);
      binding.dispose();
    }),
  );
  it.effect(
    "rejects old-session input until a fresh attachment and isolates old cancellation",
    () =>
      Effect.gen(function* () {
        const a = harness();
        const b = harness();
        const registry = createTerminalInputBindingRegistry();
        const context = yield* Effect.context();
        yield* registry.write(a.session, "env", target, "old", context);
        yield* registry.write(b.session, "env", target, "uncertain", context).pipe(Effect.flip);
        registry.reset("env", target);
        yield* registry.write(b.session, "env", target, "before attach", context).pipe(Effect.flip);
        yield* registry.prepare(b.session, "env", target, context);
        yield* registry.write(b.session, "env", target, "fresh", context);
        expect(a.frames.map((f) => f.data)).toEqual(["old"]);
        expect(b.frames.map((f) => f.data)).toEqual(["fresh"]);
        expect(a.attachmentSequences).toEqual([0]);
        expect(b.attachmentSequences).toEqual([0]);
        expect(b.cancels()).toBe(0);
        registry.reset("env", target);
      }),
  );
  it.effect("prepares a fresh binding after a preparation failed on the same session", () =>
    Effect.gen(function* () {
      const h = harness();
      const client = h.session.client as unknown as Record<string, (input: never) => unknown>;
      const begin = client[WS_METHODS.terminalBeginInput]!;
      client[WS_METHODS.terminalBeginInput] = () =>
        Effect.fail(new TerminalInputError({ code: "closed", message: "Begin timed out." }));
      const registry = createTerminalInputBindingRegistry();
      const context = yield* Effect.context();
      yield* registry.prepare(h.session, "env", target, context).pipe(Effect.flip);
      client[WS_METHODS.terminalBeginInput] = begin;
      // The next attachment on this connection prepares again instead of replaying the failure.
      yield* registry.prepare(h.session, "env", target, context);
      yield* registry.write(h.session, "env", target, "a", context);
      expect(h.begins()).toBe(1);
      expect(h.frames.map((f) => f.data)).toEqual(["a"]);
      registry.reset("env", target);
    }),
  );
  it("splits programmatic Unicode input into bounded frames", () => {
    const input = "😀é".repeat(10000);
    const frames = splitTerminalInputFrames(input);
    expect(frames.join("")).toBe(input);
    expect(frames.every((frame) => new TextEncoder().encode(frame).length <= 16 * 1024)).toBe(true);
  });
  it.effect("disposes a delayed write and its dependents without an unhandled rejection", () =>
    Effect.gen(function* () {
      const h = harness();
      const started = yield* Deferred.make<void>();
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalWriteInput] = () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const binding = createOrderedTerminalInputBinding(
        h.session,
        "env",
        target,
        yield* Effect.context(),
      );
      yield* binding.prepare;
      const writing = yield* binding.write("a").pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      binding.dispose();
      const error = yield* Fiber.join(writing);
      expect(error._tag).toBe("TerminalInputError");
      yield* binding.write("b").pipe(Effect.flip);
    }),
  );
  it.effect("cancels a begin reply arriving after reset without cancelling the new lease", () =>
    Effect.gen(function* () {
      const h = harness();
      const began = yield* Deferred.make<void>();
      const firstLease = yield* Deferred.make<{ inputId: string }>();
      let begins = 0;
      const cancelled: string[] = [];
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalBeginInput] = () =>
        Effect.suspend(() => {
          begins++;
          return begins === 1
            ? Deferred.succeed(began, undefined).pipe(Effect.andThen(Deferred.await(firstLease)))
            : Effect.succeed({ inputId: "new" });
        });
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalCancelInput] = (input: {
        inputId: string;
      }) =>
        Effect.sync(() => {
          cancelled.push(input.inputId);
        });
      const registry = createTerminalInputBindingRegistry();
      const context = yield* Effect.context();
      const old = yield* registry
        .prepare(h.session, "env", target, context)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(began);
      registry.reset("env", target);
      yield* registry.prepare(h.session, "env", target, context);
      yield* Deferred.succeed(firstLease, { inputId: "old" });
      yield* Fiber.join(old);
      expect(cancelled).toEqual(["old"]);
      registry.reset("env", target);
    }),
  );
  it.effect("serializes legacy writes from multiple callers", () =>
    Effect.gen(function* () {
      const h = harness(false);
      const began = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sent: string[] = [];
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalWrite] = (input: {
        data: string;
      }) =>
        Effect.gen(function* () {
          sent.push(input.data);
          if (input.data === "a") {
            yield* Deferred.succeed(began, undefined);
            yield* Deferred.await(release);
          }
        });
      const binding = createOrderedTerminalInputBinding(
        h.session,
        "env",
        target,
        yield* Effect.context(),
      );
      const first = yield* binding.write("a").pipe(Effect.forkChild);
      yield* Deferred.await(began);
      const second = yield* binding.write("b").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(sent).toEqual(["a"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(sent).toEqual(["a", "b"]);
      binding.dispose();
    }),
  );
  it.effect("a superseded begin cannot replace a new lease after reset", () =>
    Effect.gen(function* () {
      const h = harness();
      const began = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      let calls = 0;
      let issued = 0;
      let current: { inputId: string; attachmentSequence: number } | null = null;
      const sequences: number[] = [];
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalBeginInput] = (input: {
        attachmentSequence: number;
      }) =>
        Effect.gen(function* () {
          sequences.push(input.attachmentSequence);
          if (++calls === 1) {
            yield* Deferred.succeed(began, undefined);
            yield* Deferred.await(releaseOld);
          }
          if (current !== null && input.attachmentSequence <= current.attachmentSequence) {
            return yield* new TerminalInputError({
              code: "closed",
              message: "Superseded attachment.",
            });
          }
          current = { inputId: `lease-${++issued}`, attachmentSequence: input.attachmentSequence };
          return { inputId: current.inputId };
        });
      (h.session.client as Record<string, unknown>)[WS_METHODS.terminalWriteInput] = (input: {
        inputId: string;
        sequence: number;
      }) =>
        Effect.suspend(() =>
          input.inputId === current?.inputId
            ? Effect.succeed({ inputId: input.inputId, sequence: input.sequence })
            : Effect.fail(new TerminalInputError({ code: "closed", message: "Lease replaced." })),
        );
      const registry = createTerminalInputBindingRegistry();
      const context = yield* Effect.context();
      const old = yield* registry
        .prepare(h.session, "env", target, context)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(began);
      registry.reset("env", target);
      yield* registry.prepare(h.session, "env", target, context);
      yield* registry.write(h.session, "env", target, "fresh before old resumes", context);
      yield* Deferred.succeed(releaseOld, undefined);
      yield* Fiber.join(old);
      yield* registry.write(h.session, "env", target, "fresh after old resumes", context);
      expect(sequences).toEqual([0, 1]);
      expect(issued).toBe(1);
      registry.reset("env", target);
      yield* registry.prepare(h.session, "env", target, context);
      expect(sequences).toEqual([0, 1, 2]);
      registry.reset("env", target);
    }),
  );

  it("never splits bracketed-paste opener or closer across 16 KiB frame boundaries", () => {
    const start = "\u001b[200~";
    const end = "\u001b[201~";
    const payload = `${"a".repeat(16 * 1024 - 2)}${start}${"b".repeat(16 * 1024 - 8)}${end}\r`;
    const frames = splitTerminalInputFrames(payload);
    expect(frames.join("")).toBe(payload);
    for (const frame of frames) {
      expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(16 * 1024);
      expect(frame.endsWith("\u001b")).toBe(false);
      expect(frame.endsWith("\u001b[")).toBe(false);
      expect(frame.endsWith("\u001b[2")).toBe(false);
      expect(frame.endsWith("\u001b[20")).toBe(false);
      expect(frame.endsWith("\u001b[200")).toBe(false);
      expect(frame.endsWith("\u001b[201")).toBe(false);
    }
  });

  it.effect(
    "stages >256 KiB multi-frame bracketed pastes with chunk/commit when terminalPasteAssembly is advertised",
    () =>
      Effect.gen(function* () {
        const start = "\u001b[200~";
        const end = "\u001b[201~";
        const recorded: Array<{ sequence: number; data: string; pasteStage?: string }> = [];
        const h = harness(true);
        (h.session as { initialConfig: RpcSession["initialConfig"] }).initialConfig =
          Effect.succeed({
            environment: {
              capabilities: { terminalOrderedInput: true, terminalPasteAssembly: true },
            },
          } as unknown as ServerConfig);
        (h.session.client as Record<string, unknown>)[WS_METHODS.terminalWriteInput] = (frame: {
          sequence: number;
          data: string;
          pasteStage?: string;
        }) =>
          Effect.sync(() => {
            recorded.push(frame);
            return { inputId: "lease", sequence: frame.sequence };
          });
        const binding = createOrderedTerminalInputBinding(
          h.session,
          "env",
          target,
          yield* Effect.context(),
        );
        const bigBody = "line\r".repeat(60_000); // 300 KiB > 256 KiB window (19+ frames)
        const payload = `pre${start}${bigBody}${end}\r`;
        yield* binding.write(payload);
        expect(recorded.map((f) => f.data).join("")).toBe(payload);
        expect(recorded[0]).toMatchObject({ sequence: 0, data: "pre" });
        expect(recorded[0]?.pasteStage).toBeUndefined();
        const pasteFrames = recorded.slice(1, -1);
        expect(pasteFrames.length).toBeGreaterThanOrEqual(17);
        for (const chunk of pasteFrames.slice(0, -1)) {
          expect(chunk.pasteStage).toBe("chunk");
        }
        expect(pasteFrames.at(-1)?.pasteStage).toBe("commit");
        expect(pasteFrames.at(-1)?.data.endsWith(end)).toBe(true);
        expect(recorded.at(-1)).toMatchObject({ data: "\r" });
        expect(recorded.at(-1)?.pasteStage).toBeUndefined();
        binding.dispose();
      }),
  );

  it.effect(
    "sends legacy terminal.write bracketed pastes up to 64 KiB in one write and fails cleanly above 64 KiB",
    () =>
      Effect.gen(function* () {
        const start = "\u001b[200~";
        const end = "\u001b[201~";
        const h = harness(false);
        const binding = createOrderedTerminalInputBinding(
          h.session,
          "env",
          target,
          yield* Effect.context(),
        );
        const mediumPaste = `${start}${"m".repeat(40_000)}${end}`;
        yield* binding.write(mediumPaste);
        expect(h.frames.map((f) => f.data)).toEqual([mediumPaste]);

        const oversizedPaste = `${start}${"z".repeat(70_000)}${end}`;
        const err = yield* binding.write(oversizedPaste).pipe(Effect.flip);
        expect(err.code).toBe("capacity");
        // Must not have sent a partial unclosed bracketed paste envelope.
        expect(h.frames.map((f) => f.data)).toEqual([mediumPaste]);
        binding.dispose();
      }),
  );
});
