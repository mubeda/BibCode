import * as Schema from "effect/Schema";

/**
 * Connect an agent (#139): BiBCode adds its stdio relay to Claude Code, Codex, Cursor or
 * OpenCode on the server's own host: through `claude` and `codex`'s own `mcp add`, `get` and
 * `remove`, and by editing only the `bibcode` entry of Cursor's `~/.cursor/mcp.json` and
 * OpenCode's `opencode.json`. Read with `access:read`, changed with `access:write`, which an
 * outside agent's MCP session never holds.
 */

export const McpClientId = Schema.Literals(["claude", "codex", "cursor", "opencode"]);
export type McpClientId = typeof McpClientId.Type;

/** One tool on the server's host: whether its CLI was found and whether `bibcode` is added. */
export const McpClientRegistration = Schema.Struct({
  client: McpClientId,
  installed: Schema.Boolean,
  registered: Schema.Boolean,
  /** Why the tool's configuration could not be read; `registered` is then unknown. */
  error: Schema.NullOr(Schema.String),
});
export type McpClientRegistration = typeof McpClientRegistration.Type;

export const McpClientsGetRegistrationsInput = Schema.Struct({});
export const McpClientsGetRegistrationsResult = Schema.Struct({
  clients: Schema.Array(McpClientRegistration),
});
export type McpClientsGetRegistrationsResult = typeof McpClientsGetRegistrationsResult.Type;

export const McpClientsChangeInput = Schema.Struct({ client: McpClientId });
export type McpClientsChangeInput = typeof McpClientsChangeInput.Type;

export class McpClientRegistrationError extends Schema.TaggedError<McpClientRegistrationError>()(
  "McpClientRegistrationError",
  {
    /**
     * `invalid`, `not_installed` (the tool is not on the server's host), `unsupported` (the
     * server cannot name its own executable), `invalid_config` (the tool's config file is not
     * plain JSON, so it was left unchanged), `timed_out` or `failed` (the message quotes what
     * the CLI said).
     */
    reason: Schema.Literals([
      "invalid",
      "not_installed",
      "unsupported",
      "invalid_config",
      "timed_out",
      "failed",
    ]),
    message: Schema.String,
  },
) {}
