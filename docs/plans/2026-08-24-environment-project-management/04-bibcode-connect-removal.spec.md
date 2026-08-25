# BiBCode Connect Removal Specification

## Outcome

Remove the inherited BiBCode Connect cloud-relay product completely from active
source, schemas, dependencies, infrastructure, workflows, runtime configuration,
UI, tests, and living documentation.

The resulting product connects only through desktop-managed local/WSL routes,
SSH tunnels, or explicit HTTPS/WSS. There is no hosted account, Clerk sign-in,
managed endpoint, Cloudflare relay, tunnel daemon, or cloud environment link.

## Preserve Only Generic Authentication

The removal must preserve and, where necessary, extract from Connect-specific
modules these independent primitives:

- Server-local pairing records and single-use credentials.
- Scoped administrator sessions.
- DPoP key binding/proof validation and replay defense.
- WebSocket admission tickets.
- Client/session revocation.
- Generic JWT/JWS helpers only when active non-Connect authentication uses them.
- Direct bearer/DPoP authorization over allowed local/SSH/HTTPS routes.

Names, issuers, audiences, scopes, configuration, or code paths used only by
Connect do not survive under a “generic” alias.

## Active Removal Inventory

Implementation starts with a fresh dependency and symbol inventory. The
verified baseline includes at least:

### Infrastructure And Workspace

- Delete `infra/relay/**`.
- Remove the relay package from `pnpm-workspace.yaml`, Vite+ configuration,
  lockfile importers/dependencies, reference/dependency scripts, coverage
  configuration, and package policy.
- Delete `.github/workflows/deploy-relay.yml`.
- Remove Connect/relay deployment and artifact steps from release/CI workflows.
- Remove Clerk, Cloudflare, Alchemy relay, cloudflared, managed-endpoint, and
  relay configuration from `.env.example` and script public-config contracts.

### Contracts And Shared Runtime

- Delete `packages/contracts/src/relay.ts` and its tests/exports after moving no
  Connect-only shape into generic environment contracts.
- Delete `packages/shared/src/relayAuth.ts` and tests/exports unless a currently
  used direct-auth primitive is first moved into the correct auth owner with
  Connect-free names and semantics.
- Remove relay/managed-endpoint capability fields, target/registration variants,
  schemas, bootstrap token types, and public config.

### Client Runtime

- Delete `packages/client-runtime/src/relay/**`.
- Remove `RelayConnectionTarget`, `RelayConnectionRegistration`, relay resolver,
  relay supervisor refresh triggers, managed-relay state, discovery, and
  presentation.
- Refactor the catalog to environment-plus-routes rather than retaining a
  deprecated Relay variant.
- Keep direct SSH/HTTPS credentials behind the generic credential store.

### Server

- Delete/refactor the Connect-only production modules, including the current
  relay, managed-endpoint, and Connect MCP surfaces and their integration/tests.
- Remove cloud issuer/audience/config, cloudflared process launch, relay tunnel,
  managed endpoint allocation, cloud link/observability domain, and relay token
  exchange.
- Inspect shared auth/JWT/lifecycle/provider/terminal modules before editing;
  retain only code reached by local/direct authentication and rename it only
  when its domain is genuinely generic.
- Remove Connect routes, capabilities, environment variables, logs, and health
  signals from server startup.

### Web Application

- Delete `apps/web/src/cloud/**`, Clerk components/hooks, Connect sign-in,
  environment linking, managed endpoint dialogs, and relay client-install UI.
- Remove Clerk/Connect dependencies and Vite public configuration.
- Remove Connect settings/navigation, account state, route presentation,
  bootstrap wiring, and zero-coverage fixtures.
- Replace the currently hidden device-management presentation with the approved
  environment tree/settings; do not leave an empty Connect slot.

### Living Documentation

- Delete current `docs/cloud/**` documents that exist only for Connect.
- Rewrite living architecture, remote, provider, operations, privacy,
  installation, usage, testing, and release documents so they describe only
  direct local/WSL/SSH/HTTPS operation.
- Remove obsolete Connect screenshots, links, commands, configuration, secrets,
  troubleshooting, and deployment guidance from `docs/README.md` and indexes.

