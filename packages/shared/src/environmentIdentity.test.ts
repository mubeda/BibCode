import { describe, expect, it } from "vite-plus/test";

import { readBiBCodeEnvironmentVariable } from "./environmentIdentity.ts";

describe("BiBCode environment identity", () => {
  it("prefers canonical values and falls back to legacy values", () => {
    expect(readBiBCodeEnvironmentVariable({ BIBCODE_PORT: "1", T4CODE_PORT: "2" }, "PORT")).toBe(
      "1",
    );
    expect(readBiBCodeEnvironmentVariable({ T4CODE_PORT: "2" }, "PORT")).toBe("2");
    expect(readBiBCodeEnvironmentVariable({}, "PORT")).toBeUndefined();
  });
});
