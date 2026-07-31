import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function legacyStorageKey(name: string): string | null {
  if (name.startsWith("bibcode:")) return `t4code:${name.slice("bibcode:".length)}`;
  if (name.startsWith("bibcode.")) return `t4code.${name.slice("bibcode.".length)}`;
  return null;
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  const resolved = isStateStorage(storage) ? storage : createMemoryStorage();
  return {
    getItem: (name) => {
      const current = resolved.getItem(name);
      const readLegacy = (value: string | null) => {
        if (value !== null) return value;
        const legacyKey = legacyStorageKey(name);
        if (legacyKey === null) return null;
        const legacy = resolved.getItem(legacyKey);
        const copy = (legacyValue: string | null) => {
          if (legacyValue !== null) resolved.setItem(name, legacyValue);
          return legacyValue;
        };
        return legacy instanceof Promise ? legacy.then(copy) : copy(legacy);
      };
      return current instanceof Promise ? current.then(readLegacy) : readLegacy(current);
    },
    setItem: (name, value) => resolved.setItem(name, value),
    removeItem: (name) => {
      const removed = resolved.removeItem(name);
      const legacyKey = legacyStorageKey(name);
      if (legacyKey !== null) resolved.removeItem(legacyKey);
      return removed;
    },
  };
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
