# Canonical BiBCode Identity Design

## Objective

Make BiBCode the only project identity in active source, configuration, package
metadata, binaries, protocols, tests, generated lockfiles, and documentation.
This is a hard cutover: no permanent legacy aliases or compatibility names remain.

## Canonical Names

| Surface                 | Canonical value                   |
| ----------------------- | --------------------------------- |
| Product                 | `BiBCode`                          |
| Slug                    | `bibcode`                          |
| npm scope               | `@bibcode/*`                       |
| Rust crate prefix       | `bibcode-*`                        |
| CLI and server package  | `bibcode`                          |
| Desktop binary          | `bibcode-desktop`                  |
| Environment prefix      | `BIBCODE_*`                        |
| Vite environment prefix | `VITE_BIBCODE_*`                   |
| Browser storage prefix  | `bibcode:`                         |
| Tauri identifier        | `com.bibcode.app`                  |
| Well-known endpoint     | `/.well-known/bibcode/environment` |
| Hosted control endpoint | `/__bibcode/channel`               |

## Scope

- Rename workspace package names, dependency specifiers, filters, imports, lint
  plugin names, and the `oxlint-plugin-bibcode` directory.
- Rename Rust packages, dependency keys, library names, binaries, executable
  references, process assertions, fixture names, and installer expectations.
- Rename all application-owned environment variables, storage/database keys,
  cookie names, telemetry service names, protocol routes, marker strings,
  temporary file prefixes, and app-data paths.
- Rename Tauri bundle metadata and platform identifiers.
- Update CI, release workflows, scripts, fixtures, documentation, and historical
  measurement prose so they describe BiBCode only.
- Regenerate `pnpm-lock.yaml` and `Cargo.lock` from renamed manifests.
- Rename project-owned files and directories whose names contain the old
  identity. Vendored `.repos` content and Git history are out of scope.

## Compatibility

The cutover intentionally does not retain old CLI names, environment variables,
protocol routes, package aliases, storage keys, or application identifiers.
Existing installations must be replaced by the BiBCode installer. This avoids
keeping the removed identity alive indefinitely.

## Verification

- A repository guard scans project-owned files and file paths case-insensitively
  for the removed product name, package scope, environment prefix, and standalone
  CLI token.
- `vp check`, `vp run typecheck`, `vp test`, and `vp run test` pass.
- `cargo fmt --all --check`, workspace clippy with `-D warnings`, and workspace
  tests pass.
- Browser and packaged Tauri smoke tests use only BiBCode URLs, binaries, process
  names, storage, and metadata.
- Release executables and installers are named BiBCode and contain no removed
  identity strings attributable to application code.