Historical material under `docs/plans/` and `docs/superpowers/` remains an
immutable record under repository policy. It may retain historical Connect
text, but every active-source scan must explicitly distinguish that allowlisted
history from living behavior. `.repos/` remains read-only external evidence and
is excluded.

## Catalog And Secret Migration

The new client catalog migration processes legacy Connect state before normal
schema decoding:

- Delete relay/managed-endpoint routes and their cached access/bootstrap tokens.
- Delete Connect account/session metadata and legacy public config.
- Request deletion of associated OS-secret entries where they exist.
- Preserve an environment only when another direct route proves its environment
  and accepted storage identity.
- Forget a relay-only environment locally. Do not claim its remote server/data
  was uninstalled or purged.
- Remove Connect cache entries that cannot be safely tied to a surviving direct
  environment identity.

The migration is bounded and idempotent. It does not retain runtime support for
old Relay variants. After migration, unsupported route kinds fail closed and
can be removed by a generic unsupported-record repair path rather than a
Connect compatibility layer.

## Database And Infrastructure Decommissioning

Removing code from this repository does not automatically delete deployed
Cloudflare/Alchemy/Clerk resources. Decommissioning any real external resource
is a separately authorized operational action and is not implied by an
implementation checkout.

The implementation plan must:

1. Inventory names and ownership from the current relay deployment code without
   printing secrets.
2. Remove deployment capability from the repo first.
3. Produce a decommission runbook identifying external dashboards/resources
   that an authorized operator must delete.
4. Require explicit operator confirmation before external destructive action.
5. Remove stored repository/environment secrets only after the corresponding
   workflow and resource no longer need them.

No application migration calls a cloud deletion API.

## No Compatibility Surface

Forbidden remnants include:

- A disabled/hidden Connect tab or route.
- Deprecated Relay schema variants.
- Redirects or aliases from Connect endpoints.
- Automatic fallback to a managed endpoint.
- Clerk initialization behind a false feature flag.
- Cloudflare/Alchemy/Connect dependencies retained “for later.”
- Connect-specific environment variables accepted but ignored.
- Tests that keep obsolete contracts compiling.

Historical plan text and generic networking uses of the English word “relay”
are the only possible allowlisted search hits. Every other hit is reviewed.

## Sequencing

1. Add/verify direct environment identity, routes, and local pairing seams needed
   by non-Connect clients.
2. Add a migration that can read the legacy catalog without loading Connect at
   normal runtime.
3. Remove web Connect surfaces and relay discovery/supervision.
4. Remove server Connect/managed-endpoint/runtime surfaces.
5. Delete contracts/shared relay modules and packages.
6. Delete relay infrastructure/deployment workflow and dependencies.
7. Update living docs/tests/policy and regenerate lockfile through normal
   tooling.
8. Run negative searches, dependency graph checks, and all affected builds.

This phase lands coherently; it must not leave a commit where ordinary startup
requires missing Connect schemas or where Connect can still be reached through
an undocumented URL.

## Verification

At minimum:

- `rg` searches for `BiBCode Connect`, Clerk, cloudflared, managed endpoint,
  Relay connection variants, relay token, cloud environment link, and
  `infra/relay`, excluding immutable history and `.repos/`.
- Workspace package/lockfile inspection proves no Connect-only dependency or
  importer remains.
- Server route/module/config inventory proves no Connect listener/tunnel/task.
- Web navigation/bundle inspection proves no Clerk/Connect UI or public config.
- Catalog migration tests cover relay-only, relay-plus-direct, corrupt, missing
  secret, crash/retry, and post-migration schema load.
- Direct pairing, DPoP, revocation, SSH, HTTPS, local desktop, and WSL tests prove
  the preserved auth/runtime paths.
- `vp check`, `vp run typecheck`, affected Rust tests, format, Clippy, release
  workflow validation, and package builds pass.

## Acceptance Criteria

- No active runtime can create, discover, link, authenticate through, or display
  a BiBCode Connect route.
- No packaged artifact includes Clerk, Cloudflare relay, managed-endpoint, or
  Connect code/config.
- No CI job deploys relay infrastructure.
- No living document instructs users to use Connect.
- Generic local/direct pairing and DPoP behavior remains covered and functional.
- Legacy relay state cannot corrupt startup and is not retained as a supported
  schema variant.
- No external cloud resource is destructively modified without a separate,
  explicit operator action.
