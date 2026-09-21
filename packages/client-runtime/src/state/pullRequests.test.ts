import { createPullRequestsEnvironmentAtoms } from "@bibcode/client-runtime/state/pull-requests";
import { EnvironmentId } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";

describe("Pull Requests environment atoms", () => {
  it("exports all ten factories through the public subpath and keys reads by environment and input", () => {
    const runtime = Atom.runtime(
      Layer.effect(
        EnvironmentRegistry,
        Effect.die("No RPC should execute while constructing unmounted atoms."),
      ),
    );
    const atoms = createPullRequestsEnvironmentAtoms(runtime);
    expect(Object.keys(atoms).sort()).toEqual([
      "checkout",
      "get",
      "getChecks",
      "getCommits",
      "getContext",
      "getFiles",
      "getTimeline",
      "getVocabulary",
      "list",
      "runAction",
    ]);

    const environmentId = EnvironmentId.make("env-1");
    const context = atoms.getContext({ environmentId, input: { cwd: "/repo" } });
    expect(Atom.isAtom(context)).toBe(true);
    expect(atoms.getContext({ environmentId, input: { cwd: "/repo" } })).toBe(context);
    expect(atoms.getContext({ environmentId, input: { cwd: "/other" } })).not.toBe(context);
    expect(
      atoms.getContext({ environmentId: EnvironmentId.make("env-2"), input: { cwd: "/repo" } }),
    ).not.toBe(context);
  });
});
