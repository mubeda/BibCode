import type { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { type GitSignInHandle, runGitSignIn } from "~/state/gitManager";

import {
  type GitSignInOffer,
  SIGN_IN_CANCELLED_MESSAGE,
  SIGN_IN_DECLINED_MESSAGE,
} from "./gitSignIn.logic";

export interface GitSignInRequest {
  readonly offer: GitSignInOffer;
  readonly cwd: string;
  /** Git Manager requests name their project; Source Control's do not. */
  readonly projectId?: ProjectId | undefined;
  /** Sends the failure's `resume` request. */
  readonly onSignedIn: () => void;
  /** Shows why the sign-in ended without a resume (Not now, failure, timeout, Cancel). */
  readonly onEnded: (code: string, message: string) => void;
}

export interface GitSignInFlow {
  readonly state: { readonly phase: "approval" | "waiting"; readonly offer: GitSignInOffer } | null;
  readonly offer: (request: GitSignInRequest) => void;
  readonly approve: () => void;
  readonly decline: () => void;
  readonly cancel: () => void;
}

/**
 * One Git Credential Manager sign-in (#325): the approval, `git.signIn` while GCM's window is
 * open, then either the failure's resume request or a message. Unmounting cancels it.
 */
export function useGitSignInFlow(environmentId: EnvironmentId): GitSignInFlow {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<GitSignInFlow["state"]>(null);
  const requestRef = useRef<GitSignInRequest | null>(null);
  const handleRef = useRef<GitSignInHandle | null>(null);
  useEffect(
    () => () => {
      handleRef.current?.cancel();
    },
    [],
  );

  const end = useCallback((code: string, message: string) => {
    const request = requestRef.current;
    requestRef.current = null;
    handleRef.current = null;
    setState(null);
    request?.onEnded(code, message);
  }, []);

  const offer = useCallback((request: GitSignInRequest) => {
    handleRef.current?.cancel();
    handleRef.current = null;
    requestRef.current = request;
    setState({ phase: "approval", offer: request.offer });
  }, []);

  const approve = useCallback(() => {
    const request = requestRef.current;
    if (request === null || handleRef.current !== null) return;
    setState({ phase: "waiting", offer: request.offer });
    const handle = runGitSignIn(registry, {
      environmentId,
      input: {
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        cwd: request.cwd,
        remote: request.offer.remote,
        direction: request.offer.direction,
        destination: request.offer.destination,
      },
    });
    handleRef.current = handle;
    void handle.result.then((result) => {
      if (handleRef.current !== handle) return;
      if (result._tag === "Success") {
        if (result.value.outcome === "signedIn") {
          requestRef.current = null;
          handleRef.current = null;
          setState(null);
          request.onSignedIn();
          return;
        }
        end(
          `sign-in-${result.value.outcome === "timedOut" ? "timed-out" : result.value.outcome}`,
          result.value.message,
        );
        return;
      }
      if (Cause.hasInterruptsOnly(result.cause)) {
        end("sign-in-cancelled", SIGN_IN_CANCELLED_MESSAGE);
        return;
      }
      const error = Cause.squash(result.cause);
      end(
        "sign-in-failed",
        error instanceof Error && error.message !== "" ? error.message : "The sign-in failed.",
      );
    });
  }, [end, environmentId, registry]);

  const decline = useCallback(() => {
    end("authentication", SIGN_IN_DECLINED_MESSAGE);
  }, [end]);

  const cancel = useCallback(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    handle.cancel();
  }, []);

  return { state, offer, approve, decline, cancel };
}
