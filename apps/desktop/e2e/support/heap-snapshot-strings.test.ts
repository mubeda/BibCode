import { describe, expect, it } from "vite-plus/test";

import {
  groupRetainingPaths,
  parseHeapSnapshot,
  reportLongStrings,
} from "./heap-snapshot-strings.ts";

// The shape `generateHeapSnapshot()` and a Safari Web Inspector export produce: nodes are
// [id, size, classNameIndex, flags]; edges [fromId, toId, typeIndex, nameOrIndex].
function jscSnapshot(extraCopy: boolean) {
  const nodes = [
    [0, 0, 0, 0], // <root>
    [10, 64, 1, 0], // global object
    [11, 32, 2, 0], // messages array
    [12, 48, 3, 0], // message
    [13, 60_007, 4, 0], // its text
    [14, 48, 3, 0], // a superseded message
    [15, 60_007, 4, 0], // its text
    [16, 20, 4, 0], // a short string
  ].filter(([id]) => extraCopy || (id !== 14 && id !== 15));
  const edges = [
    [0, 10, 0, 0],
    [10, 11, 3, 1], // global.messages (variable)
    [11, 12, 2, 0], // messages[0]
    [12, 13, 1, 2], // message.text
    [12, 16, 1, 3], // message.role
    ...(extraCopy
      ? [
          [10, 14, 1, 4], // global.previous
          [14, 15, 1, 2],
        ]
      : []),
  ];
  return {
    version: 3,
    type: "Inspector",
    nodes: nodes.flat(),
    nodeClassNames: ["<root>", "Window", "Array", "Object", "string"],
    edges: edges.flat(),
    edgeTypes: ["Internal", "Property", "Index", "Variable"],
    edgeNames: ["constructor", "messages", "text", "role", "previous"],
  };
}

describe("heap snapshot long strings", () => {
  it("counts JavaScriptCore strings by size and names what holds the added ones", () => {
    const baseline = parseHeapSnapshot(jscSnapshot(false));
    const after = parseHeapSnapshot({ snapshot: jscSnapshot(true) });
    expect(after.engine).toBe("jsc");

    const before = baseline.longStrings(60_000, 60_100);
    const strings = after.longStrings(60_000, 60_100);
    expect(before.map((entry) => entry.id)).toEqual([13]);
    expect(strings.map((entry) => entry.id)).toEqual([13, 15]);
    expect(reportLongStrings(after, strings)).toMatchObject({
      count: 2,
      perToken: null,
      byRetainingName: [[".text", 2]],
    });

    const old = new Set(before.map((entry) => entry.id));
    const added = strings.filter((entry) => !old.has(entry.id));
    expect(groupRetainingPaths(after, added, 5)).toEqual([
      { count: 1, example: ["<root> (internal)", "Window .previous", "Object .text"] },
    ]);
  });

  it("groups V8 strings by their prompt token", () => {
    const meta = {
      node_fields: ["type", "name", "id", "self_size", "edge_count"],
      node_types: [["synthetic", "object", "string"]],
      edge_fields: ["type", "name_or_index", "to_node"],
      edge_types: [["property", "element", "weak"]],
    };
    const strings = [
      "",
      "Window",
      "prompt-7-aaaa",
      "prompt-7-bbbb",
      "text",
      "held",
      "bundled source",
    ];
    // root -> Window; Window.text -> copy A; Window.held -> copy B, weakly
    const nodes = [
      [0, 0, 1, 0, 1],
      [1, 1, 2, 40, 2],
      [2, 2, 3, 60_016, 0],
      [2, 3, 4, 60_016, 0],
      // A string of the same size without a token: counted, but not as a prompt copy.
      [2, 6, 5, 60_016, 0],
    ];
    const edges = [
      [0, 1, 5],
      [0, 4, 10],
      [2, 5, 15],
    ];
    const graph = parseHeapSnapshot({
      snapshot: { meta },
      nodes: nodes.flat(),
      edges: edges.flat(),
      strings,
    });
    const found = graph.longStrings(60_000, 60_100);
    expect(found.map((entry) => entry.token)).toEqual([7, 7, null]);
    expect(reportLongStrings(graph, found)).toMatchObject({ count: 3, perToken: 2 });
    expect(graph.pathTo(found[0]!.index)).toEqual(["synthetic: .Window", "object:Window .text"]);
    // Only a weak edge reaches the second copy: nothing holds it.
    expect(graph.pathTo(found[1]!.index)).toBeNull();
  });

  it("rejects other JSON", () => {
    expect(() => parseHeapSnapshot({ nodes: [] })).toThrow(/heap snapshot/u);
  });
});
