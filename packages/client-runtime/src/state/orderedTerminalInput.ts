import {
  TerminalInputError,
  WS_METHODS,
  type TerminalBeginInput,
  type TerminalPasteStage,
  type TerminalWriteInputFrame,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  requestInSession,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
} from "../rpc/client.ts";
import { TerminalInputAdmissionSignal } from "../rpc/inputAdmission.ts";
import type { RpcSession } from "../rpc/session.ts";

import { partitionTerminalInputSegments, sliceDelimiterSafeFrames } from "./terminalInput.ts";

export type TerminalInputTarget = Omit<TerminalBeginInput, "attachmentSequence">;
/** Who produced input (`userInputClaim`); `undefined` leaves it unmarked, as older clients do. */
export type TerminalInputOrigin = TerminalWriteInputFrame["userInputClaim"];

const MAX_ORDERED_WINDOW = 16;
const MAX_BINDING_IN_FLIGHT = 8;
const MAX_LEGACY_WRITE_LENGTH = 65_536;
const nextAttachmentSequence = new WeakMap<RpcSession, number>();
const encoder = new TextEncoder();
const isTerminalInputError = Schema.is(TerminalInputError);
const inputError = (message: string) => new TerminalInputError({ code: "closed", message });

/** Every RPC here runs under a 15-second timeout whose `TimeoutError` has no message. */
function describeInputFailure(error: unknown): string {
  if (Cause.isTimeoutError(error)) {
    return "Terminal input timed out after 15 seconds. Reattach before typing again.";
  }
  return error instanceof Error && typeof error.message === "string" && error.message.length > 0
    ? error.message
    : String(error);
}

export interface StagedTerminalInputFrame {
  readonly data: string;
  readonly pasteStage?: TerminalPasteStage;
}

/**
 * Splits `data` in strict stream order into UTF-8 and delimiter-safe 16 KiB frames.
 * Multi-frame complete bracketed pastes receive `"chunk"` / `"commit"` staging markers when
 * `stageMultiFramePaste` is enabled.
 */
export function splitTerminalInputPasteFrames(
  data: string,
  stageMultiFramePaste: boolean,
): StagedTerminalInputFrame[] {
  const frames: StagedTerminalInputFrame[] = [];
  for (const segment of partitionTerminalInputSegments(data)) {
    const pieces = sliceDelimiterSafeFrames(segment.data);
    if (segment.kind === "paste" && stageMultiFramePaste && pieces.length > 1) {
      for (let index = 0; index < pieces.length; index += 1) {
        frames.push({
          data: pieces[index]!,
          pasteStage: index + 1 === pieces.length ? "commit" : "chunk",
        });
      }
    } else {
      for (const piece of pieces) {
        frames.push({ data: piece });
      }
    }
  }
  return frames;
}

/** UTF-8 frames preserve complete Unicode scalar values and never split paste delimiters. */
export function splitTerminalInputFrames(data: string): string[] {
  return splitTerminalInputPasteFrames(data, false).map((frame) => frame.data);
}

export interface OrderedTerminalInputBinding {
  readonly session: RpcSession;
  readonly prepare: Effect.Effect<void, TerminalInputError>;
  readonly write: (
    data: string,
    origin?: TerminalInputOrigin,
  ) => Effect.Effect<void, TerminalInputError>;
  /** Synchronously fences all work; cancellation of the captured lease runs independently. */
  readonly dispose: () => void;
  /** Disposed, by its owner or by a failure: it accepts no more work. */
  readonly stopped: () => boolean;
}

