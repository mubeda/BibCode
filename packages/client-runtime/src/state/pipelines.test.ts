import {
  createPipelinesEnvironmentAtoms,
  createTimerReadMarker,
} from "@bibcode/client-runtime/state/pipelines";
import { EnvironmentId, type PipelinesListInput } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import { EnvironmentRegistry } from "../connection/registry.ts";

const listInput: PipelinesListInput = {
  cwd: "/repo",
  scope: "all",
  ref: null,
  workflowId: null,
  cursor: null,
  refresh: "user",
};

describe("Pipelines environment atoms", () => {
  it("exports every read through the public subpath and keys reads by environment and input", () => {
    const runtime = Atom.runtime(
      Layer.effect(
        EnvironmentRegistry,
        Effect.die("No RPC should execute while constructing unmounted atoms."),
      ),
    );
    const atoms = createPipelinesEnvironmentAtoms(runtime);
    // No `runAction` until the server advertises `pipelinesMutations`.
    expect(Object.keys(atoms).sort()).toEqual([
      "get",
      "getJob",
      "getJobLog",
      "list",
      "readSnapshot",
      "requestTimerRead",
      "subscribe",
    ]);
    const environmentId = EnvironmentId.make("env-1");
    const list = atoms.list({ environmentId, input: listInput });
    expect(Atom.isAtom(list)).toBe(true);
    expect(atoms.list({ environmentId, input: { ...listInput } })).toBe(list);
    expect(atoms.list({ environmentId, input: { ...listInput, scope: "running" } })).not.toBe(list);
    // Marking a timer read keeps the same cache entry, so the screen keeps its value.
    atoms.requestTimerRead({ environmentId, input: listInput });
    expect(atoms.list({ environmentId, input: listInput })).toBe(list);
  });

  it("reads a log window as a one-shot command, so no atom keeps a copy of the text", () => {
    const runtime = Atom.runtime(
      Layer.effect(EnvironmentRegistry, Effect.die("No RPC should execute in this test.")),
    );
    const { getJobLog } = createPipelinesEnvironmentAtoms(runtime);
    expect(Atom.isAtom(getJobLog)).toBe(false);
    expect(getJobLog.label).toBe("environment-data:pipelines:get-job-log");
    expect(typeof getJobLog.run).toBe("function");
  });

  it.effect("sends one marked execution as a timer read, for that environment and input only", () =>
    Effect.gen(function* () {
      const marker = createTimerReadMarker();
      const environmentId = EnvironmentId.make("env-1");
      const sent: PipelinesListInput[] = [];
      const send = (input: PipelinesListInput) => Effect.sync(() => void sent.push(input));

      yield* marker.run(environmentId, listInput, send);
      marker.request({ environmentId, input: listInput });
      yield* marker.run(EnvironmentId.make("env-2"), listInput, send);
      yield* marker.run(environmentId, { ...listInput, ref: "main" }, send);
      yield* marker.run(environmentId, listInput, send);
      yield* marker.run(environmentId, listInput, send);

      expect(sent.map((input) => [input.ref, input.refresh])).toEqual([
        [null, "user"],
        [null, "user"],
        ["main", "user"],
        [null, "timer"],
        [null, "user"],
      ]);
    }),
  );
});
