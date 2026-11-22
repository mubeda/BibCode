import type {
  EnvironmentId,
  GitManagerOperationEvent,
  GitManagerOperationRequest,
} from "@bibcode/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { SIGN_IN_CANCELLED_MESSAGE, SIGN_IN_REPEATED_MESSAGE } from "../gitSignIn/gitSignIn.logic";
import { type GitSignInFlow, useGitSignInFlow } from "../gitSignIn/useGitSignInFlow";

type FailedEvent = Extract<GitManagerOperationEvent, { _tag: "failed" }>;

export interface GitManagerSignInHandlers {
  /** Sends the offer's `resume` request unchanged after the person signed in. */
  readonly resume: (request: GitManagerOperationRequest) => Promise<unknown>;
  /** Shows why the sign-in ended without a resume (Not now, failure, timeout, Cancel). */
  readonly onEnded: (failure: FailedEvent) => void;
}

/**
 * The Git Manager side of a #325 sign-in: `present` turns a `sign-in-required` failure into an
 * offer on `flow` and returns the failure without it. A second offer while the resumed request
 * runs is shown as a message instead. The panel and the toolbar each own one.
 */
export function useGitManagerSignIn(
  environmentId: EnvironmentId,
  handlers: GitManagerSignInHandlers,
): {
  readonly flow: GitSignInFlow;
  readonly present: (event: GitManagerOperationEvent) => GitManagerOperationEvent;
} {
  const flow = useGitSignInFlow(environmentId);
  const offerSignIn = flow.offer;
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const resumingRef = useRef(false);
  // Cancel, Not now and unmounting end the offer here at once: its prompt hides, and a
  // sign-in that still settles afterwards (it raced the Cancel) resumes nothing and reports
  // nothing, so it cannot overwrite a newer message (#397 round 3).
  const generationRef = useRef(0);
  const [endedGeneration, setEndedGeneration] = useState(-1);
  const [offeredGeneration, setOfferedGeneration] = useState(0);
  const failureRef = useRef<FailedEvent | null>(null);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );
  const endHere = useCallback(() => {
    setEndedGeneration(generationRef.current);
    generationRef.current += 1;
  }, []);
  const { cancel: cancelFlow, decline: declineFlow } = flow;
  const cancel = useCallback(() => {
    const failure = failureRef.current;
    endHere();
    cancelFlow();
    if (failure !== null) {
      handlersRef.current.onEnded({
        ...failure,
        code: "sign-in-cancelled",
        message: SIGN_IN_CANCELLED_MESSAGE,
        blocked: null,
      });
    }
  }, [cancelFlow, endHere]);
  const decline = useCallback(() => {
    // The shared hook reports Not now itself, synchronously, before the offer ends here.
    declineFlow();
    endHere();
  }, [declineFlow, endHere]);
  const present = useCallback(
    (event: GitManagerOperationEvent): GitManagerOperationEvent => {
      if (event._tag !== "failed" || event.signIn === undefined) return event;
      const { signIn: offer, ...failure } = event;
      if (resumingRef.current) return { ...failure, message: SIGN_IN_REPEATED_MESSAGE };
      generationRef.current += 1;
      const generation = generationRef.current;
      failureRef.current = failure;
      setOfferedGeneration(generation);
      offerSignIn({
        offer,
        cwd: offer.resume.cwd,
        projectId: offer.resume.projectId,
        onSignedIn: () => {
          if (generation !== generationRef.current) return;
          resumingRef.current = true;
          void handlersRef.current.resume(offer.resume).finally(() => {
            resumingRef.current = false;
          });
        },
        onEnded: (code, message) => {
          if (generation !== generationRef.current) return;
          handlersRef.current.onEnded({ ...failure, code, message, blocked: null });
        },
      });
      return failure;
    },
    [offerSignIn],
  );
  const state = offeredGeneration === endedGeneration ? null : flow.state;
  return { flow: { ...flow, state, cancel, decline }, present };
}