export function createOrderedTerminalInputBinding(
  session: RpcSession,
  environmentId: string,
  target: TerminalInputTarget,
  context: Context.Context<never> = Context.empty(),
): OrderedTerminalInputBinding {
  const attachmentSequence = nextAttachmentSequence.get(session) ?? 0;
  nextAttachmentSequence.set(session, attachmentSequence + 1);
  const runPromise = Effect.runPromiseWith(context);
  const controller = new AbortController();
  let stopped = false;
  let ordered = false;
  let pasteAssembly = false;
  let inputId: string | undefined;
  let sequence = 0;
  let nextAckedSequence = 0;
  const ackedAhead = new Set<number>();
  let inFlightFrames = 0;
  let pendingBytes = 0;
  let preparation: Promise<void> | undefined;
  let orderedTail = Promise.resolve();
  let legacyTail = Promise.resolve();
  const dispatchQueue: Array<{
    readonly sequence: number;
    readonly start: () => void;
    readonly fail: (error: TerminalInputError) => void;
  }> = [];
  const check = () => {
    if (stopped) throw inputError("Terminal input stopped. Reattach before typing again.");
  };
  const pumpDispatch = (): void => {
    if (stopped) return;
    while (
      dispatchQueue.length > 0 &&
      inFlightFrames < MAX_BINDING_IN_FLIGHT &&
      dispatchQueue[0]!.sequence - nextAckedSequence < MAX_ORDERED_WINDOW
    ) {
      const next = dispatchQueue.shift()!;
      inFlightFrames += 1;
      next.start();
    }
  };
  const run = <T extends EnvironmentUnaryRpcTag>(
    tag: T,
    input: EnvironmentRpcInput<T>,
    abortable = true,
  ) =>
    runPromise(
      requestInSession(session, environmentId, tag, input).pipe(
        Effect.provideService(TerminalInputAdmissionSignal, controller.signal),
        Effect.raceFirst(session.closed),
        Effect.timeout("15 seconds"),
      ),
      abortable ? { signal: controller.signal } : undefined,
    );
  const cancelLease = (lease: string): void => {
    void runPromise(
      requestInSession(session, environmentId, WS_METHODS.terminalCancelInput, {
        ...target,
        inputId: lease,
      }).pipe(Effect.raceFirst(session.closed), Effect.timeout("5 seconds")),
    ).catch(() => undefined);
  };
  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    const error = inputError("Terminal input stopped. Reattach before typing again.");
    while (dispatchQueue.length > 0) {
      dispatchQueue.shift()!.fail(error);
    }
    const lease = inputId;
    if (lease !== undefined) cancelLease(lease);
  };
  const prepare = (): Promise<void> => {
    check();
    preparation ??= (async () => {
      const config = await runPromise(
        session.initialConfig.pipe(Effect.raceFirst(session.closed), Effect.timeout("15 seconds")),
        { signal: controller.signal },
      );
      check();
      ordered = config.environment.capabilities.terminalOrderedInput === true;
      pasteAssembly = ordered && config.environment.capabilities.terminalPasteAssembly === true;
      if (ordered) {
        if (!Number.isSafeInteger(attachmentSequence)) {
          throw new TerminalInputError({
            code: "capacity",
            message: "Terminal attachment sequence exhausted. Reconnect before typing again.",
          });
        }
        const lease = await run(
          WS_METHODS.terminalBeginInput,
          { ...target, attachmentSequence },
          false,
        );
        if (stopped) {
          cancelLease(lease.inputId);
          check();
        }
        inputId = lease.inputId;
      }
    })().catch((error: unknown) => {
      dispose();
      throw error;
    });
    return preparation;
  };
  const mapError = (error: unknown): TerminalInputError =>
    isTerminalInputError(error) ? error : inputError(describeInputFailure(error));
  return {
    session,
    prepare: Effect.tryPromise({ try: prepare, catch: mapError }),
    write: (data, origin) =>
      Effect.tryPromise({
        try: async (signal) => {
          check();
          const bytes = encoder.encode(data).length;
          if (pendingBytes + bytes > 1024 * 1024) {
            dispose();
            throw new TerminalInputError({
              code: "capacity",
              message:
                "Terminal input exceeded the 1 MiB pending limit. Reattach before typing again.",
            });
          }
          pendingBytes += bytes;
          const abort = () => dispose();
          signal.addEventListener("abort", abort, { once: true });
          const marked = origin === undefined ? {} : { userInputClaim: origin };
          // A binding created by a write keeps that write's input as its target: frames take
          // only the session fields from it, so one write's origin never marks another's.
          const sessionTarget = { threadId: target.threadId, terminalId: target.terminalId };
          try {
            // Preserve call order across prepare() before claiming ordered sequence numbers.
            const ready = orderedTail.then(() => prepare());
            orderedTail = ready.catch(() => undefined);
            await ready;
            check();
            if (ordered) {
              const frames = splitTerminalInputPasteFrames(data, pasteAssembly);
              const lease = inputId!;
              const scheduled = frames.map((frame) => {
                const frameSequence = sequence++;
                return new Promise<void>((resolve, reject) => {
                  dispatchQueue.push({
                    sequence: frameSequence,
                    fail: reject,
                    start: () => {
                      void (async () => {
                        try {
                          check();
                          const acknowledgement = await run(WS_METHODS.terminalWriteInput, {
                            ...sessionTarget,
                            inputId: lease,
                            sequence: frameSequence,
                            data: frame.data,
                            ...marked,
                            ...(frame.pasteStage ? { pasteStage: frame.pasteStage } : {}),
                          });
                          check();
                          if (
                            acknowledgement.inputId !== lease ||
                            acknowledgement.sequence !== frameSequence
                          ) {
                            throw new TerminalInputError({
                              code: "sequence",
                              message: "Terminal input acknowledgement did not match its frame.",
                            });
                          }
                          ackedAhead.add(frameSequence);
                          while (ackedAhead.delete(nextAckedSequence)) {
                            nextAckedSequence += 1;
                          }
                          resolve();
                        } catch (error) {
                          reject(error);
                        } finally {
                          inFlightFrames -= 1;
                          pumpDispatch();
                        }
                      })();
                    },
                  });
                });
              });
              pumpDispatch();
              await Promise.all(scheduled);
            } else {
              const segments = partitionTerminalInputSegments(data);
              const legacyFrames: string[] = [];
              for (const segment of segments) {
                if (segment.kind === "paste") {
                  if (
                    segment.data.length > MAX_LEGACY_WRITE_LENGTH ||
                    encoder.encode(segment.data).length > MAX_LEGACY_WRITE_LENGTH
                  ) {
                    throw new TerminalInputError({
                      code: "capacity",
                      message: "Terminal paste exceeds the 64 KiB limit for legacy terminal input.",
                    });
                  }
                  legacyFrames.push(segment.data);
                } else {
                  legacyFrames.push(...sliceDelimiterSafeFrames(segment.data));
                }
              }
              const write = legacyTail.then(async () => {
                check();
                for (const frame of legacyFrames) {
                  await run(WS_METHODS.terminalWrite, { ...sessionTarget, data: frame, ...marked });
                }
              });
              legacyTail = write.catch(() => undefined);
              await write;
            }
          } catch (error) {
            if (ordered) dispose();
            throw error;
          } finally {
            pendingBytes -= bytes;
            signal.removeEventListener("abort", abort);
          }
        },
        catch: mapError,
      }),
    dispose,
    stopped: () => stopped,
  };
}

