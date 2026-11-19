# Autonomous Codex chat review

Status: design for issue 376, written 2026-11-18 and narrowed twice after review. It amends D41
of the [code review button design](2026-11-11-code-review-button-design.md).

## Decision amended

D41 starts every chat review Supervised (`approval-required`). For Codex that sends
`approvalPolicy: untrusted`, which D41 accepted may ask before read commands. On 15 Nov 2026 the
owner asked for the opposite: the review "should be fully autonomous". A Codex chat review now
runs with the policy the Codex AI Terminal reviewer already ships with (`--sandbox read-only
--ask-for-approval never`): `never` with the read-only sandbox. Nothing here claims a boundary
stronger than the terminal reviewer's. Every other reviewer keeps D41.

## The change

1. **The server owns the policy.** `build_launch_request` copies the thread row's `code_review`
   marker into `ProviderLaunchRequest.code_review`. Every launch passes through it: the first turn,
   follow-up turns, the restart after a mode or model change (which clones the stored launch), a
   resume after idle suspension and a reconnect. `CodexDriver::spawn` then starts Codex with the
   internal `CodexRuntimeMode::CodeReview`, whatever mode the thread stores or the turn carries.
   The launch's `runtime_mode` string is untouched, so the projected session, Claude and the other
   drivers see the stored mode. A review switched to another provider follows that mode as today.
2. **Codex wire values.** The three existing modes keep their values. `CodeReview` sends `never`
   with `read-only` on `thread/start` and `thread/resume`, and `never` with `{type: readOnly}` on
   `turn/start`. It is never parsed from a string.
3. **No card for a review.** On a `CodeReview` session, `item/commandExecution/requestApproval`
   and `item/fileChange/requestApproval` get `{"decision": "decline"}` (the reply to a person's
   Decline) at once, and `item/tool/requestUserInput` gets `{"answers": {}}`. BiBCode has no
   cancel reply for a Codex question, so no answers is the closest one. None is recorded as
   pending or published, and the turn goes on.
4. **Capability.** The server advertises `readOnlyCodexReviews`. With it, the Codex chat guard
   line reads "Runs on its own in Codex's read-only sandbox, like the Codex terminal review.";
   without it (an older server) it keeps today's text. The client sends the same runtime mode as
   before, so an older server behaves as before. `codeReviewGuardLine` takes the flag from the
   callers in `ChatView.tsx` and the Code review settings row.
5. **Unknown runtime-mode strings.** The Codex string-to-mode conversion maps an unknown string
   to Supervised with a warning instead of Full access. Cursor and Grok mode selection is
   unchanged.

Checkpoint capture and revert are unchanged.

## What this does not do

- No isolation from the user's Codex configuration, MCP servers, hooks or plugins, which load
  from the Codex home before any thread policy.
- No limit on readable paths, inherited environment, network, CPU or child processes beyond
  what Codex's read-only sandbox gives.
- Claude, Cursor, Grok and OpenCode reviews are unchanged (Claude in plan mode, the others
  Supervised).
- No sandbox in which a review can run scripts or tests that write.
- The review panel's runtime picker still shows the stored mode.

## Alternatives considered

- Full access for reviews: removes the sandbox, rejected.
- Auto-approving cards with `acceptForSession`: may run an approved command outside the sandbox.
- A new review boundary with isolated provider homes: declined in review as too large.
- Refusing provider and mode changes on a review thread: declined in review.
- Skipping checkpoints for reviews: declined in review.

## Requirements of issue 376

| Requirement                     | Status                                             |
| ------------------------------- | -------------------------------------------------- |
| R1, Codex                       | Met: no approval card, `never` on every request.   |
| R3                              | Met: the marker reaches every launch and restart.  |
| R5, guard line and docs         | Met: chat, review menu and Settings pass the flag. |
| R2                              | Met only to the Codex terminal reviewer's level.   |
| R4 beyond today's plan mode; R6 | Not met.                                           |
