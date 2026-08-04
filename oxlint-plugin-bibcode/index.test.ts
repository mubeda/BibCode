import { assert, describe, it } from "@effect/vitest";

import plugin from "./index.ts";
import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";

describe("bibcode plugin", () => {
  it("exports the named plugin and every owned rule", () => {
    assert.equal(plugin.meta?.name, "bibcode");
    assert.deepEqual(plugin.rules, {
      "namespace-node-imports": namespaceNodeImports,
      "no-global-process-runtime": noGlobalProcessRuntime,
      "no-inline-schema-compile": noInlineSchemaCompile,
      "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    });
  });
});
