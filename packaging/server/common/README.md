# BiBCode Server Common Package Inputs

`install-layout.json` is the versioned runtime contract copied into
`share/bibcode/`. The server verifies it and the generated `web-assets.json`
inventory before serving packaged UI bytes.

Staging also includes a root `README.md` with explicit foreground and
service-install commands plus `share/bibcode/build-metadata.json` with the
source SHA, target triple, Rust version, and binary digest used for that native
build.

`THIRD-PARTY-NOTICES.md` is generated during packaging from the locked Rust and
web production dependency graphs. It is an input to every portable archive and
native installer; it is not generated at application startup.

`scripts/build-server-artifact.ts` resolves the exact channel from the checked-in
`rust-toolchain.toml`, asks Rustup for the corresponding Cargo and rustc
executables, and sets `RUSTC` explicitly. A Homebrew or system compiler earlier
on `PATH` therefore cannot silently produce one slice or format with a different
toolchain.
