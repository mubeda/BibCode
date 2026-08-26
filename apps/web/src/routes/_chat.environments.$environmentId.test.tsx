import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  Route,
  moveEnvironment,
  togglePinnedEnvironment,
} from "./_chat.environments.$environmentId.tsx";

const ENVIRONMENT = EnvironmentId.make("00000000-0000-4000-8000-000000000101");
const OTHER = EnvironmentId.make("00000000-0000-4000-8000-000000000102");

describe("environment workspace route", () => {
  it("validates the stable tab URL so reload preserves a valid selection", () => {
    const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => {
      readonly tab: string;
    };
    expect(validateSearch({ tab: "security" })).toEqual({ tab: "security" });
    expect(validateSearch({ tab: "invalid" })).toEqual({ tab: "overview" });
    expect(validateSearch({})).toEqual({ tab: "overview" });
  });

  it("updates pinning without touching other environment preferences", () => {
    expect(togglePinnedEnvironment([OTHER], ENVIRONMENT)).toEqual([OTHER, ENVIRONMENT]);
    expect(togglePinnedEnvironment([OTHER, ENVIRONMENT], ENVIRONMENT)).toEqual([OTHER]);
  });

  it("moves one environment within the client-local order and clamps at the edges", () => {
    expect(moveEnvironment([ENVIRONMENT, OTHER], ENVIRONMENT, "later")).toEqual([
      OTHER,
      ENVIRONMENT,
    ]);
    expect(moveEnvironment([OTHER, ENVIRONMENT], ENVIRONMENT, "earlier")).toEqual([
      ENVIRONMENT,
      OTHER,
    ]);
    expect(moveEnvironment([ENVIRONMENT, OTHER], ENVIRONMENT, "earlier")).toEqual([
      ENVIRONMENT,
      OTHER,
    ]);
  });
});
