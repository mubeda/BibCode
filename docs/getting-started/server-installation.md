# Server-only installation

Install the server-only `bibcode` package when the code, repositories, provider
processes, terminals, and project database should live on a machine other than
the desktop client. A server package includes the native Rust executable and
the browser UI. It does not include Node.js, Tauri, a hosted control service, or
telemetry.

Installing a server does not pair a client. The service starts authenticated
and on numeric loopback by default; create a five-minute, single-use pairing
only after installation.

## Choose an artifact

Download the matching files from the same GitHub Release. Do not infer support
from a filename alone: `artifacts.json` is the authoritative target and signing
inventory.

| Host    | Architecture            | Native package | Portable package          |
| ------- | ----------------------- | -------------- | ------------------------- |
| Windows | x64                     | MSI            | ZIP                       |
| Windows | ARM64                   | MSI            | ZIP                       |
| macOS   | Intel and Apple Silicon | universal PKG  | per-architecture `tar.gz` |
| Linux   | x64                     | DEB and RPM    | `tar.gz`                  |
| Linux   | ARM64                   | DEB and RPM    | `tar.gz`                  |

Native packages manage package-owned files and a workstation service. Portable
archives make no service, login-item, `PATH`, firewall, or data-root change when
extracted. Use a portable archive for SSH/WSL provisioning, a custom permanent
location, or an external supervisor.

## Verify release bytes first

The release set contains:

- `artifacts.json` and `artifacts.json.minisig`;
- `SHA256SUMS` and `SHA256SUMS.minisig`;
- one detached `.minisig` and one CycloneDX `.cdx.json` SBOM for every
  downloadable server artifact; and
- the checked-in public key from
  `packaging/server/server-release.pub`, whose key ID is
  `DCC556A0349D880E`.

Obtain the public key from a trusted checkout or another trusted channel, then
verify the manifest, checksum inventory, selected artifact, and selected SBOM:

```sh
minisign -Vm artifacts.json -x artifacts.json.minisig -p server-release.pub
minisign -Vm SHA256SUMS -x SHA256SUMS.minisig -p server-release.pub
minisign -Vm "$artifact" -x "$artifact.minisig" -p server-release.pub
minisign -Vm "$artifact.cdx.json" -x "$artifact.cdx.json.minisig" -p server-release.pub
grep "  $artifact\$" SHA256SUMS | sha256sum -c -
```

On macOS, use `shasum -a 256` if `sha256sum` is unavailable. On Windows,
compare `(Get-FileHash -Algorithm SHA256 $Artifact).Hash` with the exact record
in `artifacts.json` or `SHA256SUMS`. The record must match the intended OS,
architecture, format, byte count, checksum, native-signing state, and
notarization state before any installer runs.

Stable Windows server binaries and MSIs require verified, timestamped
Authenticode in the manifest. macOS signing remains optional: a
credential-free release uses an ad-hoc-signed executable and an unsigned,
unnotarized PKG; a Developer ID release explicitly reports the package
signature and notarization. Detached Minisign verification is required in both
cases. Linux packages rely on the detached release signature and checksum
inventory rather than an embedded vendor signature.

## Windows MSI

The MSI is per-user and needs no Administrator token. Run it interactively or:

```powershell
msiexec.exe /i .\bibcode-server-<version>-windows-<architecture>.msi /passive /norestart
bibcode service status --mode workstation --format json
```

It installs under
`%LOCALAPPDATA%\Programs\BiBCode Server`, adds its `bin` directory to that
user's `PATH`, and registers the current user's `BiBCode` Task Scheduler logon
task. The default data root is `%USERPROFILE%\.bibcode`; production state and
logs are below `userdata`.

Upgrade by running the newer verified MSI for the same architecture. Before
file replacement, the installed server drains work, creates and verifies a
backup, records an identity-bound package receipt, and stops. Activation must
verify the target version, environment/storage identities, web assets,
loopback listener, and task definition. Unsafe rollback after a schema advance
is refused and leaves recovery evidence instead of starting old bytes.

Remove the package from Windows **Installed apps** or with its MSI. Removal
deletes the task and package-owned files but preserves `%USERPROFILE%\.bibcode`.
It never purges projects or backups.

## macOS universal PKG

The PKG contains both Intel and Apple Silicon slices:

```sh
sudo /usr/sbin/installer \
  -pkg ./bibcode-server-<version>-macos-universal.pkg \
  -target /
bibcode service status --mode workstation --format json
```

It installs under `/usr/local/libexec/bibcode-server` and owns the relative
`/usr/local/bin/bibcode` link. With an eligible signed-in console user, package
hooks install or upgrade that user's `com.bibcode.server` LaunchAgent and use
`~/.bibcode`. Without one, the package performs a files-only install; register
the intended workstation or headless service explicitly afterward.

Inspect trust before installation:

