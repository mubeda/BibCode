# Plan: unattended CLI diagnostics (#202)

Design: `docs/superpowers/specs/2026-10-27-cli-pairing-design.md` (approved with
amendments; see its "Approval amendments").
Branch `claude/b3d-cli-pairing` from `claude/issue-batch-after-v0.12.0`.

## Acceptance criteria

- AC1: with no app running, `bibcode diagnostics pair` + `bibcode diagnostics
  download --remote <name>` saves a remote's bundle using a `diagnostics:read`
  credential that the remote lists and can revoke.
- AC2: the bundle passes the same redaction (server-side, same RPC), bounds (20 MiB,
  64 KiB items, exact length), crash-dump scope check (`orchestration:operate`,
  unchanged) and identity check (store and environment pinned at pairing, checked
  against `Started` and the inner manifest) as the in-app download.

## Root cause

No production client of `/ws-e2ee` exists (`rpc/e2ee.rs:2004`, `tests/e2ee_ws.rs:99`
are test-only), and no credential narrower than `orchestration:read` can call
`server.downloadDiagnosticLogs` (`auth/scope.rs:65`, exact-match checks at
`auth/service.rs:1030`, `auth/model.rs:245`, `auth/http.rs:365`).

## Steps (TDD where a seam exists; one commit each)

1. **Scope.** `auth/model.rs`: `SCOPE_DIAGNOSTICS_READ`, add to `ALL_SCOPES`,
   `scope_satisfies`; use it in `Principal::has_scope`, `authorize_session`,
   pairing-offer subset check. `scope.rs`: download → `diagnostics:read`; tests for
   both directions. Contracts `auth.ts` literal + fixture regen
   (`scripts/export-rust-auth-fixtures.ts`), `authRustParity.test.ts`,
   `tests/auth_http.rs`.
2. **Offer.** `config.rs` `--access full|diagnostics`; `lib.rs`,
   `pairing_offer.rs::mint_offline_pairing_offer`,
   `service.rs::issue_offline_share_pairing` take scopes; label default
   `<name> (diagnostics)`. Test: CLI offer grant carries only `diagnostics:read`.
3. **Client.** `rpc/e2ee_client.rs`: connect (NK pinned, 4403 →
   host-identity), records (reuse `plaintext_records`, bounded reassembly),
   `e2ee_auth`, `stream`/`unary` over `ClientMessage`/`ServerMessage`. Unit tests
   against an in-process server (`ServerRuntime::start_standalone` in a lib test
   or the `tests/` harness). TLS feature only if `Cargo.lock` gains no crates
   (decided at approval).
4. **Store.** `SecretStore::remove` + listing; `diagnostics/remotes.rs`
   (record shape, name rules, `<state dir>/diagnostics-remotes/`). Unix 0600
   test `#[cfg(unix)]`.
5. **Shared archive checks.** Move `Receiving`/`save_new`/`archive_matches_manifest`/
   `printable` from `relay_cli.rs` into `diagnostics/archive.rs`; relay tests
   unchanged and green.
6. **CLI.** `relay_cli.rs` subcommands `pair`, `remotes`, `forget`,
   `download --remote` (clap group with `--environment`); pairing order and
   rollback per design; outcomes and exit codes.
7. **Integration test** `apps/server/tests/diagnostics_remote_cli.rs`: design
   tests 1-6 with the real binary.
8. **Docs.** `docs/cloud/environment-auth.md` (scope table, offer access),
   `docs/architecture/remote.md` (new access subsection + Current limitations:
   SSH/Connect, 30-day expiry, `forget` is local), `docs/operations/observability.md`
   "From the command line", `docs/skills/bibcode-profiler/SKILL.md` (remote, no SSH,
   app closed), `docs/user/remote-access.md` (diagnostics-only offer),
   `docs/testing/cross-platform-validation.md` (CLI pairing check), status line of
   `docs/superpowers/specs/2026-10-27-diag-thread-cli-design.md`.

## Files touched

`apps/server/src/{auth/model.rs,auth/scope.rs,auth/service.rs,auth/http.rs,
auth/pairing_offer.rs,auth/secret_store.rs,config.rs,lib.rs,rpc/mod.rs,
rpc/e2ee_client.rs (new),diagnostics/mod.rs,diagnostics/relay_cli.rs,
diagnostics/archive.rs (new),diagnostics/remotes.rs (new)}`,
`apps/server/tests/diagnostics_remote_cli.rs (new)`, `apps/server/tests/auth_http.rs`,
`packages/contracts/src/auth.ts`, `packages/contracts/fixtures/auth-http/*`,
maybe root `Cargo.toml` (TLS feature), docs above.
Outside this batch's usual files: `relay_cli.rs` (#201's), contracts (shared).

## Validation

`cargo fmt --all --check`; one filter per `cargo test` run (cargo takes a single
positional filter): `cargo test -p bibcode-server --lib auth::`,
`cargo test -p bibcode-server --lib rpc::e2ee_client`,
`cargo test -p bibcode-server --lib diagnostics::`, then the full
`cargo test -p bibcode-server --lib`; `cargo test -p bibcode-server --test
diagnostics_remote_cli --test e2ee_ws --test auth_http --test diagnostic_logs_relay
--test cli_smoke` (several `--test` targets in one run are fine);
`cargo clippy -p bibcode-server --all-targets -- -D warnings`; `vp check --no-fmt`,
`vp check <changed files>`, `vp run typecheck`, contracts tests
(`vp test run packages/contracts/src/authRustParity.test.ts`),
`vp test run scripts/bibcode-identity.test.ts`. Manual: pair the local Mac against a
second `bibcode serve` on another data root and port with the app closed.

## Skipped (one line)

Share-tab control, self-revoke RPC, renewal, `profiler --remote`, crash-dump scope,
`e2ee_auth` device hints.
