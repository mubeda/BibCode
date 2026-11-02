import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

export const PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY = "bibcode:provider-update-dismissals:v1";

const ProviderUpdateDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type ProviderUpdateDismissals = typeof ProviderUpdateDismissalsSchema.Type;

function readProviderUpdateDismissals(): ProviderUpdateDismissals {
  try {
    return (
      getLocalStorageItem(
        PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
        ProviderUpdateDismissalsSchema,
      ) ?? {
        keys: [],
      }
    );
  } catch (error) {
    console.error("Could not read provider-update dismissals.", error);
    return { keys: [] };
  }
}

function writeProviderUpdateDismissals(document: ProviderUpdateDismissals): void {
  try {
    setLocalStorageItem(
      PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
      document,
      ProviderUpdateDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist provider-update dismissals.", error);
  }
}

export function isProviderUpdateNotificationDismissed(
  dismissalKey: string | null | undefined,
): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readProviderUpdateDismissals().keys.includes(dismissalKey);
}

export function dismissProviderUpdateNotification(dismissalKey: string | null | undefined): void {
  const trimmedKey = dismissalKey?.trim();
  if (!trimmedKey) {
    return;
  }
  const document = readProviderUpdateDismissals();
  if (document.keys.includes(trimmedKey)) {
    return;
  }
  writeProviderUpdateDismissals({
    keys: [...document.keys, trimmedKey],
  });
}

export function useDismissedProviderUpdateNotificationKeys() {
  const [dismissals, setDismissals] = useLocalStorage(
    PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    ProviderUpdateDismissalsSchema,
  );
  const dismissedKeys = dismissals.keys;

  const dismissedKeySet = useMemo(() => new Set(dismissedKeys), [dismissedKeys]);

  // Merged into what is stored now, not into the list this render captured, so two dismissals
  // issued together (two environments announcing in one effect) both survive.
  const dismissNotificationKey = useCallback(
    (key: string) => {
      const trimmedKey = key.trim();
      if (trimmedKey.length === 0) {
        return;
      }
      setDismissals((current) =>
        current.keys.includes(trimmedKey) ? current : { keys: [...current.keys, trimmedKey] },
      );
    },
    [setDismissals],
  );

  return {
    dismissedNotificationKeys: dismissedKeySet,
    dismissNotificationKey,
  };
}
