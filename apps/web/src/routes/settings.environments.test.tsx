import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toEnvironmentSettingsRows } from "./settings.environments";

const VISIBLE = EnvironmentId.make("00000000-0000-4000-8000-000000000401");
const HIDDEN = EnvironmentId.make("00000000-0000-4000-8000-000000000402");

describe("environment settings list", () => {
  it("lists known before hidden and preserves the canonical label beside a client alias", () => {
    expect(
      toEnvironmentSettingsRows([
        {
          environmentId: HIDDEN,
          alias: null,
          hidden: true,
          descriptor: { label: "Hidden host" },
        },
        {
          environmentId: VISIBLE,
          alias: "Build box",
          hidden: false,
          descriptor: { label: "build.example.test" },
        },
      ]),
    ).toEqual([
      {
        environmentId: VISIBLE,
        label: "Build box",
        canonicalLabel: "build.example.test",
        hidden: false,
      },
      {
        environmentId: HIDDEN,
        label: "Hidden host",
        canonicalLabel: "Hidden host",
        hidden: true,
      },
    ]);
  });
});
