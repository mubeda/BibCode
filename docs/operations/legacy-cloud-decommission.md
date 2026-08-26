# Legacy BiBCode Connect Decommission

> **Manual, external operation only.** Neither an application migration nor a
> repository checkout deletes, disables, or changes any external resource in
> this runbook. Every dashboard or API mutation requires a separately
> authorized operator to review the resolved target, confirm ownership, record
> approved evidence, and explicitly confirm that exact destructive action.

This runbook retires external resources left by the removed BiBCode Connect
product. It is not an application setup procedure and must never contain
credentials, tokens, private keys, database rows, or unredacted deployment
output.

## Scope and ownership inventory

Resolve each candidate from the owning provider dashboard and the repository's
historical deployment metadata. Record non-secret resource IDs, account or
organization, region, creation labels, current owner, dependency, and approved
ticket in a protected audit record. Stop if ownership is ambiguous.

Inventory these resource classes:

- GitHub repository and environment secrets and variables whose names begin
  with `BIBCODE_RELAY`, `VITE_BIBCODE_RELAY`, `BIBCODE_CLERK`, or
  `VITE_CLERK`, plus deployment environments and permissions used only by the
  deleted `infra/relay` package or workflow;
- the Cloudflare Worker, routes, custom domain, DNS records, `cloudflared`
  tunnel/service, service tokens, and scoped API tokens;
- the Clerk application, JWT template, OAuth application, passkey domains,
  signing/verification keys, webhooks, allowed origins, and API keys;
- Alchemy deployment/application state and its managed PostgreSQL/database,
  users, connection pools, backups, and network rules;
- provider deployment logs, build artifacts, state snapshots, audit logs, and
  retained backups that may still contain endpoint names or credentials; and
- client/server backups containing the retired SQLite tables,
  `environment-jwt.json`, or the old `cloudflared` tool directory.

Never paste a secret into the inventory. Use provider-generated fingerprints,
last-used timestamps, non-secret IDs, redacted screenshots, and audit events to
establish ownership.

## Required destructive order

Complete the following order without skipping ahead. Before every dashboard or
API mutation, present the exact account and resource ID to the authorized
operator and obtain an explicit yes/no confirmation. A batch confirmation is
not sufficient.

1. **Export the inventory and audit evidence.** Export non-secret resource
   metadata and provider audit events to the approved evidence location.
   Explicitly confirm each export or snapshot operation that can expose or
   retain sensitive data.
2. **Disable new use.** Confirm released clients no longer contain BiBCode
   Connect, then explicitly confirm disabling new links, deployments, Worker
   routes, and credential issuance. Observe existing traffic before proceeding.
3. **Revoke and rotate credentials.** Explicitly confirm each service token,
   tunnel token, Clerk key/template/OAuth credential, database credential, and
   GitHub deployment credential revocation or rotation. Rotate credentials even
   when their last-used time is empty; absence of an event is not proof that a
   copied credential never existed.
4. **Remove public naming only after traffic checks.** Verify released client
   versions and an approved no-traffic window, then explicitly confirm each DNS
   record, custom domain, Worker route, and redirect removal. Preserve the
   evidence needed to distinguish expected DNS propagation from unexpected use.
5. **Delete provider resources.** In the owning dashboards, explicitly confirm
   each Cloudflare Worker/tunnel/service, Clerk application object, and
   Alchemy/PostgreSQL database/application deletion. Verify dependent pools,
   users, routes, domains, logs, and state no longer keep the resource active.
6. **Remove repository configuration.** Only after provider resources are gone,
   explicitly confirm deletion of each GitHub secret, variable, deployment
   environment, and obsolete provider permission. Record names, never values.
7. **Verify and close.** Confirm there is no unexpected BiBCode Connect traffic,
   deployment, DNS resolution, credential use, or billable resource. Document
   the retained audit evidence, backups, retention deadlines, owners, and every
   credential rotation performed because a backup may contain old material.

If any verification fails, stop destructive work, preserve the current audit
state, rotate exposed credentials, and investigate before continuing.

## Application-local cleanup boundary

On first startup after the removal, the server performs an idempotent local
cleanup while its database/store admission guard is held. It securely drops
the retired SQLite tables, compacts SQLite, removes the owned
`environment-jwt.json` file and old `cloudflared` tool directory only after
path/symlink validation, and writes a non-secret completion receipt. A partial
cleanup fails startup and retries; it does not quarantine or log secret values.
The web client deletes the complete old authentication IndexedDB database,
including `relay-dpop-proof-key`, only after its migration receipt is durable.

This cleanup never reaches a provider dashboard or API and never deletes a
user-created backup. Backups can retain old credentials after the live store is
clean, so operators must rotate every affected credential and apply the
approved backup retention/deletion policy separately. Restoring an old backup
does not restore product support; the next startup runs the cleanup again.