```sh
pkgutil --check-signature ./bibcode-server-<version>-macos-universal.pkg || true
spctl --assess --type install --verbose=4 \
  ./bibcode-server-<version>-macos-universal.pkg || true
```

Interpret those results together with `artifacts.json`; do not describe an
ad-hoc executable as Developer ID signed or an unsigned PKG as notarized.
Remove the workstation service first, then remove only the package-owned paths
listed above and forget receipt `com.bibcode.server`, or use the OS/package
management procedure approved for the host. Preserve `~/.bibcode` unless the
separate typed purge flow is intentionally requested.

## Linux DEB and RPM

Both formats install `/usr/bin/bibcode` and the verified web/layout metadata
under `/usr/share/bibcode`. Package hooks are files-only unless the installing
administrator explicitly identifies an existing non-root workstation user:

```sh
sudo env BIBCODE_PACKAGE_MODE=workstation BIBCODE_PACKAGE_USER="$USER" \
  apt install ./bibcode-server-<version>-linux-<architecture>.deb

sudo env BIBCODE_PACKAGE_MODE=workstation BIBCODE_PACKAGE_USER="$USER" \
  dnf install ./bibcode-server-<version>-linux-<architecture>.rpm

bibcode service status --mode workstation --format json
```

The workstation service is that user's `bibcode.service` systemd user unit and
uses `~/.bibcode`. BiBCode never enables linger. For a dedicated headless
service, install package files without the workstation environment variables,
then run `sudo bibcode service install --mode headless`; the dedicated account
uses `/var/lib/bibcode`.

Upgrade with the same package manager and explicit workstation variables when
the package owns a workstation service. DEB/RPM transactions preserve a
private byte snapshot and identity-bound receipt. Normal package removal
removes package files and the recorded workstation unit but preserves the data
root:

```sh
sudo apt remove bibcode-server
# or
sudo dnf remove bibcode-server
```

## Portable ZIP or tar archive

Extract to a new permanent directory, verify the executable is a plain file,
and run it directly from `bin`:

```sh
./bin/bibcode --version
./bin/bibcode serve --no-browser --no-startup-pairing
```

On Windows use `.\bin\bibcode.exe`. To register a workstation service, first
move the whole extracted layout to its final location, then run:

```sh
./bin/bibcode service install --mode workstation
```

The service definition pins the absolute executable path. Moving the archive
after registration creates a definition mismatch. Portable uninstall is
explicit: uninstall the service, then remove only that verified extracted
layout. The data root is separate and remains.

## Installed paths and data

| Item                  | Windows MSI                                                     | macOS PKG                                                                   | Linux DEB/RPM                           |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| CLI                   | `%LOCALAPPDATA%\Programs\BiBCode Server\bin\bibcode.exe`        | `/usr/local/bin/bibcode` -> `/usr/local/libexec/bibcode-server/bin/bibcode` | `/usr/bin/bibcode`                      |
| Browser assets/layout | install root `share\bibcode`                                    | `/usr/local/libexec/bibcode-server/share/bibcode`                           | `/usr/share/bibcode`                    |
| Workstation data      | `%USERPROFILE%\.bibcode`                                        | `~/.bibcode`                                                                | `~/.bibcode`                            |
| Headless data         | `%ProgramData%\BiBCode`                                         | `/Library/Application Support/BiBCode`                                      | `/var/lib/bibcode`                      |
| Production database   | `<data-root>/userdata/state.sqlite`                             | same                                                                        | same                                    |
| Identities            | `<data-root>/userdata/environment-id` and `storage-instance-id` | same                                                                        | same                                    |
| Server log            | `<data-root>/userdata/logs/server.log`                          | same                                                                        | same                                    |
| Local control         | `\\.\pipe\bibcode-<environment-id>`                             | `<data-root>/userdata/run/control.sock`                                     | `<data-root>/userdata/run/control.sock` |
| Backups               | `<data-root>/backups/userdata/<storage-instance-id>`            | same                                                                        | same                                    |

`BIBCODE_HOME` or an explicit `--base-dir` changes the data root. Use the same
absolute value for every service, pairing, inspection, recovery, and purge
command.

## Pair, administer, uninstall, or purge

After the service is running, create one full-administrator pairing on the
server host:

```sh
bibcode auth pairing create \
  --client-label "Administrator laptop" \
  --format human
```

The credential is shown once, expires after five minutes, and is bound to the
client's DPoP key on redemption. Installation success does not imply pairing
success.

Use [Server administration](../operations/server-administration.md) for
workstation/headless service commands, direct HTTPS/TLS, revocation,
backup/recovery, safe update behavior, uninstall, and the irreversible typed
purge. Use [Remote access](../user/remote-access.md) for WSL, SSH, and HTTPS
client enrollment. Plain non-loopback HTTP does not exist.
