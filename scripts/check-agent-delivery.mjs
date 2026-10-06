import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const scenario = (value) => text(value) && value === value.trim();
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

/** Check a delivery decision before another expensive validation attempt. */
export function checkDelivery(input) {
  if (
    !record(input) ||
    !record(input.proof) ||
    !record(input.next) ||
    !Array.isArray(input.runs) ||
    !Array.isArray(input.rounds) ||
    !input.runs.every(
      (run) =>
        record(run) &&
        scenario(run.scenario) &&
        ["queued", "running", "failed", "complete"].includes(run.status),
    ) ||
    !input.rounds.every((round) => record(round) && typeof round.accepted === "boolean") ||
    !sha(input.source) ||
    !scenario(input.next.scenario)
  )
    return ["INVALID_CHECKPOINT"];
  const errors = [];
  if (!text(input.requirement)) errors.push("NAME_CLOSURE_REQUIREMENT");
  if (input.proof.scope !== "complete-caller") errors.push("PROVE_COMPLETE_CALLER");
  if (input.proof.source !== input.source) errors.push("VERIFY_CURRENT_SOURCE");
  if (input.proof.exitCode !== 0) errors.push("FIX_FAILED_PROOF");
  const same = input.runs.filter((run) => run.scenario === input.next.scenario);
  if (same.some((run) => ["queued", "running"].includes(run.status)))
    errors.push("JOIN_EXISTING_RUN");
  if (same.some((run) => run.status === "failed") && !text(input.next.changedBehavior))
    errors.push("EXPLAIN_CHANGED_RECIPE");
  const stalled =
    input.rounds.length >= 2 && input.rounds.slice(-2).every((round) => !round.accepted);
  if (
    stalled &&
    !(record(input.replan) && text(input.replan.premise) && text(input.replan.evidence))
  )
    errors.push("REPLAN_WITH_EVIDENCE");
  return errors;
}

if (import.meta.main) {
  let errors;
  try {
    const input = JSON.parse(NodeFS.readFileSync(process.argv[2], "utf8"));
    errors = checkDelivery(input);
    const actual = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (input.source !== actual && !errors.includes("VERIFY_CURRENT_SOURCE"))
      errors.push("VERIFY_CURRENT_SOURCE");
  } catch {
    errors = ["INVALID_CHECKPOINT"];
  }
  process.stdout.write(JSON.stringify({ allowed: errors.length === 0, errors }) + "\n");
  process.exitCode = errors.length === 0 ? 0 : 1;
}
