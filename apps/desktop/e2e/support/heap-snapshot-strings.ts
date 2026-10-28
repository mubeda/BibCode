// @effect-diagnostics nodeBuiltinImport:off - A host-side CLI that reads exported heap snapshots.
// @effect-diagnostics globalConsole:off - The host-side CLI prints its report.
/**
 * Counts the long strings a thread-memory run leaves in a heap snapshot, and says what holds the
 * ones a baseline snapshot did not have (#96, #134).
 *
 * Reads a Safari Web Inspector export (JavaScriptCore "Inspector" snapshot: string contents are
 * not recorded, so strings are grouped by size and retaining edge) or a Chromium/WebView2 V8
 * snapshot (contents recorded, so strings are also grouped by their `prompt-<n>-` token).
 *
 *   node apps/desktop/e2e/support/heap-snapshot-strings.ts <after.json> [--baseline <before.json>]
 *     [--min 60000] [--max 60100] [--paths 5]
 */
import * as NodeFS from "node:fs";

export interface LongString {
  /** Stable across snapshots of one page in both engines, so a baseline can be subtracted. */
  readonly id: number;
  readonly index: number;
  readonly bytes: number;
  readonly token: number | null;
}

export interface HeapGraph {
  readonly engine: "jsc" | "v8";
  readonly nodeCount: number;
  readonly longStrings: (minimum: number, maximum: number) => ReadonlyArray<LongString>;
  /** For each node, the label of every edge into it; JSC's export names `Property` edges. */
  readonly retainingNames: (index: number) => ReadonlyArray<string>;
  /** The shortest path from the root, as `<holder> <edge>` steps, or null if unreachable. */
  readonly pathTo: (index: number) => ReadonlyArray<string> | null;
}

const TOKEN = /^prompt-(\d+)-/u;

interface Edge {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly weak: boolean;
}

function buildGraph(
  engine: HeapGraph["engine"],
  nodeCount: number,
  edges: ReadonlyArray<Edge>,
  nodeLabel: (index: number) => string,
  root: number,
  longStrings: HeapGraph["longStrings"],
): HeapGraph {
  const incoming: Array<Array<number>> = Array.from({ length: nodeCount }, () => []);
  const outgoing: Array<Array<number>> = Array.from({ length: nodeCount }, () => []);
  edges.forEach((edge, position) => {
    outgoing[edge.from]!.push(position);
    incoming[edge.to]!.push(position);
  });
  let parents: Int32Array | null = null;
  const parentEdges = (): Int32Array => {
    if (parents !== null) return parents;
    const parentEdge = new Int32Array(nodeCount).fill(-1);
    const seen = new Uint8Array(nodeCount);
    const queue = [root];
    seen[root] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head]!;
      for (const position of outgoing[node]!) {
        const edge = edges[position]!;
        if (edge.weak || seen[edge.to] === 1) continue;
        seen[edge.to] = 1;
        parentEdge[edge.to] = position;
        queue.push(edge.to);
      }
    }
    parents = parentEdge;
    return parentEdge;
  };
  return {
    engine,
    nodeCount,
    longStrings,
    // A string held only through a rope or a substring takes the names of that view's holders.
    retainingNames: (index) =>
      incoming[index]!.flatMap((position) => {
        const edge = edges[position]!;
        const holder = nodeLabel(edge.from);
        return /^(string|concatenated string|sliced string)\b/u.test(holder)
          ? incoming[edge.from]!.map((outer) => edges[outer]!.label)
          : [edge.label];
      }),
    pathTo: (index) => {
      const parentEdge = parentEdges();
      const reached = (node: number) => node === root || parentEdge[node] !== -1;
      // Walk back from the target to the nearest node the root reaches, or to a node nothing
      // points to: JavaScriptCore's export does not always list every GC root under `<root>`.
      const childEdge = new Map<number, number>([[index, -1]]);
      const queue = [index];
      let anchor: number | null = null;
      let globalObject: number | null = null;
      for (let head = 0; head < queue.length && anchor === null; head += 1) {
        const node = queue[head]!;
        if (reached(node) || incoming[node]!.length === 0) {
          anchor = node;
          break;
        }
        if (globalObject === null && /^(global|Window|JSDOMWindow)/u.test(nodeLabel(node))) {
          globalObject = node;
        }
        for (const position of incoming[node]!) {
          const edge = edges[position]!;
          if (edge.weak || childEdge.has(edge.from)) continue;
          childEdge.set(edge.from, position);
          queue.push(edge.from);
        }
      }
      // Unlisted roots in cycles: start from the global object when the walk met one.
      anchor ??= globalObject;
      if (anchor === null) return null;
      const steps: Array<string> = [];
      for (let node = anchor; node !== root && parentEdge[node] !== -1 && steps.length < 80;) {
        const edge = edges[parentEdge[node]!]!;
        steps.push(`${nodeLabel(edge.from)} ${edge.label}`);
        node = edge.from;
      }
      steps.reverse();
      if (!reached(anchor)) steps.push(`(unlisted root)`);
      // Forward from the anchor to the target: each recorded edge leaves its key toward it.
      for (let node = anchor; node !== index;) {
        const edge = edges[childEdge.get(node)!]!;
        steps.push(`${nodeLabel(edge.from)} ${edge.label}`);
        node = edge.to;
      }
      return steps;
    },
  };
}

