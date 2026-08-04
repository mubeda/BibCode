import { describe, expect, it } from "vite-plus/test";

import { readBiBCodeEnvironmentVariable } from "./environmentIdentity.ts";

describe("BiBCode environment identity", () => {
  it("reads BiBCode values", () => {
    expect(readBiBCodeEnvironmentVariable({ BIBCODE_PORT: "1" }, "PORT")).toBe("1");
    expect(readBiBCodeEnvironmentVariable({}, "PORT")).toBeUndefined();
  });
});
