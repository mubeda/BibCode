import type { ScopedThreadRef } from "@bibcode/contracts";
import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import { nextTerminalId } from "@bibcode/shared/terminalLabels";

export interface CenterTerminalIdReservation {
  readonly terminalId: string;
  release(): void;
}

const reservedIdsByThreadKey = new Map<string, Set<string>>();

/**
 * Reserves the next center-terminal id until the caller's asynchronous open
 * transaction settles. Reservations are scoped to the server thread so
 * concurrent ChatView actions cannot alias the same backend session.
 */
export function reserveCenterTerminalId(
  threadRef: ScopedThreadRef,
  existingTerminalIds: ReadonlyArray<string>,
): CenterTerminalIdReservation {
  const threadKey = scopedThreadKey(threadRef);
  const reservedIds = reservedIdsByThreadKey.get(threadKey) ?? new Set<string>();
  reservedIdsByThreadKey.set(threadKey, reservedIds);

  const terminalId = nextTerminalId([...existingTerminalIds, ...reservedIds]);
  reservedIds.add(terminalId);
  let released = false;

  return {
    terminalId,
    release() {
      if (released) return;
      released = true;
      reservedIds.delete(terminalId);
      if (reservedIds.size === 0) {
        reservedIdsByThreadKey.delete(threadKey);
      }
    },
  };
}