interface JscSnapshot {
  readonly nodes: ReadonlyArray<number>;
  readonly nodeClassNames: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<number>;
  readonly edgeTypes: ReadonlyArray<string>;
  readonly edgeNames: ReadonlyArray<string>;
}

interface V8Snapshot {
  readonly snapshot: {
    readonly meta: {
      readonly node_fields: ReadonlyArray<string>;
      readonly node_types: readonly [ReadonlyArray<string>, ...unknown[]];
      readonly edge_fields: ReadonlyArray<string>;
      readonly edge_types: readonly [ReadonlyArray<string>, ...unknown[]];
    };
  };
  readonly nodes: ReadonlyArray<number>;
  readonly edges: ReadonlyArray<number>;
  readonly strings: ReadonlyArray<string>;
}

/** JSC: nodes are `[id, size, classNameIndex, flags]`, edges `[fromId, toId, typeIndex, data]`. */
function parseJsc(snapshot: JscSnapshot): HeapGraph {
  const nodeCount = snapshot.nodes.length / 4;
  const indexById = new Map<number, number>();
  for (let index = 0; index < nodeCount; index += 1) {
    indexById.set(snapshot.nodes[index * 4]!, index);
  }
  const className = (index: number) => snapshot.nodeClassNames[snapshot.nodes[index * 4 + 2]!]!;
  const edges: Array<Edge> = [];
  for (let offset = 0; offset < snapshot.edges.length; offset += 4) {
    const from = indexById.get(snapshot.edges[offset]!);
    const to = indexById.get(snapshot.edges[offset + 1]!);
    if (from === undefined || to === undefined) continue;
    const type = snapshot.edgeTypes[snapshot.edges[offset + 2]!];
    const data = snapshot.edges[offset + 3]!;
    const label =
      type === "Index"
        ? `[${data}]`
        : type === "Property" || type === "Variable"
          ? `.${snapshot.edgeNames[data] ?? "?"}`
          : "(internal)";
    edges.push({ from, to, label, weak: false });
  }
  const root = indexById.get(0) ?? 0;
  return buildGraph(
    "jsc",
    nodeCount,
    edges,
    (index) => className(index),
    root,
    (minimum, maximum) => {
      const found: Array<LongString> = [];
      for (let index = 0; index < nodeCount; index += 1) {
        const bytes = snapshot.nodes[index * 4 + 1]!;
        if (className(index) !== "string" || bytes < minimum || bytes > maximum) continue;
        found.push({ id: snapshot.nodes[index * 4]!, index, bytes, token: null });
      }
      return found;
    },
  );
}

function parseV8(snapshot: V8Snapshot): HeapGraph {
  const meta = snapshot.snapshot.meta;
  const width = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const field = (name: string) => meta.node_fields.indexOf(name);
  const [typeField, nameField, idField, sizeField, edgeCountField] = [
    field("type"),
    field("name"),
    field("id"),
    field("self_size"),
    field("edge_count"),
  ];
  const nodeTypes = meta.node_types[0];
  const edgeTypes = meta.edge_types[0];
  const edgeType = meta.edge_fields.indexOf("type");
  const edgeName = meta.edge_fields.indexOf("name_or_index");
  const edgeTo = meta.edge_fields.indexOf("to_node");
  const nodeCount = snapshot.nodes.length / width;
  const nodeKind = (index: number) => nodeTypes[snapshot.nodes[index * width + typeField]!]!;
  const nodeName = (index: number) => snapshot.strings[snapshot.nodes[index * width + nameField]!]!;
  const edges: Array<Edge> = [];
  let offset = 0;
  for (let from = 0; from < nodeCount; from += 1) {
    const count = snapshot.nodes[from * width + edgeCountField]!;
    for (let edge = 0; edge < count; edge += 1, offset += edgeWidth) {
      const type = edgeTypes[snapshot.edges[offset + edgeType]!]!;
      const value = snapshot.edges[offset + edgeName]!;
      const label =
        type === "element" || type === "hidden" ? `[${value}]` : `.${snapshot.strings[value]}`;
      edges.push({
        from,
        to: snapshot.edges[offset + edgeTo]! / width,
        label,
        weak: type === "weak" || type === "shortcut",
      });
    }
  }
  return buildGraph(
    "v8",
    nodeCount,
    edges,
    (index) => `${nodeKind(index)}:${nodeName(index).slice(0, 40).replace(/\s+/gu, " ")}`,
    0,
    (minimum, maximum) => {
      const found: Array<LongString> = [];
      for (let index = 0; index < nodeCount; index += 1) {
        const bytes = snapshot.nodes[index * width + sizeField]!;
        if (nodeKind(index) !== "string" || bytes < minimum || bytes > maximum) continue;
        const match = TOKEN.exec(nodeName(index));
        found.push({
          id: snapshot.nodes[index * width + idField]!,
          index,
          bytes,
          token: match === null ? null : Number(match[1]),
        });
      }
      return found;
    },
  );
}

