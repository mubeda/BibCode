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

it("removes only the retired drawer and sidebar-width keys without closing sessions", () => {
  const storage = memoryStorage({
    "bibcode:terminal-state:v1": "legacy",
    chat_thread_sidebar_width: "613",
    "bibcode:sidebar-width:v2": "300",
    "bibcode:center-panel-state:v1": "center",
    "bibcode:right-panel-state:v2": "right",
  });

  runClientStateMigrationsV1(storage);
  runClientStateMigrationsV1(storage);

  expect(storage.getItem("bibcode:terminal-state:v1")).toBeNull();
  expect(storage.getItem("chat_thread_sidebar_width")).toBeNull();
  expect(storage.getItem("bibcode:sidebar-width:v2")).toBe("300");
  expect(storage.getItem("bibcode:center-panel-state:v1")).toBe("center");
  expect(storage.getItem("bibcode:right-panel-state:v2")).toBe("right");
});
