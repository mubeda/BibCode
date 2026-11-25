# Standalone Server Installation

GitHub Releases publish desktop installers only. Build standalone server archives,
Linux `.deb`/`.rpm` packages, or the native `bibcode` binary locally from source
using `vp run dist:server:*` or `cargo build -p bibcode-server --bin bibcode --release`.

Locally packaged BiBCode server archives contain the native `bibcode` executable
and the matching built web client. They do not contain Node.js. Packages install
no service; `bibcode service install` creates one per user on request.

After extracting an archive, verify the version and available options:

```sh
./bibcode --version
./bibcode serve --help
```

Run the server on loopback by default:

```sh
./bibcode serve --host 127.0.0.1
```

To let another device pair, bind a private address other devices can reach and
paste the printed `pairingCode` into the desktop app, or mint one later:

```sh
./bibcode serve --host 100.64.0.10
./bibcode pairing offer --endpoint http://100.64.0.10:3773
```

The executable automatically discovers the adjacent `web/` directory. An explicit
`--static-dir` overrides packaged discovery and must contain `index.html`.

Use a trusted private network for remote access. Do not expose an unauthenticated plain
HTTP listener directly to the public internet. Server updates are manual: stop the
process, replace the extracted distribution with the matching newer release, and start
it again. User-owned state under `~/.bibcode` is separate from the distribution.

Linux local server packaging (`vp run dist:server:linux:x64` or `:arm64`) also
builds `.deb` and `.rpm` files. Install a local Debian package with
`sudo apt install ./<file>.deb`, or an RPM with `sudo dnf install ./<file>.rpm`.
Upgrade by installing the newer local package. Remove it with
`sudo apt remove bibcode-server` or `sudo dnf remove bibcode-server`. Removal
deletes package-owned files but preserves `~/.bibcode`.

BiBCode does not host APT, DNF, or YUM repositories, and GitHub Releases do not
publish standalone server archives, packages, `bibcode-server-SHA256SUMS`, or
server `.minisig` signatures.

Archives contain one versioned directory with `bibcode` or `bibcode.exe`, `web/`,
`README.md`, and `LICENSE`. Linux packages own `/usr/bin/bibcode`,
`/usr/share/bibcode/web`, and `/usr/share/doc/bibcode-server`. They do not create a
user, firewall rule, or machine-wide configuration; the optional service is per user
and created by `bibcode service install`.

The client shows generic manual-update steps (or SSH reconnect instructions for
SSH-launched hosts) under **Show update steps** in Remote Servers and the host's
sidebar card, with **Copy** for the displayed steps. Standalone servers remain
manually updated.

## Run as a per-user service

The server spawns provider CLIs and reads their credentials from your home
directory, so it must run as you, not as root or a service account.
`bibcode service install` creates a per-user service that starts `bibcode serve`
with the address you choose and restarts it after reboots:

```sh
bibcode service install --host 100.64.0.10
bibcode service status
bibcode service uninstall
```

The service definition records the `PATH` of the shell you ran the command
from, so provider CLIs installed there stay discoverable. Re-run
`bibcode service install` after installing a provider CLI in a new location.
The service passes `--no-startup-pairing-offer`; mint pairing codes with
`bibcode pairing offer`.

- **Linux** writes `~/.config/systemd/user/bibcode.service`, enables
  lingering so the service starts at boot without a login, and enables it.
  Over a plain SSH session the user service manager may not be reachable yet;
  the command then prints the three commands to run after lingering is on.
- **macOS** writes `~/Library/LaunchAgents/com.bibcode.server.plist`. A
  LaunchAgent runs only inside a logged-in session, so enable automatic login
  on a server Mac. A LaunchDaemon is not used because it cannot reach your
  keychain, where Claude Code stores its token.
- **Windows** creates a scheduled task named `BiBCode Server` that starts at
  your logon with limited privileges. Running without a logged-on user is not
  configured.
