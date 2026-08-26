import { describe, expect, it } from "@effect/vitest";

import { canonicalJson } from "./canonicalJson.ts";

describe("canonicalJson", () => {
  it("sorts nested object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 2, a: 1 }, 4] })).toBe(
      '{"a":{"x":3,"y":2},"list":[{"a":1,"b":2},4],"z":1}',
    );
  });

  it("omits undefined object fields and matches JSON array semantics", () => {
    expect(canonicalJson({ kept: true, omitted: undefined })).toBe('{"kept":true}');
    expect(canonicalJson([1, undefined, null])).toBe("[1,null,null]");
  });
});
