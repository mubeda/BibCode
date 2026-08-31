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
