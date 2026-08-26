# Linux Server Packages

The native Linux build emits DEB and RPM files for the matching x64 or ARM64
host. `cargo-deb` 3.7.0 consumes the generated manifest and `deb/` maintainer
scripts. `cargo-generate-rpm` 0.21.0 consumes `rpm/metadata.toml` and its
scriptlets directly; there is no unused RPM spec file.

Both formats install `bibcode` at `/usr/bin/bibcode` and the verified browser
assets, layout metadata, license, notices, and build metadata below
`/usr/share/bibcode`. They do not package a second systemd unit. The Rust
service adapter is the sole unit-definition owner.

Package hooks are files-only by default. A noninteractive workstation install
must explicitly provide a valid existing non-root account:

```sh
sudo env BIBCODE_PACKAGE_MODE=workstation BIBCODE_PACKAGE_USER="$USER" \
  apt install ./bibcode-server-0.4.1-linux-x86_64.deb
```

Use the equivalent `dnf install` command for RPM. The hooks never enable user
linger, create a headless account, open a firewall, or delete the data root.
Headless setup remains a separate elevated `bibcode service install --mode
headless` operation after package installation.

Build on the matching native architecture after installing the pinned package
tools:

```sh
cargo install --locked cargo-deb --version 3.7.0
cargo install --locked cargo-generate-rpm --version 0.21.0
vp run dist:server:artifact -- --target x86_64-unknown-linux-gnu --formats native,portable --output-dir release/server-local --unsigned-test
```

Before execution inspect DEB paths and scripts with `dpkg-deb --contents` and
`dpkg-deb --control`; inspect RPM paths and scriptlets with `rpm -qpl
--scripts`. `unsigned-test` is compatibility evidence, not a stable release.
