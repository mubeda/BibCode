import type { EnvironmentId, ScopedThreadRef, SendRequest } from "@bibcode/contracts";
import { useCallback } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { terminalEnvironment } from "~/state/terminal";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { parseAgentAddress } from "./sendToAgent.logic";

/** Opens where a request's target lives: the AI Terminal's tab, else its thread. */
export type OpenSendTarget = (target: ScopedThreadRef, terminalId: string | null) => void;

export const TERMINAL_CLOSED_TITLE = "That terminal has closed";
export const TERMINAL_CLOSED_DESCRIPTION = "Opened its thread instead.";

/**
 * The Open action of a request row. A request to an AI Terminal opens that terminal's tab; when
 * the terminal is gone, the thread opens and a toast says why.
 */
export function useSendTargetOpener(
  environmentId: EnvironmentId,
  request: Pick<SendRequest, "target" | "targetThreadId">,
  targetRef: ScopedThreadRef,
  onOpen: OpenSendTarget,
): () => void {
  const terminalId = parseAgentAddress(request.target)?.terminalId ?? null;
  // Only a terminal target reads the terminal list, so a chat row never subscribes to it.
  const terminals = useEnvironmentQuery(
    terminalId === null ? null : terminalEnvironment.metadata({ environmentId, input: null }),
  ).data;
  return useCallback(() => {
    const gone =
      terminalId !== null &&
      terminals !== null &&
      !terminals.some(
        (summary) =>
          summary.threadId === request.targetThreadId && summary.terminalId === terminalId,
      );
    if (gone) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: TERMINAL_CLOSED_TITLE,
          description: TERMINAL_CLOSED_DESCRIPTION,
        }),
      );
    }
    onOpen(targetRef, gone ? null : terminalId);
  }, [onOpen, request.targetThreadId, targetRef, terminalId, terminals]);
}
