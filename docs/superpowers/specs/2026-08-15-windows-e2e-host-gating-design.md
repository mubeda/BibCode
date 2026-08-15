# Windows E2E Host Gating Design

## Status

Approved on 2026-08-15.

## Context

After pulling Windows validation fixes, the focused desktop E2E support matrix
failed on macOS in `prepareDesktopUiTestContext on 'win'`. The test correctly
constructs a simulated Windows fixture, but then launches its generated
`cursor.cmd` through `C:\Windows\System32\cmd.exe`. A simulated target platform
does not make that native executable available on a non-Windows host, so the
test fails with `ENOENT` before it can inspect the fixture action log.

The environment, path, directory, and generated-file assertions are portable.
Executing a `.cmd` wrapper is native Windows behavior and requires a real
Windows command processor.

## Goal

Keep portable Windows fixture construction covered on every host while running
the generated `.cmd` wrapper only on native Windows. Preserve the Windows
action-log assertion and restore the shared macOS/Linux test graph without
weakening Windows coverage.

## Non-Goals

- Do not change packaged desktop behavior or provider launch behavior.
- Do not emulate or install a Windows command processor on macOS or Linux.
- Do not replace the native execution assertion with a mocked `spawnSync`.
- Do not skip the portable Windows environment and filesystem assertions.
- Do not change CI concurrency, timeouts, or platform matrices.

## Chosen Design

The existing parameterized inventory test continues to create `mac`, `linux`,
and `win` contexts on every host and assert their portable environment and
filesystem contracts. The Windows branch no longer launches `cursor.cmd`.

A separate Windows-native test creates the same `win` context and is enabled
only when `process.platform === "win32"`. It launches the generated wrapper via
the host `ComSpec`, requires a successful exit, and verifies that the fixture
recorded the exact `openInEditor` action and Windows path argument. This keeps
the native assertion real on Windows and makes its host requirement explicit.

No production source changes. The repair is confined to desktop E2E test
coverage.

## Alternatives

### Inject a cross-platform command-runner abstraction

Rejected. It would add test infrastructure solely to avoid one native boundary
and still would not prove that the generated `.cmd` wrapper executes under the
Windows command processor.

### Mock `spawnSync`

Rejected. A mock would verify call construction rather than wrapper execution
and action-log publication.

### Skip the complete Windows context outside Windows

Rejected. The Windows environment, app-data isolation, path, directory, and
fixture-generation contracts are host-independent and valuable on every host.

## Failure and Cleanup Semantics

The native Windows test must fail on a spawn error, non-zero exit, or incorrect
action-log record. Existing per-test cleanup remains responsible for the
disposable run root on both success and failure. Non-Windows hosts never try to
resolve or execute `cmd.exe`.

## Verification

The already observed focused and exact macOS failures are the RED evidence.
After the test split:

1. run the exact `test-project.test.ts` inventory coverage;
2. run the complete changed desktop/script focused matrix;
3. run `vp run test` and `cargo test --workspace -j 2` sequentially;
4. run `vp check`, `vp run typecheck`, `cargo fmt --all --check`, and workspace
   Clippy with warnings denied; and
5. review `git diff --check` and `git status --short`.

Native execution of the `.cmd` assertion remains Windows evidence and cannot be
claimed from a macOS run. Current Windows CI will execute it through the normal
desktop/package test graph.

## Documentation Impact

This is a test-host classification correction. Runtime architecture and user
documentation are unchanged. The shared cross-platform runbook already
requires native, compatibility, and unavailable evidence to be reported
separately, so no living runbook change is needed.
