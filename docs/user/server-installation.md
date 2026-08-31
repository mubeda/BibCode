# Standalone Server Installation

BiBCode server archives contain the native `bibcode` executable and the matching built
web client. They do not contain Node.js and do not install a background service.

After extracting an archive, verify the version and available options:

```sh
./bibcode --version
./bibcode serve --help
```

Run the server on loopback by default:

```sh
./bibcode serve --host 127.0.0.1
```

The executable automatically discovers the adjacent `web/` directory. An explicit
`--static-dir` overrides packaged discovery and must contain `index.html`.

Use a trusted private network for remote access. Do not expose an unauthenticated plain
HTTP listener directly to the public internet. Server updates are manual: stop the
process, replace the extracted distribution with the matching newer release, and start
it again. User-owned state under `~/.bibcode` is separate from the distribution.

Linux releases also provide direct-download `.deb` and `.rpm` files for both x64 and
ARM64. Install a downloaded Debian package with `sudo apt install ./<file>.deb`, or an RPM
with `sudo dnf install ./<file>.rpm`. Upgrade by installing the newer local package.
Remove it with `sudo apt remove bibcode-server` or `sudo dnf remove bibcode-server`.
Removal deletes package-owned files but preserves `~/.bibcode`.

BiBCode does not host APT, DNF, or YUM repositories. Verify the downloaded package against
`bibcode-server-SHA256SUMS` from the same GitHub Release before installation.
