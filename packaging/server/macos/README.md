# macOS Server Package

The native server package is one universal product PKG containing only the
combined `x86_64` and `arm64` Rust executable plus the verified server-only
layout. It installs under `/usr/local/libexec/bibcode-server` and owns the
relative `/usr/local/bin/bibcode` link.

`preinstall` detects a valid non-root console user, resolves and records that
user's exact home/data root, snapshots the prior install root, and asks the old
binary to drain, back up, and stop through the package lifecycle. `postinstall`
runs the new binary's activation in that user's launchd domain. On failure it
restores the exact prior install tree and permits the old binary to start only
after receipt hash/path and schema checks. If rollback is unsafe, the new bytes,
failed-byte snapshot, and verified backup remain for recovery. Without an
eligible console user or on a non-root target volume, installation is
explicitly files-only. The Rust service adapter remains the only LaunchAgent
definition owner. No script opens a listener beyond loopback, enables remote
access, receives a secret, purges, or deletes the data root.

The private transaction survives interruption and a repeated pre-install
resumes only the same user, root, target version, nonce, and snapshot. Any
mismatch fails closed without deleting the recovery material.

Safe upgrade requires the installed package to expose `package prepare`. An
older PKG without it aborts before replacement; preserve the data root, remove
only package/service files, and use a clean install to adopt that root.

On either native Mac, install both repository-pinned Rust targets first, then
build:

```sh
toolchain=$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)
rustup target add --toolchain "$toolchain" aarch64-apple-darwin x86_64-apple-darwin
vp run dist:server:artifact -- --target "$(rustup run "$toolchain" rustc -vV | sed -n 's/^host: //p')" --formats native,portable --output-dir release/server-local --unsigned-test
```

The builder verifies both slice versions and hashes, exact `lipo` architecture
membership, ad-hoc executable signing, package payload roots, required files,
and script executability. On current macOS, `pkgutil --payload-files` may list
paired `._name` AppleDouble records for protected OS provenance metadata. The
validator permits such a record only when its allowlisted sibling `name`
exists; `pkgutil --expand-full` must not materialize it as a separate payload
file.

Credential-free output has an ad-hoc executable and an unsigned, unnotarized
PKG. Optional Developer ID signing and notarization are separate release steps;
the templates contain no Apple credential.
