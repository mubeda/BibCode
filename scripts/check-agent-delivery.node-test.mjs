import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { checkDelivery } from "./check-agent-delivery.mjs";

const source = "a".repeat(40);
const checkpoint = () => ({
  requirement: "Review the original light and dark screenshots for the selected issue rows",
  source,
  proof: { source, scope: "complete-caller", exitCode: 0 },
  next: {
    scenario: "browser-followups",
    changedBehavior: "Both UI inputs are fingerprinted at the reachable outer boundary",
  },
  runs: [],
  rounds: [],
});

NodeTest.test("admits one changed recipe with matching complete-caller evidence", () => {
  NodeAssert.deepEqual(checkDelivery(checkpoint()), []);
});

NodeTest.test(
  "rejects the past mistake of treating an inner caller pass as complete producer proof",
  () => {
    const input = checkpoint();
    input.proof.scope = "component";
    NodeAssert.deepEqual(checkDelivery(input), ["PROVE_COMPLETE_CALLER"]);
  },
);

NodeTest.test("rejects a proof from another candidate", () => {
  const input = checkpoint();
  input.proof.source = "b".repeat(40);
  NodeAssert.deepEqual(checkDelivery(input), ["VERIFY_CURRENT_SOURCE"]);
});

NodeTest.test("joins the already running scenario instead of dispatching a duplicate", () => {
  const input = checkpoint();
  input.runs.push({ scenario: input.next.scenario, status: "running" });
  NodeAssert.deepEqual(checkDelivery(input), ["JOIN_EXISTING_RUN"]);
});

NodeTest.test("refuses padded scenario names that would bypass the live-run comparison", () => {
  const input = checkpoint();
  input.runs.push({ scenario: input.next.scenario, status: "running" });
  input.next.scenario = " " + input.next.scenario + " ";
  NodeAssert.deepEqual(checkDelivery(input), ["INVALID_CHECKPOINT"]);
});

NodeTest.test("rejects an unchanged recipe after a terminal failure", () => {
  const input = checkpoint();
  input.next.changedBehavior = "";
  input.runs.push({ scenario: input.next.scenario, status: "failed" });
  NodeAssert.deepEqual(checkDelivery(input), ["EXPLAIN_CHANGED_RECIPE"]);
});

NodeTest.test("stops the past test-only progress loop after two rounds without acceptance", () => {
  const input = checkpoint();
  input.rounds.push(
    { accepted: false, result: "unit-tests" },
    { accepted: false, result: "diagnostic-commit" },
  );
  NodeAssert.deepEqual(checkDelivery(input), ["REPLAN_WITH_EVIDENCE"]);
});

NodeTest.test("permits a documented revised diagnosis after stalled rounds", () => {
  const input = checkpoint();
  input.rounds.push({ accepted: false }, { accepted: false });
  input.replan = {
    premise: "Inner tests did not exercise the outer wrapper",
    evidence: "Run the failure census and the actual outer consumer",
  };
  NodeAssert.deepEqual(checkDelivery(input), []);
});

NodeTest.test("never substitutes test work for an explicit closure requirement", () => {
  const input = checkpoint();
  input.requirement = "";
  NodeAssert.deepEqual(checkDelivery(input), ["NAME_CLOSURE_REQUIREMENT"]);
});

NodeTest.test("refuses malformed or failed evidence", () => {
  NodeAssert.deepEqual(checkDelivery(null), ["INVALID_CHECKPOINT"]);
  const input = checkpoint();
  input.proof.exitCode = 1;
  NodeAssert.deepEqual(checkDelivery(input), ["FIX_FAILED_PROOF"]);
});
