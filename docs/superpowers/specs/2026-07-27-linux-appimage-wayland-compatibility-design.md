# Linux AppImage Wayland Compatibility Design

## Goal

Every T4Code Linux AppImage must start reliably on distributions whose Mesa and Wayland stacks
are newer than the Ubuntu runner used to build the artifact. The fix must apply to local,
release, updater-signed, and packaged UI AppImage builds without disabling GPU acceleration or
changing runtime behavior on macOS and Windows.

## Confirmed Root Cause

The v0.2.14 AppImage starts the native Tauri host and WebKit network process on CachyOS, but its
`WebKitWebProcess` aborts before loading application assets:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

The AppImage bundles Ubuntu's `libwayland-client.so.0` while loading Mesa/EGL from the target
system. On a newer Mesa stack, that mixed dependency closure prevents EGL display creation. The
host remains alive with a white window because the WebKit content process has exited.

Two controlled experiments isolated this boundary:

1. `WEBKIT_DISABLE_DMABUF_RENDERER=1` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` did not prevent the
   abort.
2. Preloading the host `libwayland-client.so.0`, or removing only the bundled copy from an
   extracted AppImage, kept `WebKitWebProcess` alive and rendered the complete T4Code UI.

This matches the current upstream Tauri report
[tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665), which documents the
same failure mode for AppImages built on older Ubuntu runners and executed with newer Mesa.

## Chosen Approach

Patch the AppImage packaging stage before linuxdeploy creates the final image.

Tauri 2.11 does not expose an AppImage library exclusion option. It does, however, reuse a GTK
linuxdeploy plugin from its tools cache. T4Code will opt into Tauri's project-local tools cache
and prepare a repository-controlled wrapper at `target/.tauri/linuxdeploy-plugin-gtk.sh`.

The wrapper will:

1. Delegate all arguments to an official GTK plugin pinned to commit
   `b5eb8d05b4c0ed40107fe2158c5d8527f94568ef`.
2. Preserve plugin discovery calls such as `--plugin-api-version`.
3. After a successful AppDir deployment, remove every `libwayland-client.so*` below the AppDir's
   `usr/lib*` directories.
4. Verify that no matching bundled library remains and fail the build if cleanup is incomplete.

The upstream plugin is downloaded from its immutable commit URL and accepted only when its
SHA-256 is:

```text
cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a
```

This changes the AppDir before the AppImage output plugin runs. Tauri therefore signs the final,
corrected AppImage through its existing updater flow; the implementation does not rewrite an
already-signed artifact.

## Components

### Tool Preparation

`scripts/prepare-tauri-appimage-tools.ts` will own the project-local tool preparation.

- Non-Linux hosts return without filesystem or network work.
- Linux hosts use `target/.tauri` derived from the repository root.
- A valid cached upstream plugin is reused without a network request.
- A missing or invalid cached copy is replaced from the pinned URL.
- Downloads are hash-verified before publication.
- Temporary writes are renamed into place so an interrupted preparation cannot leave a trusted
  partial plugin.
- The upstream plugin and T4Code wrapper are executable.

The script will expose a small injectable preparation function for focused tests while its CLI
entry point uses the real filesystem, network, hashing, and platform.

### GTK Plugin Wrapper

`scripts/tauri/linuxdeploy-plugin-gtk.sh` will be a small Bash wrapper. The official plugin will
live beside it in the generated cache as `linuxdeploy-plugin-gtk-upstream.sh`.

The wrapper will use strict shell error handling, propagate the upstream exit status, parse the
actual `--appdir` argument, and operate only inside that AppDir. It will not alter global
libraries, user caches, `LD_PRELOAD`, renderer settings, or the application process environment.

### Tauri Configuration

`apps/desktop/src-tauri/tauri.conf.json` will:

- set `bundle.useLocalToolsDir` to `true`, confining the prepared plugin to this repository's
  `target/.tauri`;
- run the preparation script from `beforeBuildCommand` before the existing web build and brand
  asset steps.

Because Tauri's `beforeBuildCommand` is shared by normal, release-overlay, and desktop E2E
builds, all AppImage entry points receive the same packaging behavior.

### Artifact Contract

The Linux packaged desktop smoke job will extract the completed AppImage and fail when any
`libwayland-client.so*` is present below `usr/lib*`. This validates the final artifact rather
than assuming that the wrapper's intermediate AppDir mutation survived later bundler stages.

The existing packaged UI smoke remains responsible for proving that the application starts and
renders on the build runner.

## Failure Handling

Linux AppImage builds fail closed when:

- the pinned plugin cannot be downloaded;
- the downloaded bytes do not match the pinned SHA-256;
- cache publication or executable permission changes fail;
- the official GTK plugin exits unsuccessfully;
- a bundled `libwayland-client.so*` cannot be removed;
- final AppImage inspection still finds the forbidden library.

The preparation step will report the failed boundary and path without silently falling back to
Tauri's mutable, globally cached plugin. Non-AppImage Linux targets may prepare the local plugin,
but the plugin is only consumed when linuxdeploy builds an AppImage.

## Testing

Implementation follows test-driven development.

1. A wrapper integration test copies the real wrapper next to a fake upstream plugin in a
   temporary directory. The fake deploys a forbidden Wayland client and an unrelated library.
   The test proves that delegation occurs, the forbidden library is removed, and the unrelated
   library remains.
2. Preparation tests use a real temporary filesystem and replace only the external download.
   They cover non-Linux no-op behavior, valid cache creation, cache reuse, corrupt download
   rejection, and replacement of an invalid cached plugin.
3. The Tauri hardening contract parses the configuration and requires both the project-local
   tools cache and preparation command.
4. The packaged Linux smoke extracts the real built AppImage and asserts that the forbidden
   library is absent.
5. Completion requires the focused tests, `vp check`, and `vp run typecheck` to pass.

## Rejected Alternatives

### Runtime `LD_PRELOAD`

Preloading the host library proves the diagnosis but is not a distributable design. Library paths
vary across distributions, and `LD_PRELOAD` would leak into the in-process server's agent,
terminal, and tool subprocesses.

### Disable WebKit Acceleration

The relevant WebKit environment switches did not resolve this failure. Globally disabling
accelerated rendering would also reduce performance for systems whose graphics stack works.

### Pin an Older WebKitGTK

Pinning an old browser engine in CI leaves local builds inconsistent, increases security and
maintenance risk, and treats the WebKit version rather than the mixed Wayland/Mesa dependency
closure.

### Post-process the Final AppImage

Repacking after `tauri build` would invalidate updater signatures or require duplicating Tauri's
signing flow. Mutating the AppDir before image creation preserves the existing release pipeline.

## Acceptance Criteria

- A T4Code AppImage contains no bundled `libwayland-client.so*`.
- The corrected artifact starts on the reported CachyOS Wayland/Intel environment without
  `LD_PRELOAD` or WebKit renderer overrides.
- `WebKitWebProcess` remains alive and the T4Code UI renders.
- Release builds sign the already-corrected AppImage through the existing Tauri updater path.
- macOS and Windows build behavior is unchanged.
- No global Tauri cache or host library is modified.
- Focused tests, `vp check`, and `vp run typecheck` pass.
