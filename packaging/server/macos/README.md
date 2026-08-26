# macOS Server Package

The native server package is one universal product PKG containing only the
combined `x86_64` and `arm64` Rust executable plus the verified server-only
layout. It installs under `/usr/local/libexec/bibcode-server` and owns the
relative `/usr/local/bin/bibcode` link.

`postinstall` detects a valid non-root console user and invokes the installed
binary's `service install --mode workstation --host 127.0.0.1 --update`
operation in that user's launchd domain. Without an eligible console user or
on a non-root target volume, installation is explicitly files-only. The Rust
service adapter remains the only LaunchAgent definition owner. No script opens
a listener beyond loopback, enables remote access, receives a secret, or
deletes the data root.

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
