import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { fileTransfers, noFileTransferAvailability } from "~/state/fileTransfers";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { fileActionErrorMessage } from "~/components/files/fileActionError";
import {
  filePreviewAvailability,
  filePreviewFailureTitle,
  openFileInPreview,
  type FilePreviewAvailability,
} from "./openFileInPreview";

/** The view owns disposal/resource changes; the state command owns actual server authority. */
export function useFilePreview({
  environmentId,
  threadRef,
  contextKey = "",
  onError,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly contextKey?: string;
  readonly onError?: (error: unknown, title: string) => void;
}) {
  const transport = useAtomValue(
    environmentId === null ? noFileTransferAvailability : fileTransfers.availability(environmentId),
  );
  const availability: FilePreviewAvailability =
    threadRef === undefined || threadRef.environmentId !== environmentId
      ? { enabled: false, reason: "Thread context is unavailable." }
      : filePreviewAvailability(transport, "");
  const open = useAtomCommand(previewEnvironment.openFile, { reportFailure: false });
  const key = JSON.stringify([
    threadRef ? scopedThreadKey(threadRef) : null,
    contextKey,
    transport.route,
    transport.connected,
  ]);
  // Pure candidate identity becomes current only at commit. A-B-A creates a new witness.
  const witness = useMemo(() => ({ key }), [key]);
  const frame = useRef<{ readonly key: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    frame.current = witness;
    return () => {
      if (frame.current !== witness) return;
      frame.current = null;
      pending.current?.abort();
      pending.current = null;
    };
  }, [witness]);
  const openFile = useCallback(
    async (filePath: string) => {
      if (frame.current !== witness || threadRef === undefined)
        return AsyncResult.failure(Cause.interrupt());
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      const current = () =>
        !controller.signal.aborted && frame.current === witness && pending.current === controller;
      try {
        const result = await openFileInPreview({
          threadRef,
          filePath,
          availability,
          openFile: open,
          signal: controller.signal,
          isCurrent: current,
        });
        if (current() && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          if (onError) onError(error, filePreviewFailureTitle(error));
          else
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: filePreviewFailureTitle(error),
                description: fileActionErrorMessage(error),
              }),
            );
        }
        return result;
      } catch (error) {
        if (!current()) return AsyncResult.failure(Cause.interrupt());
        if (onError) onError(error, filePreviewFailureTitle(error));
        else
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: filePreviewFailureTitle(error),
              description: fileActionErrorMessage(error),
            }),
          );
        return AsyncResult.failure(Cause.die(error));
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    },
    [availability, onError, open, threadRef, witness],
  );
  const isCurrentView = useCallback(() => frame.current === witness, [witness]);
  return { availability, openFile, isCurrentView };
}
