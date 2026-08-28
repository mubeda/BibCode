// @effect-diagnostics nodeBuiltinImport:off - This gate inspects checked-in living documentation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

describe("remote architecture contract", () => {
  it("documents the current pairing and fail-closed exposure lifecycle", () => {
    const remote = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "docs/architecture/remote.md"),
      "utf8",
    );

    expect(remote).toContain("browser-session-cookie");
    expect(remote).toContain("persists network-accessible only after");
    expect(remote).toContain("interrupted exchange may consume the one-time token");
    expect(remote).not.toContain("transport loss leaves it retryable");
  });
});
