export const RETIRED_TERMINAL_DRAWER_STORAGE_KEY = "bibcode:terminal-state:v1";

export function runClientStateMigrationsV1(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(RETIRED_TERMINAL_DRAWER_STORAGE_KEY);
}
