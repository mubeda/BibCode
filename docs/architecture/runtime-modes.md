# Runtime modes

Runtime mode is a per-thread safety policy. The canonical values are defined by
`RuntimeMode` in
[`packages/contracts/src/orchestration.ts`](../../packages/contracts/src/orchestration.ts).

| UI label          | Wire value          | Intended behavior                                                                                |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| Supervised        | `approval-required` | Ask before commands and file changes.                                                            |
| Auto-accept edits | `auto-accept-edits` | Approve edits automatically and ask before other actions when the provider can distinguish them. |
| Full access       | `full-access`       | Allow commands and edits without approval prompts.                                               |

`full-access` is the default for newly decoded thread settings. The selected
mode is persisted in orchestration state and sent to the provider runtime when
a session starts or the thread mode changes.

## Provider mappings

Provider capabilities differ, so the common policy is translated at the driver
boundary.

| Provider | `approval-required`                                               | `auto-accept-edits`                                                                             | `full-access`                                                                                          |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex    | `approvalPolicy: untrusted`, `sandboxPolicy: readOnly`            | `approvalPolicy: on-request`, `sandboxPolicy: workspaceWrite`                                   | `approvalPolicy: never`, `sandboxPolicy: dangerFullAccess`                                             |
| Claude   | `permissionMode: default`                                         | `permissionMode: acceptEdits`                                                                   | `permissionMode: bypassPermissions` with the dangerous-skip flag enabled                               |
| Cursor   | Prefers the provider's ask mode and surfaces permission requests. | Uses the provider's implementation mode; provider permission requests still require a response. | Uses implementation mode and automatically selects an advertised allow option for permission requests. |
| OpenCode | Emits `ask` rules for modeled tool permissions.                   | Currently uses the same `ask` rules as supervised mode.                                         | Emits an allow-all permission rule.                                                                    |

The Codex mapping is implemented in
[`build_turn_start_params`](../../apps/server/src/provider/codex/model.rs), the
Claude mapping in
[`RuntimeMode::permission_mode`](../../apps/server/src/provider/claude/runtime.rs),
Cursor mode selection in
[`acp_mode.rs`](../../apps/server/src/provider/acp_mode.rs), and OpenCode rules
in
[`build_permission_rules`](../../apps/server/src/provider/opencode/runtime.rs).

A Codex runtime-mode string other than the three above starts Codex in
Supervised and logs a warning. It never becomes Full access.

### Codex code reviews

A thread created as a code review panel (`code_review` on the thread row, set by
`worktree.createPanel` with `codeReview: true`) runs Codex with
`approvalPolicy: never` and the read-only sandbox (`sandbox: read-only` on
`thread/start` and `thread/resume`, `sandboxPolicy: readOnly` on every
`turn/start`), whatever runtime mode the thread stores or a turn carries. This
is the policy the Codex AI Terminal reviewer starts with (`--sandbox read-only
--ask-for-approval never`). The server owns it: `build_launch_request` copies the
marker into `ProviderLaunchRequest.code_review`, so the first turn, follow-up
turns, a restart after a mode or model change, a resume and a reconnect all
carry it. The internal `CodexRuntimeMode::CodeReview` is never read from a
string, and the thread's stored runtime mode is unchanged, so the composer's
picker still shows it (Supervised for a review the client started).

If Codex still sends a command approval, a file-change approval or a question on
such a session, BiBCode answers at once (`decision: decline`, or no answers) and
records nothing pending, so no card opens and the turn goes on. The server
advertises this with the `readOnlyCodexReviews` capability. A review panel
switched to another provider follows the stored mode as before. Non-Codex chat
reviews (Claude, Cursor, OpenCode, and Antigravity) start with `runtimeMode:
"full-access"`, `interactionMode: "default"`, and `codeReview: true`; while
those auto-mode settings stay active, each server driver runs its native
non-prompting mode and auto-declines or cancels stray permission and
interactive-question callbacks (with Cursor auto-approving permissions that
offer an allow option and cancelling reject-only/empty permissions and all
questions). Switching a non-Codex review to `approval-required` (or `plan` on
providers that support Plan mode) disables code-review auto-decline; on OpenCode
V1, BiBCode warns that upstream V1 rules remain bound at session creation until
a fresh session starts.

## Interaction mode

Runtime mode is separate from interaction mode. `default` versus `plan`
controls how the provider approaches the task; it does not grant additional
permissions. Claude maps plan interaction to its native plan permission mode,
while ACP providers prefer an advertised plan/architect mode. The runtime mode
remains the durable safety setting when the interaction returns to default.
