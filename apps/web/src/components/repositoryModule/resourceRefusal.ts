import { useEffect, useSyncExternalStore } from "react";

/** Why a host refused a resource: the view hides every copy it holds of it. */
export type ResourceRefusal = "forbidden" | "not_found";

interface Held {
  readonly code: ResourceRefusal;
  /** The live read's value when the latest refusal arrived: only a later successful read lifts it. */
  readonly data: unknown;
}

// Outside the components on purpose: a view that remounts (a filter reset re-keys it, a
// route change unmounts it) still finds the refusal, while the atom cache and the stored
// copy can still paint the refused rows.
// The codes also live in this tab's session storage: after a reload the stored page paints
// before the first live read answers, and only that read may lift a refusal.
const STORAGE_KEY = "bibcode:resourceRefusals";
/** The mark a restored refusal holds: any successful live read after a reload is newer. */
const RESTORED: unknown = Symbol("restored refusal");
const refusals = new Map<string, Held>(
  Object.entries(readStoredCodes()).map(([key, code]) => [key, { code, data: RESTORED }]),
);
function readStoredCodes(): Record<string, ResourceRefusal> {
  try {
    const stored: unknown = JSON.parse(globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? "{}");
    return stored !== null && typeof stored === "object"
      ? Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, ResourceRefusal] =>
              entry[1] === "forbidden" || entry[1] === "not_found",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
function storeCodes() {
  try {
    if (refusals.size === 0) globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    else
      globalThis.sessionStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify(Object.fromEntries([...refusals].map(([key, held]) => [key, held.code]))),
      );
  } catch {
    // Without storage a reload forgets the refusal, as before.
  }
}
// A change event carries its refusal once: a later successful read lifts it for good.
let countedEvents = new WeakSet<object>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notify() {
  for (const listener of listeners) listener();
}

/** Forgets every refusal; for tests, which share this module between cases. */
export function clearResourceRefusals() {
  refusals.clear();
  storeCodes();
  countedEvents = new WeakSet();
  notify();
}

/**
 * The refusal in force for `key`: the live read's own refusal now, a change event's
 * refusal, or an earlier one that no later successful live read of the same resource
 * has lifted. A timeout, a pending retry or refresh, another resource's read, a
 * remount and a stored copy never lift it.
 *
 * `key` names the repository as well as the read: a checkout path can point at another
 * repository once its remote changes. `read` must be the live read of the resource, never a view that mixes in a stored
 * copy: only the host can say access came back.
 */
export function useResourceRefusal(
  key: string,
  read: { readonly data: unknown; readonly error: string | null; readonly isPending: boolean },
  refusedNow: ResourceRefusal | null,
  refusalEvent: { readonly refused?: ResourceRefusal | undefined } | null = null,
): ResourceRefusal | null {
  const held = useSyncExternalStore(
    subscribe,
    () => refusals.get(key),
    () => refusals.get(key),
  );
  const eventCode = refusalEvent?.refused ?? null;
  const eventUncounted = useSyncExternalStore(
    subscribe,
    () => refusalEvent !== null && !countedEvents.has(refusalEvent),
    () => false,
  );
  const now = refusedNow ?? (eventUncounted ? eventCode : null);
  const data = read.data;
  const lifted =
    held !== undefined &&
    now === null &&
    read.error === null &&
    !read.isPending &&
    data !== null &&
    data !== held.data;
  useEffect(() => {
    let changed = false;
    if (refusalEvent !== null && eventCode !== null && !countedEvents.has(refusalEvent)) {
      countedEvents.add(refusalEvent);
      changed = true;
    }
    const current = refusals.get(key);
    // Every refusal moves the mark to the value on screen when it arrived, whatever its
    // code: only a successful read after the latest refusal carries another value.
    if (now !== null && (current?.code !== now || current.data !== data)) {
      refusals.set(key, { code: now, data });
      changed = true;
    } else if (lifted && current !== undefined) {
      refusals.delete(key);
      changed = true;
    }
    if (changed) {
      storeCodes();
      notify();
    }
  }, [data, eventCode, key, lifted, now, refusalEvent]);
  return now ?? (lifted ? null : (held?.code ?? null));
}
