# BiBCode Server Common Package Inputs

`install-layout.json` is the versioned runtime contract copied into
`share/bibcode/`. The server verifies it and the generated `web-assets.json`
inventory before serving packaged UI bytes.

`THIRD-PARTY-NOTICES.md` is generated during packaging from the locked Rust and
web production dependency graphs. It is an input to every portable archive and
native installer; it is not generated at application startup.
