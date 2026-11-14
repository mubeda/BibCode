import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@bibcode/client-runtime/state/runtime";
import { createSendRequestsEnvironmentAtoms } from "@bibcode/client-runtime/state/sendRequests";
import type {
  EnvironmentId,
  SendRequest,
  SendRequestError,
  SendRequestsGetHandoffTextInput,
  SendRequestsSendInput,
} from "@bibcode/contracts";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const sendRequestsEnvironment = createSendRequestsEnvironmentAtoms(connectionAtomRuntime);

const NO_REQUESTS: ReadonlyArray<SendRequest> = [];

/** The environment's undismissed requests, newest first; `null` reads nothing. */
export function useSendRequests(environmentId: EnvironmentId | null): ReadonlyArray<SendRequest> {
  const query = useEnvironmentQuery(
    environmentId === null ? null : sendRequestsEnvironment.requests({ environmentId, input: {} }),
  );
  const requests = query.data;
  return useMemo(
    () => requests?.filter((request) => request.dismissedAt === null) ?? NO_REQUESTS,
    [requests],
  );
}

export type SendOutcome =
  | { kind: "sent" }
  | { kind: "failed"; reason: SendRequestError["reason"] | "unknown_outcome"; message: string };

const UNKNOWN_OUTCOME: SendOutcome = {
  kind: "failed",
  reason: "unknown_outcome",
  message: "The connection dropped before the server answered.",
};

function isSendRequestError(failure: unknown): failure is SendRequestError {
  return (
    typeof failure === "object" &&
    failure !== null &&
    (failure as { _tag?: unknown })._tag === "SendRequestError" &&
    typeof (failure as { reason?: unknown }).reason === "string"
  );
}

/** A typed `SendRequestError` keeps its reason. Any other failure may have reached the server. */
export function outcomeFromCommandResult(result: AtomCommandResult<unknown, unknown>): SendOutcome {
  if (result._tag === "Success") return { kind: "sent" };
  if (isAtomCommandInterrupted(result)) return UNKNOWN_OUTCOME;
  const failure = squashAtomCommandFailure(result);
  if (isSendRequestError(failure)) {
    return { kind: "failed", reason: failure.reason, message: failure.message };
  }
  return UNKNOWN_OUTCOME;
}

export function useSendRequest(environmentId: EnvironmentId) {
  const run = useAtomCommand(sendRequestsEnvironment.send, { reportFailure: false });
  return useCallback(
    async (input: SendRequestsSendInput): Promise<SendOutcome> =>
      outcomeFromCommandResult(await run({ environmentId, input })),
    [environmentId, run],
  );
}

export function useCancelSendRequest(environmentId: EnvironmentId) {
  const run = useAtomCommand(sendRequestsEnvironment.cancel, { reportFailure: false });
  return useCallback(
    async (requestId: string): Promise<SendOutcome> =>
      outcomeFromCommandResult(await run({ environmentId, input: { requestId } })),
    [environmentId, run],
  );
}

export function useDismissSendRequest(environmentId: EnvironmentId) {
  const run = useAtomCommand(sendRequestsEnvironment.dismiss, { reportFailure: false });
  return useCallback(
    async (requestId: string): Promise<SendOutcome> =>
      outcomeFromCommandResult(await run({ environmentId, input: { requestId } })),
    [environmentId, run],
  );
}

/** A thread's handoff text, read from its stored messages; rejects when it cannot be read. */
export function useGetHandoffText(environmentId: EnvironmentId) {
  const run = useAtomCommand(sendRequestsEnvironment.getHandoffText, { reportFailure: false });
  return useCallback(
    async (input: SendRequestsGetHandoffTextInput) => {
      const result = await run({ environmentId, input });
      if (result._tag !== "Success") throw new Error("The handoff text could not be read.");
      return result.value;
    },
    [environmentId, run],
  );
}

/** The stored answer of a request, as the command result so the caller can show its failure. */
export function useGetAnswer(environmentId: EnvironmentId) {
  const run = useAtomCommand(sendRequestsEnvironment.getAnswer, { reportFailure: false });
  return useCallback(
    (requestId: string) => run({ environmentId, input: { requestId } }),
    [environmentId, run],
  );
}
