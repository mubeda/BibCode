import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { nextTerminalId } from "@bibcode/shared/terminalLabels";

export interface TerminalIdReservation {
  readonly terminalId: string;
  release(): void;
}

const reservedIdsByThreadKey = new Map<string, Set<string>>();

/**
 * Reserves the next terminal id for a server thread until the caller's open
 * transaction settles. Every center and right-panel creation path shares this
 * authority so concurrent surfaces cannot alias the same backend session.
 */
export function reserveTerminalId(
  threadRef: ScopedThreadRef,
  existingTerminalIds: ReadonlyArray<string>,
): TerminalIdReservation {
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
