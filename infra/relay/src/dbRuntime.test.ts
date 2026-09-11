import { describe, expect, it } from "@effect/vitest";

describe("relay Drizzle Effect runtime", () => {
  it("loads the retained Drizzle Effect Postgres adapter", async () => {
    const adapter = await import("drizzle-orm/effect-postgres");

    expect(adapter.makeWithDefaults).toBeTypeOf("function");
  });

  it("loads the Alchemy Postgres boundary without evaluating a deployment", async () => {
    const adapter = await import("alchemy/Drizzle/Postgres");

    expect(adapter.Postgres).toBeTypeOf("function");
  });
});
