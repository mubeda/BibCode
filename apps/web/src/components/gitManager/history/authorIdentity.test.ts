import { describe, expect, it } from "vite-plus/test";

import { deriveAuthorIdentity } from "./authorIdentity";
import authorIdentitySource from "./authorIdentity.ts?raw";

describe("deriveAuthorIdentity", () => {
  it("is deterministic and hashes email case-insensitively", () => {
    const first = deriveAuthorIdentity({ name: "Ada Lovelace", email: "Ada@Example.com" });
    const second = deriveAuthorIdentity({ name: "Ada Lovelace", email: "ada@example.com" });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ initials: "AL", title: "Ada Lovelace <ada@example.com>" });
    expect(first.hue).toBeGreaterThanOrEqual(0);
    expect(first.hue).toBeLessThan(360);
  });

  it("falls back to the email local part when the name is blank", () => {
    expect(deriveAuthorIdentity({ name: "  ", email: "grace.hopper@example.test" })).toMatchObject({
      initials: "GH",
      title: "grace.hopper@example.test",
    });
  });

  it("contains no remote identity lookup", () => {
    expect(authorIdentitySource).not.toMatch(/avatars\./i);
    expect(authorIdentitySource).not.toMatch(/gravatar/i);
    expect(authorIdentitySource).not.toMatch(/https?:\/\//i);
    expect(authorIdentitySource).not.toMatch(/fetch\s*\(/i);
  });
});
