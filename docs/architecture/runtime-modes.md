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

## Interaction mode

Runtime mode is separate from interaction mode. `default` versus `plan`
controls how the provider approaches the task; it does not grant additional
permissions. Claude maps plan interaction to its native plan permission mode,
while ACP providers prefer an advertised plan/architect mode. The runtime mode
remains the durable safety setting when the interaction returns to default.
