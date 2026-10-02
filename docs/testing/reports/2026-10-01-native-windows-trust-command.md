# Native Windows trust-command verification

## Scope and revision

Issue #30: verify the Git Manager's generated `safe.directory` commands on
Windows, including UNC syntax and shell-sensitive characters, and retain
ongoing native macOS execution.

- Branch: `codex/fix-github-issues`.
- Source baseline: `b3301099812dc253f55757148531a2e86e5a2de7`.
- Product function: `gitManagerRepositoryUnavailableCopy`, unchanged by this issue.
- Verified source SHA256:
  `6f7368eec245cff1ee47bfff73c2f8597add8d36accebabb3ab8909c70e300be`.
- Concurrent issue work was preserved; this report does not qualify the entire
  working tree or a Windows installer.

## Native environment and procedure

Windows 11 ARM64, OS build 26100, running as the interactive account in a
Parallels guest. Node `v26.5.0`, Git `2.55.0.windows.3`, Windows PowerShell
`5.1.26100.9444`. Node only loaded the unchanged TypeScript helper; this is not
a full workspace check under the repository's declared Node version.

The exact source file and a Node probe were copied to an isolated guest
temporary directory. The probe imported the real helper, passed its generated
commands to `powershell.exe -NoProfile -NonInteractive -EncodedCommand`, then
queried `git.exe config --global --get-all safe.directory`. The PowerShell
script checked every native Git exit code. Global/system Git files and HOME
were temporary; inherited `GIT_*` variables were removed. The user's Git
configuration was not used or changed.

## Results

All four commands registered exactly the intended literal value, with exit 0:

| Input                                               | Registered value                                              |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `C:\work\plain`                                     | `C:/work/plain`                                               |
| ``C:\work\space $literal `tick O'Brien``            | ``C:/work/space $literal `tick O'Brien``                      |
| `C:\work\O’Brien\repo`                              | `C:/work/O’Brien/repo`                                        |
| ``\\server\share name\repo $literal `tick O’Brien`` | ``%(prefix)///server/share name/repo $literal `tick O’Brien`` |

The UNC case verifies parsing and registration, including Git for Windows'
prefix notation. It does not contact a network share or prove access to one.
The probe did not exercise the packaged app's clipboard or terminal widget.

Native macOS execution was also confirmed in
[CI run 36947347635](https://github.com/mubeda/BibCode/actions/runs/36947347635):
the macOS ARM64 job completed successfully and its **Test desktop Rust host**
step passed; the Intel row's same test step also passed. These commands execute
the desktop tests, rather than compiling them alone.

## Continuing coverage

Both Windows CI rows now run the native PowerShell/Git round-trip case in
`gitManagerRepositoryAvailability.test.ts` alongside the desktop shell fixture
contracts. The native case is explicitly skipped on other operating systems.

The workflow-contract regression failed before the CI command included the new
test file. After the change,
`vp test run scripts/ci-platform-contract.test.ts apps/web/src/components/gitManager/gitManagerRepositoryAvailability.test.ts`
passed 75 tests on macOS, with the Windows-only case explicitly skipped. Those
local results are compatibility evidence; the guest probe above is the native
Windows evidence. The new CI wiring still requires its own subsequent run.

The Windows runbook documents the command and its limits. The macOS runbook was
reviewed and remains accurate: its native test execution requirements and
distinction from compatibility checks are already explicit.
