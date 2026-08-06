import { expect, it } from "vite-plus/test";

import { runClientStateMigrationsV1 } from "./clientStateMigrations";

function memoryStorage(seed: Record<string, string>): Storage {
  const values = new Map(Object.entries(seed));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

it("removes only the retired drawer key without closing sessions", () => {
  const storage = memoryStorage({
    "bibcode:terminal-state:v1": "legacy",
    "bibcode:center-panel-state:v1": "center",
    "bibcode:right-panel-state:v2": "right",
  });

  runClientStateMigrationsV1(storage);
  runClientStateMigrationsV1(storage);

  expect(storage.getItem("bibcode:terminal-state:v1")).toBeNull();
  expect(storage.getItem("bibcode:center-panel-state:v1")).toBe("center");
  expect(storage.getItem("bibcode:right-panel-state:v2")).toBe("right");
});
