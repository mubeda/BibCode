import * as Schema from "effect/Schema";

import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "../src/previewAutomation.ts";

type Json = Record<string, unknown>;

/**
 * The `preview_*` MCP tools, in `tools/list` order: the input contract and a one-sentence
 * description that says what the tool returns and the rule a schema cannot state (the
 * contract's refinements). The Rust server embeds the generated fixture.
 */
const PREVIEW_TOOLS = [
  [
    "preview_status",
    PreviewAutomationTabTargetInput,
    "Report the preview tab's state: whether it is available and visible, its tabId, URL, title, loading flag and viewport.",
  ],
  [
    "preview_open",
    PreviewAutomationOpenInput,
    "Open the collaborative browser preview, optionally at url, and return its status. tabId cannot be combined with reuseExistingTab false.",
  ],
  [
    "preview_navigate",
    PreviewAutomationNavigateInput,
    "Navigate the preview tab and return its status once it is ready. Give exactly one of url or target; target is {kind:'url', url} or {kind:'environment-port', port, protocol?, path?}.",
  ],
  [
    "preview_resize",
    PreviewAutomationResizeInput,
    "Resize the preview viewport and return the applied setting and measured viewport. fill takes no other field; freeform needs width and height; preset needs preset and may take orientation.",
  ],
  [
    "preview_snapshot",
    PreviewAutomationTabTargetInput,
    "Snapshot the preview tab: visible text, interactive elements with selectors, console and network entries, and a screenshot as image content. Take one before acting.",
  ],
  [
    "preview_click",
    PreviewAutomationClickInput,
    "Click in the preview page. Give exactly one of locator, selector, or the x and y pair.",
  ],
  [
    "preview_type",
    PreviewAutomationTypeInput,
    "Type text into the preview page: into locator or selector (at most one), or into the focused element when neither is given.",
  ],
  [
    "preview_press",
    PreviewAutomationPressInput,
    "Press one keyboard key in the preview page, with optional modifiers held.",
  ],
  [
    "preview_scroll",
    PreviewAutomationScrollInput,
    "Scroll the preview page, or the container at locator or selector (at most one), by deltaX and/or deltaY. Give at least one delta.",
  ],
  [
    "preview_evaluate",
    PreviewAutomationEvaluateInput,
    "Run a JavaScript expression in the preview page and return its value. It runs as the page, in the user's preview; prefer preview_snapshot and the action tools.",
  ],
  [
    "preview_wait_for",
    PreviewAutomationWaitForInput,
    "Wait until every given condition holds: locator or selector (at most one), text, urlIncludes. Give at least one. Use it after an action that changes the page asynchronously.",
  ],
  [
    "preview_recording_start",
    PreviewAutomationTabTargetInput,
    "Start recording the preview tab; returns when the recording began.",
  ],
  [
    "preview_recording_stop",
    PreviewAutomationTabTargetInput,
    "Stop recording the preview tab and return the recording (id, path, mimeType, size).",
  ],
] as const;

const isNullBranch = (branch: unknown) => (branch as Json).type === "null";
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);
const descriptionOf = (node: Json): Json =>
  typeof node.description === "string" ? { description: node.description } : {};

/**
 * Compacts the advertised schema only; decoding keeps the full contract. Drops what an agent
 * cannot use: the null branch of an optional field (JSON `null` decodes to "absent"), the
 * open `additionalProperties`, regex patterns of trimmed strings, and the document wrapper.
 * A tagged union becomes one object: the shared keys, `required` limited to the keys every
 * variant requires, and a key's description only when the variants agree on it.
 */
export function compact(node: Json): Json {
  if (Array.isArray(node.anyOf)) {
    const branches = (node.anyOf as Json[]).filter((branch) => !isNullBranch(branch));
    if (branches.length === 1) return { ...compact(branches[0]!), ...descriptionOf(node) };
    if (branches.every((branch) => branch.type === "object")) {
      return { ...mergeObjects(branches.map(compact)), ...descriptionOf(node) };
    }
    return { ...descriptionOf(node), anyOf: branches.map(compact) };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" || key === "additionalProperties") continue;
    if (key === "allOf") {
      // A refined schema's extra checks: hoist them without overriding the outer description.
      for (const part of value as Json[]) Object.assign(out, compact(part), descriptionOf(node));
    } else if (key === "properties") {
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([name, property]) => [name, compact(property as Json)]),
      );
    } else if (key === "items") {
      out[key] = compact(value as Json);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeObjects(variants: Json[]): Json {
  const properties: Record<string, Json> = {};
  for (const variant of variants) {
    for (const [name, property] of Object.entries(variant.properties as Json)) {
      const next = property as Json;
      const seen = properties[name];
      if (seen === undefined) {
        properties[name] = next;
        continue;
      }
      const values = [...new Set([...stringsOf(seen.enum), ...stringsOf(next.enum)])];
      const { description: _seen, ...merged } = seen;
      properties[name] = {
        ...merged,
        ...(values.length > 0 ? { enum: values } : {}),
        ...(seen.description === next.description ? descriptionOf(seen) : {}),
      };
    }
  }
  const required = stringsOf(variants[0]!.required).filter((name) =>
    variants.every((variant) => stringsOf(variant.required).includes(name)),
  );
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

export type PreviewToolFixture = Record<string, { description: string; inputSchema: Json }>;

/** The compact `inputSchema` and description of every `preview_*` tool, keyed by tool name. */
export function previewToolFixture(): PreviewToolFixture {
  return Object.fromEntries(
    PREVIEW_TOOLS.map(([name, input, description]) => {
      const inputSchema = compact(Schema.toJsonSchemaDocument(input).schema as Json);
      // The tool description says what the struct-level annotation would.
      delete inputSchema.description;
      return [name, { description, inputSchema }];
    }),
  );
}
