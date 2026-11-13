// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Rpc from "effect/rpc/Rpc";

import { WS_METHODS, WsTerminalResizeRpc } from "./rpc.ts";
import { ServerHostMetricsSample } from "./server.ts";
import { TerminalError, TerminalResizeInput, TerminalSessionSnapshot } from "./terminal.ts";

/**
 * Mixed versions of BiBCode share one terminal (#348). These pin what each side of an older
 * pair decodes from the other, through the same JSON exit codec `RpcClient` uses.
 */
type DecodeExit = (value: unknown) => { readonly _tag: string; readonly value?: unknown };
const exitCodec = (rpc: Rpc.Any) => Schema.toCodecJson(Rpc.exitSchema(rpc as never)) as never;

/** `terminal.resize` as clients before the structured answer declared it: a void result. */
const OlderClientResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput.mapFields(Struct.omit(["structuredResult"])),
  error: TerminalError,
});

const decodeOlderClientExit: DecodeExit = Schema.decodeUnknownSync(exitCodec(OlderClientResizeRpc));
const decodeNewerClientExit: DecodeExit = Schema.decodeUnknownSync(exitCodec(WsTerminalResizeRpc));
const decodeOlderClientRequest = Schema.decodeUnknownSync(OlderClientResizeRpc.payloadSchema);
const decodeNewerClientRequest = Schema.decodeUnknownSync(TerminalResizeInput);

const structuredAnswer = {
  outcome: "applied",
  size: { cols: 120, rows: 40, sizeClaim: "claim-a" },
  generation: { boot: "boot-a", process: 1 },
  sequence: 7,
};

describe("terminal.resize across versions", () => {
  it("an older client accepts only null, so a server answers it null", () => {
    const decode = decodeOlderClientExit;
    expect(decode({ _tag: "Success", value: null })._tag).toBe("Success");
    expect(() => decode({ _tag: "Success", value: structuredAnswer })).toThrow(/null/);
  });

  it("a newer client decodes an older server's null and a newer server's outcome", () => {
    const decode = decodeNewerClientExit;
    expect(decode({ _tag: "Success", value: null })).toMatchObject({ value: null });
    expect(decode({ _tag: "Success", value: structuredAnswer })).toMatchObject({
      value: structuredAnswer,
    });
  });

  it("a newer client's request decodes for a peer that does not know the field", () => {
    const request = {
      threadId: "thread-a",
      terminalId: "term",
      cols: 120,
      rows: 40,
      structuredResult: true,
    };
    expect(decodeOlderClientRequest(request)).toEqual({
      threadId: "thread-a",
      terminalId: "term",
      cols: 120,
      rows: 40,
    });
    expect(decodeNewerClientRequest(request)).toEqual(request);
  });
});

/** The attach stream's events as clients before terminal generations declared them. */
const OlderSnapshot = TerminalSessionSnapshot.mapFields(Struct.omit(["generation"]));
const olderEventBase = {
  threadId: Schema.String,
  terminalId: Schema.String,
  sequence: Schema.optional(Schema.Int),
};
const OlderTerminalEvent = Schema.Union([
  Schema.Struct({ ...olderEventBase, type: Schema.Literal("snapshot"), snapshot: OlderSnapshot }),
  Schema.Struct({
    ...olderEventBase,
    type: Schema.Literal("exited"),
    exitCode: Schema.NullOr(Schema.Int),
    exitSignal: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({ ...olderEventBase, type: Schema.Literal("closed") }),
]);
const OlderHostMetricsSample = ServerHostMetricsSample.mapFields(
  Struct.omit(["volumeListingNotResponding", "sequence", "ageMs"]),
);

const decodeOlderTerminalEvent = Schema.decodeUnknownSync(OlderTerminalEvent);
const decodeOlderHostMetricsSample = Schema.decodeUnknownSync(OlderHostMetricsSample);

const fixture = (name: string) =>
  JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../fixtures/rpc-wire/stream-shapes", name),
      "utf8",
    ),
  ) as { readonly values: ReadonlyArray<Record<string, unknown>> };

describe("optional keys added for #348 and #292 reach older decoders", () => {
  const generation = { boot: "boot-a", process: 3 };

  it("an older client drops the generation of a snapshot, an exit and a close", () => {
    const decode = decodeOlderTerminalEvent;
    const snapshot = {
      threadId: "thread-a",
      terminalId: "term",
      cwd: "/workspace",
      worktreePath: null,
      status: "running",
      pid: 42,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "shell",
      updatedAt: "2026-11-12T00:00:00.000Z",
      sequence: 4,
      size: { cols: 80, rows: 24, sizeClaim: null },
      generation,
    };
    const base = { threadId: "thread-a", terminalId: "term", sequence: 5 };
    const decodedSnapshot = decode({ ...base, type: "snapshot", snapshot }) as {
      readonly snapshot: object;
    };
    expect(decodedSnapshot.snapshot).not.toHaveProperty("generation");
    expect(
      decode({ ...base, type: "exited", exitCode: 0, exitSignal: null, generation }),
    ).not.toHaveProperty("generation");
    expect(decode({ ...base, type: "closed", generation })).not.toHaveProperty("generation");
    for (const event of fixture("subscribeTerminalEvents-02.json").values) {
      expect(() => decode(event)).not.toThrow();
    }
  });

  it("an older client decodes a host metrics sample with the new optional keys", () => {
    const decode = decodeOlderHostMetricsSample;
    for (const event of fixture("server__subscribeHostMetrics-01.json").values) {
      const sample = event["sample"] as Record<string, unknown> | undefined;
      if (sample === undefined) continue;
      expect(sample).toHaveProperty("sequence");
      expect(decode(sample)).not.toHaveProperty("sequence");
    }
  });
});
