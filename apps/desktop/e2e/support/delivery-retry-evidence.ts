// @effect-diagnostics nodeBuiltinImport:off - Owned private fixture receipts and workspace stimulus.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const deliveryThemes = ["light", "dark"] as const;
export type DeliveryTheme = (typeof deliveryThemes)[number];
export const deliveryScenes = ["uncertain", "retry-cancelled", "new-conversation"] as const;
export type DeliveryScene = (typeof deliveryScenes)[number];
export const newConversationNotice =
  "Sent in a new conversation. The agent won't remember earlier messages in this thread.";
export const retryPrompt =
  "Retry this message?\nClaude may receive a duplicate if it received the original message.\nOnly retry if sending the message twice is safe.";

type Launch = { kind: "launch"; sessionId: string; fresh: boolean; resumed: boolean };
type Input = { kind: "input"; sessionId: string; prompt: string; withheld: boolean };
export type DeliveryReceipt = Launch | Input;
export interface DeliveryReceipts {
  complete: boolean;
  entries: DeliveryReceipt[];
}
const refused = () => new Error("Owned delivery receipt refused.");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw refused();
};

/** Only complete rows are observed; a pending append cannot certify a pass. */
export function parseDeliveryReceipts(text: string): DeliveryReceipts {
  if (Buffer.byteLength(text) > 65536) throw refused();
  const end = text.lastIndexOf("\n");
  const complete = text === "" || end === text.length - 1;
  if (text.length - end - 1 > 8192) throw refused();
  const lines = end < 0 ? [] : text.slice(0, end).split("\n");
  if (lines.length > 64) throw refused();
  const entries = lines.map((line): DeliveryReceipt => {
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      throw refused();
    }
    if (typeof row.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(row.sessionId))
      throw refused();
    if (row.kind === "launch") {
      exact(row, ["kind", "sessionId", "fresh", "resumed"]);
      if (
        typeof row.fresh !== "boolean" ||
        typeof row.resumed !== "boolean" ||
        (row.fresh && row.resumed)
      )
        throw refused();
      return { kind: "launch", sessionId: row.sessionId, fresh: row.fresh, resumed: row.resumed };
    }
    if (row.kind === "input") {
      exact(row, ["kind", "sessionId", "prompt", "withheld"]);
      if (
        typeof row.prompt !== "string" ||
        row.prompt.length > 4096 ||
        typeof row.withheld !== "boolean"
      )
        throw refused();
      return {
        kind: "input",
        sessionId: row.sessionId,
        prompt: row.prompt,
        withheld: row.withheld,
      };
    }
    throw refused();
  });
  return { complete, entries };
}

export function readDeliveryReceipts(control: string): DeliveryReceipts {
  const target = NodePath.join(control, "receipts.jsonl");
  try {
    const metadata = NodeFS.lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw refused();
    return parseDeliveryReceipts(NodeFS.readFileSync(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete: false, entries: [] };
    throw refused();
  }
}

export function verifyFreshRetry(
  before: DeliveryReceipts,
  after: DeliveryReceipts,
  prompt: string,
) {
  if (!before.complete || !after.complete || after.entries.length !== before.entries.length + 2)
    throw refused();
  if (
    JSON.stringify(after.entries.slice(0, before.entries.length)) !== JSON.stringify(before.entries)
  )
    throw refused();
  const withheld = before.entries.filter(
    (entry): entry is Input => entry.kind === "input" && entry.prompt === prompt,
  );
  const [launch, accepted] = after.entries.slice(before.entries.length);
  if (
    withheld.length !== 1 ||
    withheld[0]!.withheld !== true ||
    launch?.kind !== "launch" ||
    accepted?.kind !== "input" ||
    !launch.fresh ||
    launch.resumed ||
    accepted.withheld ||
    accepted.prompt !== prompt ||
    accepted.sessionId !== launch.sessionId ||
    launch.sessionId === withheld[0]!.sessionId
  )
    throw refused();
  return { freshLaunches: 1, acceptedInputs: 1, newSession: true, noResume: true } as const;
}

/** Same-parent rename inside this canonical private root; restore before cleanup can delete it. */
export async function withUnavailableWorkspace<A>(
  root: string,
  project: string,
  run: () => Promise<A>,
): Promise<A> {
  const canonicalRoot = NodeFS.realpathSync(root);
  const canonicalProject = NodeFS.realpathSync(project);
  const relative = NodePath.relative(canonicalRoot, canonicalProject);
  if (
    !relative ||
    relative.startsWith("..") ||
    NodePath.isAbsolute(relative) ||
    !NodeFS.statSync(canonicalProject).isDirectory()
  )
    throw new Error("Owned workspace stimulus refused.");
  const held = canonicalProject + ".delivery-missing";
  if (NodeFS.existsSync(held)) throw new Error("Owned workspace holding path already exists.");
  NodeFS.renameSync(canonicalProject, held);
  let outcome: { ok: true; value: A } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (NodeFS.existsSync(canonicalProject))
    throw new Error("Owned workspace restore target changed.");
  NodeFS.renameSync(held, canonicalProject);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