/** Attachment owns reset/prepare; ordinary writes cannot revive an invalidated binding. */
export function createTerminalInputBindingRegistry() {
  const bindings = new Map<string, OrderedTerminalInputBinding | null>();
  const key = (environmentId: string, target: TerminalInputTarget) =>
    JSON.stringify([environmentId, target.threadId, target.terminalId ?? null]);
  return {
    prepare(
      session: RpcSession,
      environmentId: string,
      target: TerminalInputTarget,
      context?: Context.Context<never>,
    ) {
      const id = key(environmentId, target);
      let binding = bindings.get(id);
      // A binding a failure stopped would replay that failure to every later attachment.
      if (binding == null || binding.session !== session || binding.stopped()) {
        binding?.dispose();
        binding = createOrderedTerminalInputBinding(session, environmentId, target, context);
        bindings.set(id, binding);
      }
      return binding.prepare;
    },
    write(
      session: RpcSession,
      environmentId: string,
      target: TerminalInputTarget,
      data: string,
      context?: Context.Context<never>,
      origin?: TerminalInputOrigin,
    ) {
      const id = key(environmentId, target);
      let binding = bindings.get(id);
      if (binding === null || (binding !== undefined && binding.session !== session)) {
        binding?.dispose();
        return Effect.fail(inputError("Terminal input requires a fresh attachment."));
      }
      if (binding === undefined) {
        binding = createOrderedTerminalInputBinding(session, environmentId, target, context);
        bindings.set(id, binding);
      }
      return binding.write(data, origin);
    },
    reset(
      environmentId: string,
      target: { readonly threadId: string; readonly terminalId?: string | undefined },
    ): void {
      if (target.terminalId === undefined) {
        const prefix = JSON.stringify([environmentId, target.threadId]).slice(0, -1) + ",";
        for (const [id, binding] of bindings) {
          if (id.startsWith(prefix)) {
            bindings.set(id, null);
            binding?.dispose();
          }
        }
        return;
      }
      const id = key(environmentId, { ...target, terminalId: target.terminalId });
      const binding = bindings.get(id);
      bindings.set(id, null);
      binding?.dispose();
    },
  };
}