export function parseHeapSnapshot(value: unknown): HeapGraph {
  const record = value as Record<string, unknown>;
  // A Web Inspector export may wrap the snapshot.
  const snapshot = (
    typeof record.snapshot === "object" && record.snapshot !== null && "nodes" in record.snapshot
      ? record.snapshot
      : record
  ) as Record<string, unknown>;
  if (Array.isArray(snapshot.nodeClassNames)) return parseJsc(snapshot as unknown as JscSnapshot);
  if (typeof snapshot.snapshot === "object" && Array.isArray(snapshot.strings)) {
    return parseV8(snapshot as unknown as V8Snapshot);
  }
  throw new Error("Not a JavaScriptCore Inspector or V8 heap snapshot.");
}

export interface LongStringReport {
  readonly count: number;
  readonly megabytes: number;
  readonly perToken: number | null;
  readonly byRetainingName: ReadonlyArray<readonly [string, number]>;
}

export function reportLongStrings(
  graph: HeapGraph,
  strings: ReadonlyArray<LongString>,
): LongStringReport {
  const byName = new Map<string, number>();
  for (const entry of strings) {
    // The named edges into the string; JSC records many holders' edges as internal.
    const names = new Set(
      graph.retainingNames(entry.index).filter((name) => name !== "(internal)"),
    );
    for (const name of names.size === 0 ? ["(internal only)"] : names) {
      byName.set(name, (byName.get(name) ?? 0) + 1);
    }
  }
  // Copies per token count only the strings that carry a token, not others of the same size.
  const tokened = strings.flatMap((entry) => (entry.token === null ? [] : [entry.token]));
  const tokens = new Set(tokened);
  return {
    count: strings.length,
    megabytes: strings.reduce((sum, entry) => sum + entry.bytes, 0) / 1e6,
    perToken: tokens.size === 0 ? null : tokened.length / tokens.size,
    byRetainingName: [...byName].sort((a, b) => b[1] - a[1]),
  };
}

/** Groups the shortest retaining paths of `strings` by their last steps, largest group first. */
export function groupRetainingPaths(
  graph: HeapGraph,
  strings: ReadonlyArray<LongString>,
  limit: number,
): ReadonlyArray<{ readonly count: number; readonly example: ReadonlyArray<string> }> {
  const groups = new Map<string, { count: number; example: ReadonlyArray<string> }>();
  for (const entry of strings) {
    const steps = graph.pathTo(entry.index) ?? ["(unreachable)"];
    const key = steps
      .slice(-8)
      .join(" -> ")
      .replace(/\[\d+\]/gu, "[]");
    const group = groups.get(key) ?? { count: 0, example: steps };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function main(argv: ReadonlyArray<string>): void {
  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const file = argv[0];
  if (file === undefined || file.startsWith("--")) {
    throw new Error("Usage: heap-snapshot-strings.ts <snapshot> [--baseline <snapshot>]");
  }
  const minimum = Number(option("--min") ?? 60_000);
  const maximum = Number(option("--max") ?? 60_100);
  const load = (path: string) => parseHeapSnapshot(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  const describe = (label: string, graph: HeapGraph, strings: ReadonlyArray<LongString>) => {
    const report = reportLongStrings(graph, strings);
    console.log(
      `${label} (${graph.engine}): ${report.count} strings of ${minimum}-${maximum} bytes, ${report.megabytes.toFixed(2)} MB` +
        (report.perToken === null ? "" : `, ${report.perToken.toFixed(2)} per prompt token`),
    );
    for (const [name, count] of report.byRetainingName.slice(0, 8)) {
      console.log(`  held by ${name}: ${count}`);
    }
  };
  const graph = load(file);
  let strings = graph.longStrings(minimum, maximum);
  describe("snapshot", graph, strings);
  if (graph.engine === "jsc") {
    // WebKit reports a string whose buffer it shares (with DOM text, say) at its size divided by
    // the number of owners, so a shared prompt can show at about half its size.
    const half = graph.longStrings(Math.floor(minimum / 2), Math.ceil(maximum / 2));
    console.log(
      `  also ${half.length} strings of ${Math.floor(minimum / 2)}-${Math.ceil(maximum / 2)} bytes (shared buffers can report half their size)`,
    );
  }
  const baselineFile = option("--baseline");
  if (baselineFile !== undefined) {
    const baseline = load(baselineFile);
    const before = baseline.longStrings(minimum, maximum);
    describe("baseline", baseline, before);
    const old = new Set(before.map((entry) => entry.id));
    strings = strings.filter((entry) => !old.has(entry.id));
    describe("added since baseline", graph, strings);
  }
  for (const group of groupRetainingPaths(graph, strings, Number(option("--paths") ?? 5))) {
    console.log(`\n${group.count} strings, e.g.:`);
    for (const step of group.example) console.log(`  ${step}`);
  }
}

if (import.meta.main) main(process.argv.slice(2));
