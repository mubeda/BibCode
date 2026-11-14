import { SendRequestError } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@bibcode/client-runtime/state/sendRequests", () => ({
  createSendRequestsEnvironmentAtoms: () => ({}),
}));

import { outcomeFromCommandResult } from "./sendRequests";

describe("outcomeFromCommandResult", () => {
  it("a successful command is sent", () => {
    expect(outcomeFromCommandResult(AsyncResult.success({}))).toEqual({ kind: "sent" });
  });

  it("a typed SendRequestError keeps its reason", () => {
    const error = new SendRequestError({ reason: "unknown_thread", message: "No such thread." });
    expect(outcomeFromCommandResult(AsyncResult.failure(Cause.fail(error)))).toEqual({
      kind: "failed",
      reason: "unknown_thread",
      message: "No such thread.",
    });
  });

  it("a transport failure is an unknown outcome", () => {
    const result = outcomeFromCommandResult(
      AsyncResult.failure(Cause.fail(new Error("socket closed"))),
    );
    expect(result).toMatchObject({ kind: "failed", reason: "unknown_outcome" });
  });

  it("an interrupted command is an unknown outcome", () => {
    const result = outcomeFromCommandResult(AsyncResult.failure(Cause.interrupt()));
    expect(result).toMatchObject({ kind: "failed", reason: "unknown_outcome" });
  });
});
