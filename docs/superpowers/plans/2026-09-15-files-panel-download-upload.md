# Files Panel Download and Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not start Task 1 until the design decision below is approved by the user** (AGENTS.md: a non-trivial architectural decision needs an approved design first).

**Goal:** The Files panel context menu gains **Download** (file or folder, saved into a folder the user picks) and **Upload Files…** (into the right-clicked folder, or the workspace root from the tree background), working for local and remote environments in desktop and browser modes.

**Architecture:** Bytes travel over two new authenticated HTTP routes on the server that owns the environment (`GET /api/transfers/{token}` streams a raw file or a zip archive of a folder; `POST /api/transfers/{token}?name=…` streams an upload into a folder). Tokens are short-lived HMAC-signed claims minted by two new typed RPC methods (`projects.createDownloadUrl`, read scope; `projects.createUploadUrl`, operate scope) that hold the workspace path lease exactly like `assets.createUrl`. Native pickers and local disk writes cross `DesktopBridge` through three new Tauri commands (`pick_files`, `download_to_folder`, `upload_file`); browser mode uses `<input type="file">`, `fetch`, and an anchor download. The Files panel adds two menu items to the pure menu model and wires them in `FileBrowserPanel`.

**Tech Stack:** Rust (Axum, Tokio, `zip` 8.6 streaming writer, `tokio-util` `SyncIoBridge`/`ReaderStream`, `reqwest` in the desktop host), Effect Schema contracts, React 19, Vitest via Vite+.

**Spec:** User request, 2026-09-15, verbatim: "In the Filemanager we need to add to the Right Mouse Button actions the 'Download' action that can download the folder or file selected. And also the 'Upload' action that is enabled only if a folder is selected in the file manager, if nothing is selected the upload must be enabled and allow upload a file in the root folder. The download should open a local folder selection dialog to put the downloads, the upload must use a file selector dialog. remember that we support remote servers."

**Assumptions (the user could not be asked mid-task):**
- "Selected" means the right-clicked row. The tree keeps no persistent selection (`FileBrowserPanel.tsx:665-667` only opens files), so a right-clicked directory row is "folder selected", the tree background is "nothing selected", and a right-clicked file row is neither. Upload is therefore disabled on file rows with a label that says why.
- Folder downloads are delivered as a `.zip` archive named after the folder.
- Uploads that collide with an existing entry are refused by the server and the UI asks to replace before retrying.

## Design decision — needs approval before implementation

**Problem.** There is no upload path today (`docs/plans/2026-08-18-os-file-drop-import-design.md` is unimplemented; `projects.writeFile` is text-only and overwrites silently, `service.rs:133-172`). Reads are capped at 1 MiB and reject binary (`projects.readFile`, `service.rs:91-131`); the asset route serves whole files up to 10 MiB and only image/html/pdf types. Header-authenticated raw `fetch` exists only for the primary environment (`apps/web/src/lib/runtime.ts:79-80`), and E2EE-only remote profiles have no HTTP authorization at all (`docs/architecture/remote.md:211-215`), while token-in-path asset URLs work everywhere.

**Option A (recommended): signed-token HTTP transfer routes.** RPC mints a 5-minute HMAC token bound to `{root, relative path or directory, expiry, max bytes}`; `GET /api/transfers/{token}` streams a file or a streaming zip; `POST /api/transfers/{token}?name=<file>&overwrite=0|1` streams an upload to a temp file then renames. Pros: works in browser and desktop, primary and remote, including E2EE-only profiles; true streaming with no 10 MiB cap; mirrors the existing `AssetAccess` pattern. Cons: a new write primitive reachable with a URL (mitigated: 5-minute TTL, bound to one directory, size cap, operate-scope RPC required to mint, plain-filename validation, no overwrite unless explicitly requested); a folder zip needs entry/byte budgets enforced by a pre-scan.

**Option B: chunked base64 over the existing RPC.** No new HTTP surface. Cons: 33 % inflation, competes with interactive WebSocket traffic, 16 KiB/64 KiB frame limits on E2EE, needs a new stream RPC for reads and writes, and the server would still have to reassemble archives. Rejected on performance.

**Option C: primary-environment-only with header auth.** Simplest, but excludes remote servers, which the user explicitly required. Rejected.

**Trust boundary change to record in living docs:** `docs/architecture/rpc-and-orchestration.md` (auth per route, path-lease holders) and `docs/architecture/remote.md` gain the transfer routes and the token policy.

## Global Constraints

- Contracts stay schema-only; new schemas live in `packages/contracts/src/transfer.ts`; RPC fixtures are regenerated with `vp run check:contracts` and committed.
- Token TTL `TRANSFER_TOKEN_TTL = 5 minutes`. Download limits `MAX_ARCHIVE_ENTRIES = 200_000`, `MAX_ARCHIVE_BYTES = 2 GiB` (uncompressed, enforced by pre-scan). Upload limit `MAX_UPLOAD_BYTES = 1 GiB` per file.
- Symlinks inside a downloaded folder are skipped, never followed. Ignored files (`.git`, `node_modules`) are included; the user downloads what the tree shows.
- Upload file names must be plain (no `/` or `\`, not `.`/`..`, at most 255 bytes). Collision without `overwrite=1` returns HTTP 409 with body `{"_tag":"TransferEntryExistsError"}`. Overwrite replaces atomically by rename; directories are never replaced.
- Uploads write `.<name>.bibcode-upload.part` next to the target and rename on completion; partial files are removed on failure.
- Every route is streaming: no `Vec<u8>` of the whole payload in the server or the desktop host.
- Desktop: native folder picker for the download destination, native file picker for uploads, disk writes and the HTTP transfer performed by the Rust host. Browser: `<input type="file" multiple>` and an anchor `download`; the browser chooses the destination.
- Menu items appear in all environments (not gated by `isPrimaryEnv`).
- `apps/web` change: `vercel-react-best-practices` and `UI.md` reviews required. Rust changes: `cargo fmt --all --check`, focused tests, Clippy with warnings denied for `bibcode-server` and `bibcode-desktop`.
- Update `docs/user/workspace-ui.md` (Files section), `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/remote.md`, and any `docs/testing/` runbook listing Files panel flows in the same change.

---

### Task 1: Transfer contracts and RPC registration

**Files:**
- Create: `packages/contracts/src/transfer.ts`, `packages/contracts/src/transfer.test.ts`
- Modify: `packages/contracts/src/rpc.ts` (`WS_METHODS` near line 349-362; `Rpc.make` block near line 720; group list near line 1487), `packages/contracts/src/index.ts` (export the new module the way `assets.ts` is exported)
- Modify: `apps/server/src/rpc/methods.rs` (`read_unary("projects.createDownloadUrl")`, `mutation_unary("projects.createUploadUrl")` next to lines 62 and 100), `apps/server/src/auth/scope.rs` (read list near line 22, operate list near line 85)
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts` if typed failures are enumerated by method there (check how `assets.createUrl` failures are listed)

**Interfaces:**

```ts
// packages/contracts/src/transfer.ts
export const ProjectCreateDownloadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
});
export const ProjectCreateDownloadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Finite,
  fileName: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "archive"]),
});
export const ProjectCreateUploadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativeDirectory: Schema.String.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)), // "" = workspace root
});
export const ProjectCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Finite,
  maxBytes: Schema.Finite,
});
export class ProjectTransferError extends Schema.TaggedError<ProjectTransferError>()("ProjectTransferError", {
  cwd: TrimmedNonEmptyString,
  relativePath: Schema.String,
  failure: Schema.Literals(["not_found", "outside_root", "not_configured", "operation_failed"]),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
// WS_METHODS.projectsCreateDownloadUrl = "projects.createDownloadUrl"
// WS_METHODS.projectsCreateUploadUrl = "projects.createUploadUrl"
```

Both RPCs use `error: Schema.Union([ProjectTransferError, WorkspaceUnavailableError, WorkspaceIdentityError])`, copying the remaining union members from `WsProjectsCreateEntryRpc` (`rpc.ts:720-728`).

- [ ] **Step 1: Write the failing contract tests**

`packages/contracts/src/transfer.test.ts`, following `assets.test.ts`:

```ts
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCreateDownloadUrlInput,
  ProjectCreateDownloadUrlResult,
  ProjectCreateUploadUrlInput,
  ProjectCreateUploadUrlResult,
  ProjectTransferError,
} from "./transfer.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeDownloadInput = Schema.decodeUnknownSync(ProjectCreateDownloadUrlInput);
const decodeDownloadResult = Schema.decodeUnknownSync(ProjectCreateDownloadUrlResult);
const decodeUploadInput = Schema.decodeUnknownSync(ProjectCreateUploadUrlInput);
const decodeUploadResult = Schema.decodeUnknownSync(ProjectCreateUploadUrlResult);

describe("transfer contracts", () => {
  it("registers both methods", () => {
    expect(WS_METHODS.projectsCreateDownloadUrl).toBe("projects.createDownloadUrl");
    expect(WS_METHODS.projectsCreateUploadUrl).toBe("projects.createUploadUrl");
  });

  it("decodes download input and result", () => {
    expect(decodeDownloadInput({ cwd: "/repo", relativePath: "src" })).toEqual({
      cwd: "/repo",
      relativePath: "src",
    });
    expect(
      decodeDownloadResult({
        relativeUrl: "/api/transfers/abc.def",
        expiresAt: 1_700_000_000_000,
        fileName: "src.zip",
        kind: "archive",
      }).kind,
    ).toBe("archive");
    expect(() => decodeDownloadInput({ cwd: "/repo", relativePath: "" })).toThrow();
  });

  it("allows an empty upload directory for the workspace root", () => {
    expect(decodeUploadInput({ cwd: "/repo", relativeDirectory: "" }).relativeDirectory).toBe("");
    expect(
      decodeUploadResult({ relativeUrl: "/api/transfers/x.y", expiresAt: 1, maxBytes: 1024 })
        .maxBytes,
    ).toBe(1024);
  });

  it("encodes the transfer error", () => {
    const error = new ProjectTransferError({
      cwd: "/repo",
      relativePath: "missing",
      failure: "not_found",
      message: "Entry was not found.",
    });
    expect(error._tag).toBe("ProjectTransferError");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node scripts/run-local-vp.mjs test run packages/contracts/src/transfer.test.ts
```

Expected: FAIL, `./transfer.ts` missing.

- [ ] **Step 3: Implement the contracts and registrations**

Create `transfer.ts` with the schemas from the Interfaces block (import `TrimmedNonEmptyString` from `./baseSchemas.ts` and `PROJECT_ENTRY_PATH_MAX_LENGTH` from `./project.ts`, exporting it there if it is not exported yet). In `rpc.ts` add the two `WS_METHODS` entries, two `Rpc.make` definitions (`WsProjectsCreateDownloadUrlRpc`, `WsProjectsCreateUploadUrlRpc`), and add both to the group list after `WsAssetsCreateUrlRpc`. Export the module from the package index. In `methods.rs` add `read_unary("projects.createDownloadUrl")` and `mutation_unary("projects.createUploadUrl")`; in `scope.rs` add `"projects.createDownloadUrl"` to the read arm and `"projects.createUploadUrl"` to the operate arm.

- [ ] **Step 4: Run the tests, parity, and fixtures**

```bash
node scripts/run-local-vp.mjs test run packages/contracts/src/transfer.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
vp run check:contracts
```

Expected: PASS; `check:contracts` regenerates `packages/contracts/fixtures/**` (new `typed-failures/projects__createDownloadUrl-*.json` and `projects__createUploadUrl-*.json`, manifest updates) and then passes its `git diff --exit-code` step only after the regenerated files are staged, so run it, then stage the fixture changes.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs
git commit -m "feat(contracts): add project transfer URL methods"
```

---

### Task 2: Server transfer access, archive streaming, and upload sink

**Files:**
- Create: `apps/server/src/transfer/mod.rs` (token issue/verify), `apps/server/src/transfer/archive.rs` (pre-scan + streaming zip), `apps/server/src/transfer/upload.rs` (streaming sink)
- Modify: `apps/server/src/lib.rs` (add `pub mod transfer;` next to `pub mod assets;`)
- Test: unit tests in each file

**Interfaces:**

```rust
// transfer/mod.rs
pub const TRANSFER_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
pub const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
#[derive(Clone)] pub struct TransferAccess { secret: Vec<u8>, ttl: Duration }
pub enum TransferClaims {
    Download { root: PathBuf, relative: String, expires_at: u64 },
    Upload { root: PathBuf, relative_dir: String, max_bytes: u64, expires_at: u64 },
}
pub struct IssuedTransferUrl { pub relative_url: String, pub expires_at: u64 }
impl TransferAccess {
    pub fn new(secret: Vec<u8>) -> Self;                     // uses TRANSFER_TOKEN_TTL
    pub fn with_ttl(secret: Vec<u8>, ttl: Duration) -> Self;
    pub fn issue_download(&self, root: &Path, relative: &str) -> Result<IssuedTransferUrl, TransferError>;
    pub fn issue_upload(&self, root: &Path, relative_dir: &str) -> Result<IssuedTransferUrl, TransferError>;
    pub fn verify(&self, token: &str) -> Option<TransferClaims>;  // None when invalid or expired
}
#[derive(Debug, thiserror::Error)] pub enum TransferError {
    #[error(transparent)] Workspace(#[from] WorkspaceError),
    #[error("transfer token encoding failed: {0}")] Encoding(#[from] serde_json::Error),
    #[error("archive exceeds {limit} entries")] TooManyEntries { limit: usize },
    #[error("archive exceeds {limit} bytes")] TooManyBytes { limit: u64 },
    #[error("upload exceeds {limit} bytes")] UploadTooLarge { limit: u64 },
    #[error("upload target already exists: {path}", path = .path.display())] EntryExists { path: PathBuf },
    #[error("invalid upload file name: {name}")] InvalidFileName { name: String },
}
// transfer/archive.rs
pub const MAX_ARCHIVE_ENTRIES: usize = 200_000;
pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub struct ArchivePlan { pub entries: usize, pub bytes: u64 }
pub async fn plan_archive(root: &Path) -> Result<ArchivePlan, TransferError>;
pub fn archive_body(root: PathBuf) -> axum::body::Body;   // streaming zip
// transfer/upload.rs
pub fn validate_upload_file_name(name: &str) -> Result<(), TransferError>;
pub async fn write_upload<S>(directory: &Path, name: &str, overwrite: bool, max_bytes: u64, body: S) -> Result<PathBuf, TransferError>
where S: futures_util::Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin;
```

Token format is identical to `AssetAccess::sign`/`verify` (`assets/mod.rs:220-249`): base64url JSON claims + `.` + base64url HMAC-SHA256.

- [ ] **Step 1: Write the failing tests**

In `transfer/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_token_round_trips_and_expires() {
        let access = TransferAccess::with_ttl(b"secret".to_vec(), Duration::from_secs(60));
        let issued = access.issue_download(Path::new("/repo"), "src/app.ts").unwrap();
        let token = issued.relative_url.rsplit('/').next().unwrap();
        match access.verify(token) {
            Some(TransferClaims::Download { root, relative, .. }) => {
                assert_eq!(root, PathBuf::from("/repo"));
                assert_eq!(relative, "src/app.ts");
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let expired = TransferAccess::with_ttl(b"secret".to_vec(), Duration::ZERO);
        let issued = expired.issue_download(Path::new("/repo"), "src").unwrap();
        std::thread::sleep(Duration::from_millis(2));
        assert!(expired.verify(issued.relative_url.rsplit('/').next().unwrap()).is_none());
    }

    #[test]
    fn upload_token_binds_directory_and_limit_and_rejects_tampering() {
        let access = TransferAccess::new(b"secret".to_vec());
        let issued = access.issue_upload(Path::new("/repo"), "").unwrap();
        let token = issued.relative_url.rsplit('/').next().unwrap().to_owned();
        match access.verify(&token) {
            Some(TransferClaims::Upload { relative_dir, max_bytes, .. }) => {
                assert_eq!(relative_dir, "");
                assert_eq!(max_bytes, MAX_UPLOAD_BYTES);
            }
            other => panic!("unexpected claims: {other:?}"),
        }
        let other = TransferAccess::new(b"other".to_vec());
        assert!(other.verify(&token).is_none());
        assert!(access.verify(&format!("{token}x")).is_none());
        assert!(issued.relative_url.starts_with("/api/transfers/"));
    }
}
```

In `transfer/archive.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[tokio::test]
    async fn plans_and_streams_a_zip_skipping_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("folder");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        std::fs::write(root.join("nested/b.bin"), [0u8, 1, 2]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a.txt"), root.join("link.txt")).unwrap();

        let plan = plan_archive(&root).await.unwrap();
        assert_eq!(plan.entries, 3); // a.txt, nested/, nested/b.bin
        assert_eq!(plan.bytes, 8);

        let body = archive_body(root.clone());
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.txt", "nested/", "nested/b.bin"]);
        let mut content = String::new();
        archive.by_name("a.txt").unwrap().read_to_string(&mut content).unwrap();
        assert_eq!(content, "hello");
    }

    #[tokio::test]
    async fn plan_rejects_oversized_trees() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("big"), vec![0u8; 16]).unwrap();
        let error = plan_archive_with_limits(temp.path(), 10, 8).await.unwrap_err();
        assert!(matches!(error, TransferError::TooManyBytes { limit: 8 }));
        for index in 0..3 {
            std::fs::write(temp.path().join(format!("f{index}")), b"").unwrap();
        }
        let error = plan_archive_with_limits(temp.path(), 2, u64::MAX).await.unwrap_err();
        assert!(matches!(error, TransferError::TooManyEntries { limit: 2 }));
    }
}
```

In `transfer/upload.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn body(chunks: &[&[u8]]) -> impl futures_util::Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin {
        stream::iter(chunks.iter().map(|chunk| Ok(bytes::Bytes::copy_from_slice(chunk))).collect::<Vec<_>>())
    }

    #[test]
    fn validates_plain_file_names() {
        assert!(validate_upload_file_name("report.pdf").is_ok());
        for bad in ["", ".", "..", "a/b", "a\\b", &"x".repeat(256)] {
            assert!(matches!(validate_upload_file_name(bad), Err(TransferError::InvalidFileName { .. })), "{bad}");
        }
    }

    #[tokio::test]
    async fn writes_atomically_refuses_collisions_and_overwrites_on_request() {
        let temp = tempfile::tempdir().unwrap();
        let written = write_upload(temp.path(), "a.txt", false, 1024, body(&[b"hel", b"lo"])).await.unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");
        assert!(std::fs::read_dir(temp.path()).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().ends_with(".part")));

        let error = write_upload(temp.path(), "a.txt", false, 1024, body(&[b"x"])).await.unwrap_err();
        assert!(matches!(error, TransferError::EntryExists { .. }));
        assert_eq!(std::fs::read(&written).unwrap(), b"hello");

        write_upload(temp.path(), "a.txt", true, 1024, body(&[b"new"])).await.unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"new");
    }

    #[tokio::test]
    async fn enforces_the_byte_limit_and_removes_partials() {
        let temp = tempfile::tempdir().unwrap();
        let error = write_upload(temp.path(), "big.bin", false, 4, body(&[b"12345"])).await.unwrap_err();
        assert!(matches!(error, TransferError::UploadTooLarge { limit: 4 }));
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn never_replaces_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("dir")).unwrap();
        let error = write_upload(temp.path(), "dir", true, 1024, body(&[b"x"])).await.unwrap_err();
        assert!(matches!(error, TransferError::EntryExists { .. }));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p bibcode-server --lib -j 2 transfer::
```

Expected: compile error, module missing.

- [ ] **Step 3: Implement `transfer/mod.rs`**

```rust
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::workspace::error::WorkspaceError;

pub mod archive;
pub mod upload;

pub const TRANSFER_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);
pub const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const TRANSFER_URL_PREFIX: &str = "/api/transfers/";

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error("transfer token encoding failed: {0}")]
    Encoding(#[from] serde_json::Error),
    #[error("archive exceeds {limit} entries")]
    TooManyEntries { limit: usize },
    #[error("archive exceeds {limit} bytes")]
    TooManyBytes { limit: u64 },
    #[error("upload exceeds {limit} bytes")]
    UploadTooLarge { limit: u64 },
    #[error("upload target already exists: {path}", path = .path.display())]
    EntryExists { path: PathBuf },
    #[error("invalid upload file name: {name}")]
    InvalidFileName { name: String },
    #[error("transfer operation '{operation}' failed at {path}: {source}", path = .path.display())]
    Operation { operation: &'static str, path: PathBuf, #[source] source: std::io::Error },
}

impl TransferError {
    pub(crate) fn operation(operation: &'static str, path: &Path, source: std::io::Error) -> Self {
        Self::Operation { operation, path: path.to_path_buf(), source }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TransferClaims {
    Download { root: PathBuf, relative: String, expires_at: u64 },
    Upload { root: PathBuf, relative_dir: String, max_bytes: u64, expires_at: u64 },
}

impl TransferClaims {
    fn expires_at(&self) -> u64 {
        match self {
            Self::Download { expires_at, .. } | Self::Upload { expires_at, .. } => *expires_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedTransferUrl {
    pub relative_url: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct TransferAccess {
    secret: Vec<u8>,
    ttl: Duration,
}

impl TransferAccess {
    pub fn new(secret: Vec<u8>) -> Self {
        Self::with_ttl(secret, TRANSFER_TOKEN_TTL)
    }

    pub fn with_ttl(secret: Vec<u8>, ttl: Duration) -> Self {
        Self { secret, ttl }
    }

    pub fn issue_download(&self, root: &Path, relative: &str) -> Result<IssuedTransferUrl, TransferError> {
        self.issue(TransferClaims::Download {
            root: root.to_path_buf(),
            relative: relative.to_owned(),
            expires_at: self.expiry(),
        })
    }

    pub fn issue_upload(&self, root: &Path, relative_dir: &str) -> Result<IssuedTransferUrl, TransferError> {
        self.issue(TransferClaims::Upload {
            root: root.to_path_buf(),
            relative_dir: relative_dir.to_owned(),
            max_bytes: MAX_UPLOAD_BYTES,
            expires_at: self.expiry(),
        })
    }

    pub fn verify(&self, token: &str) -> Option<TransferClaims> {
        let (payload, signature) = token.split_once('.')?;
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(signature).ok()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).ok()?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature).ok()?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
        let claims: TransferClaims = serde_json::from_slice(&bytes).ok()?;
        (claims.expires_at() > now_millis()).then_some(claims)
    }

    fn issue(&self, claims: TransferClaims) -> Result<IssuedTransferUrl, TransferError> {
        let expires_at = claims.expires_at();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC accepts arbitrary key lengths");
        mac.update(payload.as_bytes());
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        Ok(IssuedTransferUrl { relative_url: format!("{TRANSFER_URL_PREFIX}{payload}.{signature}"), expires_at })
    }

    fn expiry(&self) -> u64 {
        now_millis().saturating_add(u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX))
    }
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
```

Match the `hmac`, `sha2`, `base64`, and `thiserror` import forms used in `assets/mod.rs`; the crate names are already dependencies of `bibcode-server`.

- [ ] **Step 4: Implement `transfer/archive.rs`**

```rust
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use axum::body::Body;
use tokio_util::io::{ReaderStream, SyncIoBridge};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::TransferError;

pub const MAX_ARCHIVE_ENTRIES: usize = 200_000;
pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchivePlan {
    pub entries: usize,
    pub bytes: u64,
}

pub async fn plan_archive(root: &Path) -> Result<ArchivePlan, TransferError> {
    plan_archive_with_limits(root, MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_BYTES).await
}

pub async fn plan_archive_with_limits(root: &Path, max_entries: usize, max_bytes: u64) -> Result<ArchivePlan, TransferError> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut plan = ArchivePlan { entries: 0, bytes: 0 };
        let mut stack = vec![root.clone()];
        while let Some(directory) = stack.pop() {
            let read = std::fs::read_dir(&directory).map_err(|error| TransferError::operation("read-dir", &directory, error))?;
            for entry in read {
                let entry = entry.map_err(|error| TransferError::operation("read-dir-entry", &directory, error))?;
                let path = entry.path();
                let metadata = std::fs::symlink_metadata(&path).map_err(|error| TransferError::operation("stat", &path, error))?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                plan.entries += 1;
                if plan.entries > max_entries {
                    return Err(TransferError::TooManyEntries { limit: max_entries });
                }
                if metadata.is_dir() {
                    stack.push(path);
                } else {
                    plan.bytes = plan.bytes.saturating_add(metadata.len());
                    if plan.bytes > max_bytes {
                        return Err(TransferError::TooManyBytes { limit: max_bytes });
                    }
                }
            }
        }
        Ok(plan)
    })
    .await
    .map_err(|error| TransferError::operation("archive-plan", &root_for_error(), io::Error::other(error)))?
}

fn root_for_error() -> PathBuf {
    PathBuf::from("<archive>")
}

/// Streams a zip of `root`'s contents. Entry and byte limits are enforced by `plan_archive`
/// before the response starts; I/O failures during streaming truncate the response and are logged.
pub fn archive_body(root: PathBuf) -> Body {
    let (writer, reader) = tokio::io::duplex(64 * 1024);
    tokio::task::spawn_blocking(move || {
        if let Err(error) = write_archive(&root, SyncIoBridge::new(writer)) {
            tracing::warn!(root = %root.display(), %error, "folder download stream failed");
        }
    });
    Body::from_stream(ReaderStream::new(reader))
}

fn write_archive<W: Write>(root: &Path, sink: W) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(sink);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut children: Vec<_> = std::fs::read_dir(&directory)?.collect::<Result<_, _>>()?;
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children {
            let path = child.path();
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            let name = relative.to_string_lossy().replace('\\', "/");
            if metadata.is_dir() {
                zip.add_directory(format!("{name}/"), options)?;
                stack.push(path);
            } else {
                zip.start_file(name, options)?;
                let mut file = File::open(&path)?;
                io::copy(&mut file, &mut zip)?;
            }
        }
    }
    zip.finish()?;
    Ok(())
}
```

If `ZipWriter::new_stream` rejects `large_file(true)` or requires it, the archive test in Step 1 fails with the crate's error message; keep whichever option combination makes the round-trip test pass (both are valid streaming configurations in `zip` 8.6, see `~/.cargo/registry/src/*/zip-8.6.0/src/write.rs:2006`).

- [ ] **Step 5: Implement `transfer/upload.rs`**

```rust
use std::path::{Path, PathBuf};

use futures_util::{Stream, StreamExt};
use tokio::io::AsyncWriteExt;

use super::TransferError;

pub fn validate_upload_file_name(name: &str) -> Result<(), TransferError> {
    let valid = !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0']);
    if valid { Ok(()) } else { Err(TransferError::InvalidFileName { name: name.to_owned() }) }
}

pub async fn write_upload<S>(directory: &Path, name: &str, overwrite: bool, max_bytes: u64, mut body: S) -> Result<PathBuf, TransferError>
where
    S: Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin,
{
    validate_upload_file_name(name)?;
    let target = directory.join(name);
    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) if metadata.is_dir() || !overwrite => {
            return Err(TransferError::EntryExists { path: target });
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(TransferError::operation("stat", &target, error)),
    }
    let partial = directory.join(format!(".{name}.bibcode-upload.part"));
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| TransferError::operation("create", &partial, error))?;
    let mut written: u64 = 0;
    let outcome: Result<(), TransferError> = async {
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|error| TransferError::operation("read-body", &partial, std::io::Error::other(error)))?;
            written = written.saturating_add(chunk.len() as u64);
            if written > max_bytes {
                return Err(TransferError::UploadTooLarge { limit: max_bytes });
            }
            file.write_all(&chunk).await.map_err(|error| TransferError::operation("write", &partial, error))?;
        }
        file.flush().await.map_err(|error| TransferError::operation("flush", &partial, error))?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    tokio::fs::rename(&partial, &target).await.map_err(|error| TransferError::operation("rename", &partial, error))?;
    Ok(target)
}
```

Add `pub mod transfer;` to `apps/server/src/lib.rs`. Confirm `bytes` is a dependency of `bibcode-server` (axum re-exports it as `axum::body::Bytes`; use that path if `bytes` is not a direct dependency).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cargo test -p bibcode-server --lib -j 2 transfer::
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/transfer apps/server/src/lib.rs
git commit -m "feat(server): add signed transfer tokens with streaming archive and upload sinks"
```

---

### Task 3: RPC handlers and HTTP routes

**Files:**
- Modify: `apps/server/src/workspace/rpc.rs` (dispatch arms next to `"assets.createUrl"` at line 574-577; new `handle_create_download_url`, `handle_create_upload_url`; `dependencies.transfer_access: Option<TransferAccess>` next to `asset_access`; make `invalidate_index` `pub(crate)`)
- Modify: `apps/server/src/production/http_routes.rs` (routes near line 205; new handler types `TransferDownloadHandler`, `TransferUploadHandler`; `HttpRoutesState` fields and `new` signature; two handlers)
- Create: `apps/server/src/production/transfer_routes.rs` (production handler constructors, unit-testable without the full runtime)
- Modify: `apps/server/src/production/mod.rs`, `apps/server/src/lifecycle.rs` (both `HttpRoutesState::new` call sites near lines 485 and 547; construct `TransferAccess` with the same secret `AssetAccess::new` receives; wire handlers)
- Test: `apps/server/tests/production_http_routes.rs` (pattern at lines 205-289), `apps/server/tests/workspace_rpc.rs` (pattern at lines 1961-2124)

**Interfaces:**

```rust
// http_routes.rs
pub struct TransferDownloadHttpResponse { pub file_name: String, pub content_type: &'static str, pub body: Body }
pub enum TransferUploadHttpOutcome { Created { relative_path: String }, Exists, TooLarge { limit: u64 } }
pub type TransferDownloadHandler = Arc<dyn Fn(String, RouteContext) -> BoxFuture<Result<TransferDownloadHttpResponse, HttpRouteError>> + Send + Sync>;
pub type TransferUploadHandler = Arc<dyn Fn(String, String, bool, Body, RouteContext) -> BoxFuture<Result<TransferUploadHttpOutcome, HttpRouteError>> + Send + Sync>;
// routes
// .route("/api/transfers/{token}", get(transfer_download).post(transfer_upload))
```

- [ ] **Step 1: Write the failing tests**

In `apps/server/tests/workspace_rpc.rs`, following the `assets.createUrl` test near line 1961:

```rust
#[tokio::test]
async fn transfer_urls_are_minted_for_files_folders_and_root_and_reject_escapes() {
    let temp = TempDir::new().expect("root");
    let root = temp.path().to_path_buf();
    let rpc = WorkspaceRpc::with_dependencies(
        WorkspaceService::default(),
        WorkspaceRpcDependencies {
            transfer_access: Some(bibcode_server::transfer::TransferAccess::new(b"secret".to_vec())),
            ..WorkspaceRpcDependencies::default()
        },
    );
    let unary = |method: &'static str, payload: serde_json::Value| rpc.handle(method, payload);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/app.ts"), "x").unwrap();
    let cwd = path_string(&root);

    let file = unary("projects.createDownloadUrl", json!({"cwd": cwd, "relativePath": "src/app.ts"})).await.unwrap();
    assert_eq!(file["kind"], "file");
    assert_eq!(file["fileName"], "app.ts");
    assert!(file["relativeUrl"].as_str().unwrap().starts_with("/api/transfers/"));

    let folder = unary("projects.createDownloadUrl", json!({"cwd": cwd, "relativePath": "src"})).await.unwrap();
    assert_eq!(folder["kind"], "archive");
    assert_eq!(folder["fileName"], "src.zip");

    let upload_root = unary("projects.createUploadUrl", json!({"cwd": cwd, "relativeDirectory": ""})).await.unwrap();
    assert_eq!(upload_root["maxBytes"], 1024 * 1024 * 1024);
    let upload_dir = unary("projects.createUploadUrl", json!({"cwd": cwd, "relativeDirectory": "src"})).await.unwrap();
    assert!(upload_dir["relativeUrl"].as_str().unwrap().starts_with("/api/transfers/"));

    let escape = unary("projects.createDownloadUrl", json!({"cwd": cwd, "relativePath": "../etc"})).await.unwrap_err();
    assert_eq!(escape["_tag"], "ProjectTransferError");
    assert_eq!(escape["failure"], "outside_root");
    let missing = unary("projects.createDownloadUrl", json!({"cwd": cwd, "relativePath": "nope"})).await.unwrap_err();
    assert_eq!(missing["failure"], "not_found");
    let file_as_dir = unary("projects.createUploadUrl", json!({"cwd": cwd, "relativeDirectory": "src/app.ts"})).await.unwrap_err();
    assert_eq!(file_as_dir["failure"], "not_found");
}
```

In `apps/server/tests/production_http_routes.rs`, following the asset route test pattern:

```rust
#[tokio::test]
async fn transfer_routes_stream_downloads_and_accept_uploads() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_path_buf();
    let access = bibcode_server::transfer::TransferAccess::new(b"secret".to_vec());
    let mut state = state_with_json_recorder(Arc::new(Mutex::new(Vec::new())));
    state.transfer_download = bibcode_server::production::transfer_routes::download_handler(access.clone());
    state.transfer_upload = bibcode_server::production::transfer_routes::upload_handler(
        access.clone(),
        Arc::new(|_root| Box::pin(async {})),
    );
    let app = add_routes(Router::new()).with_state(TestState(state));
    std::fs::create_dir_all(root.join("dir")).unwrap();
    std::fs::write(root.join("dir/a.txt"), "hello").unwrap();

    let file_url = access.issue_download(&root, "dir/a.txt").unwrap().relative_url;
    let response = app.clone().oneshot(Request::get(&file_url).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-disposition"], "attachment; filename=\"a.txt\"");
    assert_eq!(axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap(), "hello");

    let folder_url = access.issue_download(&root, "dir").unwrap().relative_url;
    let response = app.clone().oneshot(Request::get(&folder_url).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/zip");
    assert_eq!(response.headers()["content-disposition"], "attachment; filename=\"dir.zip\"");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(bytes.starts_with(b"PK"));

    let upload_url = access.issue_upload(&root, "dir").unwrap().relative_url;
    let response = app.clone().oneshot(Request::post(format!("{upload_url}?name=b.txt")).body(Body::from("new")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(std::fs::read(root.join("dir/b.txt")).unwrap(), b"new");

    let response = app.clone().oneshot(Request::post(format!("{upload_url}?name=b.txt")).body(Body::from("again")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = app.clone().oneshot(Request::post(format!("{upload_url}?name=b.txt&overwrite=1")).body(Body::from("again")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(std::fs::read(root.join("dir/b.txt")).unwrap(), b"again");

    let response = app.clone().oneshot(Request::post(format!("{upload_url}?name=../x")).body(Body::from("x")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app.clone().oneshot(Request::get("/api/transfers/not.a.token").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = app.oneshot(Request::post(format!("{file_url}?name=z")).body(Body::from("x")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND); // a download token cannot upload
}
```

`state_with_json_recorder`, `add_routes`, and `TestState` are the helpers the existing `assets_and_mcp_use_native_handlers_with_protocol_headers` test in that file already uses (`production_http_routes.rs:261-300, 364`); the two transfer handlers come from the module created in Step 5.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p bibcode-server -j 2 --test workspace_rpc transfer_urls
cargo test -p bibcode-server -j 2 --test production_http_routes transfer_routes
```

Expected: compile errors for the missing handlers and state fields.

- [ ] **Step 3: Implement the RPC handlers**

In `workspace/rpc.rs` add the dispatch arms:

```rust
            "projects.createDownloadUrl" => {
                let input: ProjectCreateDownloadUrlInput = decode(payload)?;
                self.handle_create_download_url(input).await
            }
            "projects.createUploadUrl" => {
                let input: ProjectCreateUploadUrlInput = decode(payload)?;
                self.handle_create_upload_url(input).await
            }
```

with input structs (`serde` `rename_all = "camelCase"`) `ProjectCreateDownloadUrlInput { cwd: String, relative_path: String }` and `ProjectCreateUploadUrlInput { cwd: String, relative_directory: String }`, and handlers:

```rust
    async fn handle_create_download_url(&self, input: ProjectCreateDownloadUrlInput) -> Result<Value, Value> {
        let access = self.transfer_access()?;
        let _admission = self.acquire_path(&input.cwd).await?;
        let root = paths::normalize_root(Path::new(&input.cwd), false)
            .await
            .map_err(|error| transfer_wire(&input.cwd, &input.relative_path, &error))?;
        let (target, relative) = paths::resolve_relative(&root, &input.relative_path)
            .map_err(|error| transfer_wire(&input.cwd, &input.relative_path, &error))?;
        let canonical = paths::canonical_existing_within(&root, &target)
            .await
            .map_err(|error| transfer_wire(&input.cwd, &input.relative_path, &error))?;
        let metadata = tokio::fs::metadata(&canonical)
            .await
            .map_err(|error| transfer_wire(&input.cwd, &input.relative_path, &WorkspaceError::operation("stat", &canonical, error)))?;
        let name = canonical.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "download".to_owned());
        let (kind, file_name) = if metadata.is_dir() { ("archive", format!("{name}.zip")) } else { ("file", name) };
        let issued = access
            .issue_download(&root, &relative)
            .map_err(|error| transfer_error_wire(&input.cwd, &input.relative_path, &error))?;
        Ok(json!({ "relativeUrl": issued.relative_url, "expiresAt": issued.expires_at, "fileName": file_name, "kind": kind }))
    }

    async fn handle_create_upload_url(&self, input: ProjectCreateUploadUrlInput) -> Result<Value, Value> {
        let access = self.transfer_access()?;
        let _admission = self.acquire_path(&input.cwd).await?;
        let root = paths::normalize_root(Path::new(&input.cwd), false)
            .await
            .map_err(|error| transfer_wire(&input.cwd, &input.relative_directory, &error))?;
        let relative = if input.relative_directory.is_empty() {
            String::new()
        } else {
            let (target, relative) = paths::resolve_relative(&root, &input.relative_directory)
                .map_err(|error| transfer_wire(&input.cwd, &input.relative_directory, &error))?;
            let canonical = paths::canonical_existing_within(&root, &target)
                .await
                .map_err(|error| transfer_wire(&input.cwd, &input.relative_directory, &error))?;
            if !canonical.is_dir() {
                return Err(json!({ "_tag": "ProjectTransferError", "cwd": input.cwd, "relativePath": input.relative_directory, "failure": "not_found", "message": "Upload target is not a folder." }));
            }
            relative
        };
        let issued = access
            .issue_upload(&root, &relative)
            .map_err(|error| transfer_error_wire(&input.cwd, &input.relative_directory, &error))?;
        Ok(json!({ "relativeUrl": issued.relative_url, "expiresAt": issued.expires_at, "maxBytes": crate::transfer::MAX_UPLOAD_BYTES }))
    }

    fn transfer_access(&self) -> Result<&TransferAccess, Value> {
        self.dependencies.transfer_access.as_ref().ok_or_else(|| json!({ "_tag": "ProjectTransferError", "cwd": "", "relativePath": "", "failure": "not_configured", "message": "File transfers are not configured on this server." }))
    }
```

`transfer_wire` maps `WorkspaceError::PathOutsideRoot | ResolvedPathOutsideRoot` → `"outside_root"`, `NotFound | Operation { source.kind() == NotFound }` → `"not_found"`, everything else → `"operation_failed"`, always with `"_tag": "ProjectTransferError"`, `cwd`, `relativePath`, and `message: error.to_string()`. `transfer_error_wire` unwraps `TransferError::Workspace` to `transfer_wire` and maps the rest to `"operation_failed"`. Add `transfer_access: Option<TransferAccess>` to `WorkspaceRpcDependencies` (`workspace/rpc.rs:59-64`) next to `asset_access`; Step 5 fills it. Make `invalidate_index` `pub(crate)` so the upload callback can call it.

- [ ] **Step 4: Implement the HTTP routes**

In `http_routes.rs` add the types from the Interfaces block, two fields on `HttpRoutesState` (`transfer_download`, `transfer_upload`) with matching `new` parameters, the route `.route("/api/transfers/{token}", get(transfer_download).post(transfer_upload))`, and:

```rust
async fn transfer_download(State(state): State<HttpRoutesState>, Path(token): Path<String>, request: Request) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, _) = request.into_parts();
    let context = RouteContext { headers: parts.headers, uri: parts.uri, cancellation };
    match (state.transfer_download)(token, context).await {
        Ok(download) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, download.content_type)
            .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", download.file_name.replace('"', "")))
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-content-type-options", "nosniff")
            .body(download.body)
            .unwrap_or_else(|_| internal_error()),
        Err(error) => error.into_response(),
    }
}

async fn transfer_upload(State(state): State<HttpRoutesState>, Path(token): Path<String>, request: Request) -> Response {
    let cancellation = CancellationToken::new();
    let _guard = CancellationGuard(cancellation.clone());
    let (parts, body) = request.into_parts();
    let query: std::collections::HashMap<String, String> = parts
        .uri
        .query()
        .map(|query| url::form_urlencoded::parse(query.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let Some(name) = query.get("name").cloned() else {
        return bad_request("Query parameter 'name' is required.");
    };
    let overwrite = query.get("overwrite").is_some_and(|value| value == "1" || value == "true");
    let context = RouteContext { headers: parts.headers, uri: parts.uri, cancellation };
    match (state.transfer_upload)(token, name, overwrite, body, context).await {
        Ok(TransferUploadHttpOutcome::Created { relative_path }) => (StatusCode::CREATED, axum::Json(json!({ "relativePath": relative_path }))).into_response(),
        Ok(TransferUploadHttpOutcome::Exists) => (StatusCode::CONFLICT, axum::Json(json!({ "_tag": "TransferEntryExistsError" }))).into_response(),
        Ok(TransferUploadHttpOutcome::TooLarge { limit }) => (StatusCode::PAYLOAD_TOO_LARGE, axum::Json(json!({ "_tag": "TransferTooLargeError", "limit": limit }))).into_response(),
        Err(error) => error.into_response(),
    }
}
```

If `url` is not a `bibcode-server` dependency, parse the query with `axum::extract::Query<HashMap<String, String>>` instead.

- [ ] **Step 5: Build the production handlers in `apps/server/src/production/transfer_routes.rs` and wire them in `lifecycle.rs`**

Create `apps/server/src/production/transfer_routes.rs` (add `pub mod transfer_routes;` to `apps/server/src/production/mod.rs`) exporting:

```rust
pub type UploadedCallback = Arc<dyn Fn(PathBuf) -> BoxFuture<()> + Send + Sync>;
pub fn download_handler(access: TransferAccess) -> TransferDownloadHandler;
pub fn upload_handler(access: TransferAccess, on_uploaded: UploadedCallback) -> TransferUploadHandler;
```

with these bodies (imports: `crate::production::http_routes::{BoxFuture, HttpRouteError, TransferDownloadHandler, TransferDownloadHttpResponse, TransferUploadHandler, TransferUploadHttpOutcome}`, `crate::transfer::{self, TransferAccess, TransferClaims}`, `crate::workspace::paths`):

```rust
pub fn download_handler(access: TransferAccess) -> TransferDownloadHandler {
    Arc::new(move |token, _context| {
            let access = access.clone();
            Box::pin(async move {
                let Some(TransferClaims::Download { root, relative, .. }) = access.verify(&token) else {
                    return Err(HttpRouteError::not_found());
                };
                let (target, _) = paths::resolve_relative(&root, &relative).map_err(|_| HttpRouteError::not_found())?;
                let canonical = paths::canonical_existing_within(&root, &target).await.map_err(|_| HttpRouteError::not_found())?;
                let metadata = tokio::fs::metadata(&canonical).await.map_err(|_| HttpRouteError::not_found())?;
                let name = canonical.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "download".to_owned());
                if metadata.is_dir() {
                    match transfer::archive::plan_archive(&canonical).await {
                        Ok(_) => {}
                        Err(transfer::TransferError::TooManyEntries { .. } | transfer::TransferError::TooManyBytes { .. }) => {
                            return Err(HttpRouteError::payload_too_large("Folder is too large to download as an archive."));
                        }
                        Err(_) => return Err(HttpRouteError::not_found()),
                    }
                    Ok(TransferDownloadHttpResponse { file_name: format!("{name}.zip"), content_type: "application/zip", body: transfer::archive::archive_body(canonical) })
                } else {
                    let file = tokio::fs::File::open(&canonical).await.map_err(|_| HttpRouteError::not_found())?;
                    Ok(TransferDownloadHttpResponse { file_name: name, content_type: "application/octet-stream", body: Body::from_stream(tokio_util::io::ReaderStream::new(file)) })
                }
            }) as BoxFuture<_>
        })
}

pub fn upload_handler(access: TransferAccess, on_uploaded: UploadedCallback) -> TransferUploadHandler {
    Arc::new(move |token, name, overwrite, body, _context| {
            let access = access.clone();
            let on_uploaded = on_uploaded.clone();
            Box::pin(async move {
                let Some(TransferClaims::Upload { root, relative_dir, max_bytes, .. }) = access.verify(&token) else {
                    return Err(HttpRouteError::not_found());
                };
                let directory = if relative_dir.is_empty() {
                    root.clone()
                } else {
                    let (target, _) = paths::resolve_relative(&root, &relative_dir).map_err(|_| HttpRouteError::not_found())?;
                    paths::canonical_existing_within(&root, &target).await.map_err(|_| HttpRouteError::not_found())?
                };
                if transfer::upload::validate_upload_file_name(&name).is_err() {
                    return Err(HttpRouteError::bad_request("Upload file name must be a plain file name."));
                }
                match transfer::upload::write_upload(&directory, &name, overwrite, max_bytes, body.into_data_stream()).await {
                    Ok(written) => {
                        on_uploaded(root.clone()).await;
                        let relative = written.strip_prefix(&root).map(paths::to_posix).unwrap_or_else(|_| name.clone());
                        Ok(TransferUploadHttpOutcome::Created { relative_path: relative })
                    }
                    Err(transfer::TransferError::EntryExists { .. }) => Ok(TransferUploadHttpOutcome::Exists),
                    Err(transfer::TransferError::UploadTooLarge { limit }) => Ok(TransferUploadHttpOutcome::TooLarge { limit }),
                    Err(error) => Err(HttpRouteError::internal(error.to_string())),
                }
            }) as BoxFuture<_>
        })
}
```

In `lifecycle.rs`, next to the `assets` handler construction at both `HttpRoutesState::new` call sites, build `let transfer_access = TransferAccess::new(<the same secret bytes AssetAccess::new receives>);`, then `transfer_routes::download_handler(transfer_access.clone())` and `transfer_routes::upload_handler(transfer_access.clone(), Arc::new({ let workspace = workspace_rpc.clone(); move |root| { let workspace = workspace.clone(); Box::pin(async move { workspace.invalidate_index(&root.to_string_lossy()).await; }) } }))`, and pass the same `transfer_access` into `WorkspaceRpcDependencies { transfer_access: Some(...) }`.

Use the `HttpRouteError` constructors that already exist in `http_routes.rs` (find them with `rg -n "impl HttpRouteError" -A20 apps/server/src/production/http_routes.rs`); add `payload_too_large` if absent, following `bad_request`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cargo test -p bibcode-server -j 2 --test workspace_rpc transfer_urls
cargo test -p bibcode-server -j 2 --test production_http_routes transfer_routes
cargo test -p bibcode-server -j 2 --test production_http_routes
```

Expected: PASS, including the existing route tests.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/workspace/rpc.rs apps/server/src/production/http_routes.rs apps/server/src/production/transfer_routes.rs apps/server/src/production/mod.rs apps/server/src/lifecycle.rs apps/server/tests/workspace_rpc.rs apps/server/tests/production_http_routes.rs
git commit -m "feat(server): mint transfer URLs and serve streaming download and upload routes"
```

---

### Task 4: Desktop bridge commands for native pickers and host-side transfers

**Files:**
- Modify: `apps/desktop/src-tauri/src/bridge.rs` (new commands after `desktop_bridge_save_diagnostic_logs` at line 1563-1592; register in the command lists at lines 3402-3403 and 3636; async assertion list near line 1954)
- Modify: `apps/desktop/src-tauri/src/lib.rs:48-49` and `:197-198` (register the three commands next to `desktop_bridge_pick_folder`)
- Modify: `packages/contracts/src/ipc.ts:1258-1267` (`DesktopBridge` optional methods) and `apps/web/src/tauriDesktopBridge.ts:569-573` (adapters)
- Test: Rust unit tests in `bridge.rs` for the pure helpers; `apps/web/src/tauriDesktopBridge.test.ts` (existing adapter tests) for the new adapters

**Interfaces:**

```ts
// ipc.ts DesktopBridge
pickFiles?: (options?: { title?: string }) => Promise<readonly string[]>;
downloadToFolder?: (input: { url: string; directory: string; fileName: string }) => Promise<string>;
uploadFile?: (input: { url: string; path: string }) => Promise<{ status: number; body: string }>;
```

```rust
#[tauri::command] pub async fn desktop_bridge_pick_files(app: AppHandle<DesktopRuntime>, options: Option<Value>) -> Result<Vec<String>, String>;
#[tauri::command] pub async fn desktop_bridge_download_to_folder(url: String, directory: String, file_name: String) -> Result<String, String>;
#[tauri::command] pub async fn desktop_bridge_upload_file(url: String, path: String) -> Result<UploadFileOutcome, String>; // { status: u16, body: String }
fn validate_transfer_url(url: &str) -> Result<reqwest::Url, String>;              // http/https only
fn validate_download_file_name(name: &str) -> Result<(), String>;                 // plain name, no separators
fn unique_destination(directory: &Path, file_name: &str) -> PathBuf;              // "name (2).ext" on collision
```

- [ ] **Step 1: Write the failing Rust tests**

```rust
    #[test]
    fn transfer_urls_must_be_http_or_https() {
        assert!(validate_transfer_url("https://host:3773/api/transfers/a.b").is_ok());
        assert!(validate_transfer_url("http://127.0.0.1:3773/api/transfers/a.b").is_ok());
        assert!(validate_transfer_url("file:///etc/passwd").is_err());
        assert!(validate_transfer_url("not a url").is_err());
    }

    #[test]
    fn download_file_names_must_be_plain() {
        assert!(validate_download_file_name("src.zip").is_ok());
        for bad in ["", ".", "..", "a/b", "a\\b"] {
            assert!(validate_download_file_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn unique_destination_suffixes_on_collision() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(unique_destination(temp.path(), "a.txt"), temp.path().join("a.txt"));
        std::fs::write(temp.path().join("a.txt"), b"").unwrap();
        assert_eq!(unique_destination(temp.path(), "a.txt"), temp.path().join("a (2).txt"));
        std::fs::write(temp.path().join("a (2).txt"), b"").unwrap();
        assert_eq!(unique_destination(temp.path(), "a.txt"), temp.path().join("a (3).txt"));
        std::fs::write(temp.path().join("src.zip"), b"").unwrap();
        assert_eq!(unique_destination(temp.path(), "src.zip"), temp.path().join("src (2).zip"));
        assert_eq!(unique_destination(temp.path(), "Makefile"), temp.path().join("Makefile"));
    }

The streaming `download_to_folder` and `upload_file` commands need a live HTTP peer; the desktop crate has no listener fixture, so they are verified end to end in Task 7 Step 6 rather than by a unit test.
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p bibcode-desktop -j 2 transfer_urls download_file_names unique_destination
```

Expected: compile errors for the missing functions.

- [ ] **Step 3: Implement the commands**

```rust
fn validate_transfer_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| bridge_error("Transfer URL is invalid", error))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("Transfer URL scheme '{other}' is not allowed.")),
    }
}

fn validate_download_file_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty() && name != "." && name != ".." && name.len() <= 255 && !name.contains(['/', '\\', '\0']);
    if plain { Ok(()) } else { Err("Download file name must be a plain file name.".to_owned()) }
}

fn unique_destination(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_owned(), format!(".{extension}")),
        _ => (file_name.to_owned(), String::new()),
    };
    (2u32..)
        .map(|index| directory.join(format!("{stem} ({index}){extension}")))
        .find(|path| !path.exists())
        .expect("an unused suffix exists")
}

#[tauri::command]
pub async fn desktop_bridge_pick_files(app: AppHandle<DesktopRuntime>, options: Option<Value>) -> Result<Vec<String>, String> {
    let title = options.as_ref().and_then(|value| value.get("title")).and_then(Value::as_str).unwrap_or("Select files to upload");
    let selected = app.dialog().file().set_title(title).blocking_pick_files().unwrap_or_default();
    selected.into_iter().map(dialog_file_path_to_string).collect()
}

#[tauri::command]
pub async fn desktop_bridge_download_to_folder(url: String, directory: String, file_name: String) -> Result<String, String> {
    let url = validate_transfer_url(&url)?;
    validate_download_file_name(&file_name)?;
    let directory = PathBuf::from(directory);
    if !directory.is_dir() {
        return Err("Download folder does not exist.".to_owned());
    }
    let response = reqwest::Client::new().get(url).send().await.map_err(|error| bridge_error("Download request failed", error))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}.", response.status().as_u16()));
    }
    let partial = directory.join(format!(".{file_name}.bibcode-download.part"));
    let mut file = tokio::fs::File::create(&partial).await.map_err(|error| bridge_error("Could not create the download file", error))?;
    let mut stream = response.bytes_stream();
    let outcome: Result<(), String> = async {
        use futures_util::StreamExt as _;
        use tokio::io::AsyncWriteExt as _;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| bridge_error("Download stream failed", error))?;
            file.write_all(&chunk).await.map_err(|error| bridge_error("Could not write the download file", error))?;
        }
        file.flush().await.map_err(|error| bridge_error("Could not finish the download file", error))
    }
    .await;
    drop(file);
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    let destination = unique_destination(&directory, &file_name);
    tokio::fs::rename(&partial, &destination).await.map_err(|error| bridge_error("Could not place the download file", error))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileOutcome {
    pub status: u16,
    pub body: String,
}

#[tauri::command]
pub async fn desktop_bridge_upload_file(url: String, path: String) -> Result<UploadFileOutcome, String> {
    let url = validate_transfer_url(&url)?;
    let file = tokio::fs::File::open(&path).await.map_err(|error| bridge_error("Could not open the file to upload", error))?;
    let length = file.metadata().await.map_err(|error| bridge_error("Could not read the file to upload", error))?.len();
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    let response = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_LENGTH, length)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(body)
        .send()
        .await
        .map_err(|error| bridge_error("Upload request failed", error))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(UploadFileOutcome { status, body })
}
```

Add `tokio-util.workspace = true` to `apps/desktop/src-tauri/Cargo.toml` if it is not already a dependency. Register the three commands in `lib.rs` (both lists) and in the `bridge.rs` command inventories and async-command assertions. The upload URL carries the `?name=…&overwrite=…` query already; the host does not modify it.

TypeScript adapters in `tauriDesktopBridge.ts`:

```ts
    pickFiles: (options) => tauriInvokeOr<readonly string[]>("desktop_bridge_pick_files", { options }, () => []),
    downloadToFolder: (input) =>
      tauriInvokeDesktop<string>("desktop_bridge_download_to_folder", {
        url: input.url,
        directory: input.directory,
        fileName: input.fileName,
      }),
    uploadFile: (input) =>
      tauriInvokeDesktop<{ status: number; body: string }>("desktop_bridge_upload_file", {
        url: input.url,
        path: input.path,
      }),
```

Add the three optional methods to `DesktopBridge` in `ipc.ts` and adapter tests mirroring the existing `saveDiagnosticLogs` adapter test.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p bibcode-desktop -j 2 transfer_urls download_file_names unique_destination
cargo test -p bibcode-desktop -j 2 bridge::tests
node scripts/run-local-vp.mjs test run apps/web/src/tauriDesktopBridge.test.ts packages/contracts/src/ipc.test.ts
```

Expected: PASS (the `bridge::tests` inventory tests confirm every command is registered in both lists).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri packages/contracts/src/ipc.ts apps/web/src/tauriDesktopBridge.ts apps/web/src/tauriDesktopBridge.test.ts
git commit -m "feat(desktop): add native file picking and host-side transfer bridge commands"
```

---

### Task 5: Client runtime commands and menu model

**Files:**
- Modify: `packages/client-runtime/src/state/projectCommands.ts` (add `createDownloadUrl` and `createUploadUrl` next to `createEntry` at line 116)
- Modify: `apps/web/src/components/files/FileTreeContextMenu.logic.ts` (ids, model), `FileTreeContextMenu.tsx` (`FileTreeMenuActions.onDownload/onUpload`, `ACTION_BY_ID`)
- Test: `apps/web/src/components/files/FileTreeContextMenu.logic.test.ts`

**Interfaces:**

```ts
// projectCommands.ts
createDownloadUrl: createEnvironmentRpcCommand(runtime, { label: "environment-data:projects:create-download-url", tag: WS_METHODS.projectsCreateDownloadUrl }),
createUploadUrl: createEnvironmentRpcCommand(runtime, { label: "environment-data:projects:create-upload-url", tag: WS_METHODS.projectsCreateUploadUrl }),
// logic.ts
export type FileTreeMenuItemId = ... | "download" | "upload";
// FileTreeContextMenu.tsx
onDownload?: () => void; onUpload?: () => void;
```

- [ ] **Step 1: Write the failing model tests**

```ts
describe("buildFileTreeMenuModel — transfers", () => {
  it("offers Download and an enabled Upload on directory rows", () => {
    const download = find({ ...BASE, entryKind: "directory" }, "download");
    const upload = find({ ...BASE, entryKind: "directory" }, "upload");
    expect(download).toEqual({ id: "download", label: "Download", enabled: true });
    expect(upload).toEqual({ id: "upload", label: "Upload Files…", enabled: true });
  });

  it("offers Download and a disabled, explained Upload on file rows", () => {
    expect(find(BASE, "download")).toEqual({ id: "download", label: "Download", enabled: true });
    expect(find(BASE, "upload")).toEqual({
      id: "upload",
      label: "Upload Files… (choose a folder)",
      enabled: false,
    });
  });

  it("offers Upload to the workspace root from the background and no Download", () => {
    const background = { ...BASE, entryKind: "background" as const };
    expect(find(background, "upload")).toEqual({ id: "upload", label: "Upload Files…", enabled: true });
    expect(find(background, "download")).toBeUndefined();
  });

  it("keeps transfers available outside the primary environment", () => {
    expect(ids({ ...BASE, entryKind: "directory", isPrimaryEnv: false })).toEqual(
      expect.arrayContaining(["download", "upload"]),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/files/FileTreeContextMenu.logic.test.ts
```

Expected: FAIL, items missing.

- [ ] **Step 3: Implement**

In `FileTreeContextMenu.logic.ts` extend the id union with `"download"` and `"upload"`, then in `buildFileTreeMenuModel`: for the background return, insert a group `[{ id: "upload", label: "Upload Files…", enabled: true }]` between the create group and the copy/refresh group; for rows, add after `actionGroup`:

```ts
  const transferGroup: FileTreeMenuItem[] = [
    { id: "download", label: "Download", enabled: true },
    isDirectory
      ? { id: "upload", label: "Upload Files…", enabled: true }
      : { id: "upload", label: "Upload Files… (choose a folder)", enabled: false },
  ];
```

and return `dropEmptyGroups([[NEW_FILE, NEW_FOLDER], actionGroup, transferGroup, mutateGroup])`. In `FileTreeContextMenu.tsx` add `onDownload?: () => void;` and `onUpload?: () => void;` to `FileTreeMenuActions` and `download: "onDownload", upload: "onUpload"` to `ACTION_BY_ID`. Add the two commands to `projectCommands.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/files/FileTreeContextMenu.logic.test.ts packages/client-runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/state/projectCommands.ts apps/web/src/components/files/FileTreeContextMenu.logic.ts apps/web/src/components/files/FileTreeContextMenu.logic.test.ts apps/web/src/components/files/FileTreeContextMenu.tsx
git commit -m "feat(files): add Download and Upload items to the file tree menu model"
```

---

### Task 6: Wire Download and Upload in `FileBrowserPanel`

**Files:**
- Create: `apps/web/src/components/files/fileTransfers.ts` (pure flow helpers, testable without React)
- Modify: `apps/web/src/components/files/FileBrowserPanel.tsx` (`rowActions` at 713-749, background actions at 874-884, hidden upload input, dialog use)
- Test: `apps/web/src/components/files/fileTransfers.test.ts` (new), `apps/web/src/components/files/FileBrowserPanel.test.tsx` ("context menu model" and "background context menu" describes)

**Interfaces:**

```ts
// fileTransfers.ts
export interface TransferBridge {
  pickFolder: (options?: { initialPath?: string | null }) => Promise<string | null>;
  pickFiles?: () => Promise<readonly string[]>;
  downloadToFolder?: (input: { url: string; directory: string; fileName: string }) => Promise<string>;
  uploadFile?: (input: { url: string; path: string }) => Promise<{ status: number; body: string }>;
}
export type DownloadOutcome =
  | { _tag: "Saved"; path: string }
  | { _tag: "BrowserDownload"; url: string; fileName: string }
  | { _tag: "Cancelled" };
export async function downloadWithBridge(input: { url: string; fileName: string; bridge: TransferBridge | undefined }): Promise<DownloadOutcome>;
export function triggerBrowserDownload(url: string, fileName: string, documentRef?: Document): void; // anchor with download attr
export type UploadStep =
  | { _tag: "Uploaded"; relativePath: string }
  | { _tag: "Exists" }
  | { _tag: "TooLarge"; limit: number }
  | { _tag: "Failed"; message: string };
export function uploadUrlFor(relativeUrl: string, httpBaseUrl: string, name: string, overwrite: boolean): string;
export function interpretUploadResponse(status: number, body: string): UploadStep;
```

- [ ] **Step 1: Write the failing helper tests**

`fileTransfers.test.ts`:

```ts
import { describe, expect, it, vi } from "vite-plus/test";

import {
  downloadWithBridge,
  interpretUploadResponse,
  triggerBrowserDownload,
  uploadUrlFor,
} from "./fileTransfers";

describe("downloadWithBridge", () => {
  it("picks a folder and saves through the bridge", async () => {
    const bridge = {
      pickFolder: vi.fn(async () => "/home/me/Downloads"),
      downloadToFolder: vi.fn(async () => "/home/me/Downloads/src.zip"),
    };
    const outcome = await downloadWithBridge({ url: "https://h/api/transfers/t", fileName: "src.zip", bridge });
    expect(bridge.downloadToFolder).toHaveBeenCalledWith({
      url: "https://h/api/transfers/t",
      directory: "/home/me/Downloads",
      fileName: "src.zip",
    });
    expect(outcome).toEqual({ _tag: "Saved", path: "/home/me/Downloads/src.zip" });
  });

  it("reports cancellation when no folder is picked", async () => {
    const bridge = { pickFolder: vi.fn(async () => null), downloadToFolder: vi.fn() };
    expect(await downloadWithBridge({ url: "u", fileName: "f", bridge })).toEqual({ _tag: "Cancelled" });
    expect(bridge.downloadToFolder).not.toHaveBeenCalled();
  });

  it("falls back to a browser download without a bridge", async () => {
    expect(await downloadWithBridge({ url: "u", fileName: "f", bridge: undefined })).toEqual({
      _tag: "BrowserDownload",
      url: "u",
      fileName: "f",
    });
  });
});

describe("upload helpers", () => {
  it("builds the upload URL with an encoded name and overwrite flag", () => {
    expect(uploadUrlFor("/api/transfers/t.k", "https://h:3773/", "a b.txt", false)).toBe(
      "https://h:3773/api/transfers/t.k?name=a%20b.txt",
    );
    expect(uploadUrlFor("/api/transfers/t.k", "https://h:3773/", "a.txt", true)).toBe(
      "https://h:3773/api/transfers/t.k?name=a.txt&overwrite=1",
    );
  });

  it("interprets server responses", () => {
    expect(interpretUploadResponse(201, '{"relativePath":"dir/a.txt"}')).toEqual({ _tag: "Uploaded", relativePath: "dir/a.txt" });
    expect(interpretUploadResponse(409, '{"_tag":"TransferEntryExistsError"}')).toEqual({ _tag: "Exists" });
    expect(interpretUploadResponse(413, '{"_tag":"TransferTooLargeError","limit":4}')).toEqual({ _tag: "TooLarge", limit: 4 });
    expect(interpretUploadResponse(500, "boom")._tag).toBe("Failed");
  });

  it("triggers an anchor download", () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), href: "", download: "", rel: "" } as unknown as HTMLAnchorElement;
    const doc = { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } } as unknown as Document;
    triggerBrowserDownload("https://h/x", "src.zip", doc);
    expect(anchor.href).toBe("https://h/x");
    expect(anchor.download).toBe("src.zip");
    expect(click).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/files/fileTransfers.test.ts
```

Expected: FAIL, module missing.

- [ ] **Step 3: Implement the helpers**

```ts
export async function downloadWithBridge(input: {
  url: string;
  fileName: string;
  bridge: TransferBridge | undefined;
}): Promise<DownloadOutcome> {
  const { bridge } = input;
  if (bridge?.downloadToFolder === undefined) {
    return { _tag: "BrowserDownload", url: input.url, fileName: input.fileName };
  }
  const directory = await bridge.pickFolder({ initialPath: null });
  if (directory === null) return { _tag: "Cancelled" };
  const path = await bridge.downloadToFolder({ url: input.url, directory, fileName: input.fileName });
  return { _tag: "Saved", path };
}

export function triggerBrowserDownload(url: string, fileName: string, documentRef: Document = document): void {
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function uploadUrlFor(relativeUrl: string, httpBaseUrl: string, name: string, overwrite: boolean): string {
  const url = new URL(relativeUrl, httpBaseUrl);
  url.searchParams.set("name", name);
  if (overwrite) url.searchParams.set("overwrite", "1");
  return url.toString();
}

export function interpretUploadResponse(status: number, body: string): UploadStep {
  let parsed: { _tag?: string; relativePath?: string; limit?: number } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (status === 201 && typeof parsed.relativePath === "string") {
    return { _tag: "Uploaded", relativePath: parsed.relativePath };
  }
  if (status === 409) return { _tag: "Exists" };
  if (status === 413) return { _tag: "TooLarge", limit: typeof parsed.limit === "number" ? parsed.limit : 0 };
  return { _tag: "Failed", message: body.trim().length > 0 ? body.trim() : `Upload failed with HTTP ${status}.` };
}
```

Keep `URL.searchParams` encoding (`a%20b.txt`); the server decodes with `form_urlencoded`, which accepts both `%20` and `+`.

- [ ] **Step 4: Write the failing panel tests**

In `FileBrowserPanel.test.tsx`, in `describe("context menu model")`:

```tsx
it("wires Download to a minted transfer URL and the desktop bridge", async () => {
  testState.commandResults["createDownloadUrl"] = {
    _tag: "Success",
    value: { relativeUrl: "/api/transfers/t.k", expiresAt: 1, fileName: "src.zip", kind: "archive" },
  };
  const downloadToFolder = vi.fn(async () => "/home/me/Downloads/src.zip");
  const pickFolder = vi.fn(async () => "/home/me/Downloads");
  vi.stubGlobal("window", { ...window, desktopBridge: { pickFolder, downloadToFolder } });
  renderPanel();
  const actions = rowActionsFor("src", "directory"); // helper that invokes FileTree.renderContextMenu and returns element.props.actions
  await actions.onDownload!();
  expect(testState.commands["createDownloadUrl"]).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { cwd: CWD, relativePath: "src" },
  });
  expect(downloadToFolder).toHaveBeenCalledWith({
    url: `${HTTP_BASE_URL}api/transfers/t.k`,
    directory: "/home/me/Downloads",
    fileName: "src.zip",
  });
});

it("offers Upload on directory rows and the background, targeting that folder or the root", () => {
  renderPanel();
  expect(rowActionsFor("src", "directory").onUpload).toBeDefined();
  expect(rowActionsFor("src/app.ts", "file").onUpload).toBeDefined();
  const model = rowModelFor("src/app.ts", "file");
  expect(model.groups.flat().find((item) => item.id === "upload")?.enabled).toBe(false);
});
```

Follow the file's existing `testState.commandResults`, `renderPanel`, `ui.last("FileTree")`, and `renderContextMenu` conventions (see the test at lines 1059-1082) to implement `rowActionsFor`/`rowModelFor` as local helpers; use the constants the file already defines for the environment id, cwd, and HTTP base URL.

- [ ] **Step 5: Run the panel tests to verify they fail**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/files/FileBrowserPanel.test.tsx
```

Expected: FAIL, `onDownload`/`onUpload` undefined.

- [ ] **Step 6: Wire the panel**

In `FileBrowserPanel.tsx`:

```tsx
  const createDownloadUrl = useAtomCommand(projectEnvironment.createDownloadUrl, { reportFailure: false });
  const createUploadUrl = useAtomCommand(projectEnvironment.createUploadUrl, { reportFailure: false });
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<string>("");

  const downloadEntry = useCallback(
    async (relativePath: string) => {
      const result = await createDownloadUrl({ environmentId, input: { cwd, relativePath } });
      if (result._tag !== "Success") {
        showMutationError(result, `Failed to prepare a download for ${relativePath}`);
        return;
      }
      const url = resolveAssetUrl(environmentHttpBaseUrl, result.value.relativeUrl);
      if (url === null) {
        showMutationError(null, "The server did not return a usable download URL.");
        return;
      }
      try {
        const outcome = await downloadWithBridge({
          url,
          fileName: result.value.fileName,
          bridge: typeof window === "undefined" ? undefined : window.desktopBridge,
        });
        if (outcome._tag === "BrowserDownload") triggerBrowserDownload(outcome.url, outcome.fileName);
        if (outcome._tag === "Saved") notify(`Saved ${result.value.fileName} to ${outcome.path}`);
      } catch (cause) {
        showMutationError(cause, `Failed to download ${relativePath}`);
      }
    },
    [createDownloadUrl, cwd, environmentHttpBaseUrl, environmentId, showMutationError],
  );

  const uploadOne = useCallback(
    async (relativeDirectory: string, file: { name: string; send: (url: string) => Promise<{ status: number; body: string }> }) => {
      const minted = await createUploadUrl({ environmentId, input: { cwd, relativeDirectory } });
      if (minted._tag !== "Success") {
        showMutationError(minted, `Failed to prepare an upload to ${relativeDirectory || "the workspace root"}`);
        return;
      }
      let overwrite = false;
      for (;;) {
        const response = await file.send(uploadUrlFor(minted.value.relativeUrl, environmentHttpBaseUrl, file.name, overwrite));
        const step = interpretUploadResponse(response.status, response.body);
        if (step._tag === "Uploaded") return;
        if (step._tag === "Exists" && !overwrite) {
          const replace = await confirmDialog({
            title: `Replace ${file.name}?`,
            description: `${file.name} already exists in ${relativeDirectory || "the workspace root"}. Replacing it cannot be undone.`,
            confirmLabel: "Replace",
            destructive: true,
          });
          if (!replace) return;
          overwrite = true;
          continue;
        }
        showMutationError(null, step._tag === "TooLarge" ? `${file.name} is larger than the ${Math.round(step.limit / (1024 * 1024))} MiB upload limit.` : step._tag === "Exists" ? `${file.name} could not be replaced.` : step.message);
        return;
      }
    },
    [createUploadUrl, cwd, environmentHttpBaseUrl, environmentId, showMutationError],
  );

  const uploadTo = useCallback(
    async (relativeDirectory: string) => {
      const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
      if (bridge?.pickFiles !== undefined && bridge.uploadFile !== undefined) {
        const paths = await bridge.pickFiles();
        for (const path of paths) {
          const name = path.split(/[\\/]/).pop() ?? path;
          await uploadOne(relativeDirectory, { name, send: (url) => bridge.uploadFile!({ url, path }) });
        }
        if (paths.length > 0) refreshEntries();
        return;
      }
      uploadTargetRef.current = relativeDirectory;
      uploadInputRef.current?.click();
    },
    [refreshEntries, uploadOne],
  );

  const handleUploadInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      for (const file of files) {
        await uploadOne(uploadTargetRef.current, {
          name: file.name,
          send: async (url) => {
            const response = await fetch(url, { method: "POST", body: file, credentials: "include" });
            return { status: response.status, body: await response.text() };
          },
        });
      }
      if (files.length > 0) refreshEntries();
    },
    [refreshEntries, uploadOne],
  );
```

`confirmDialog` is the promise wrapper the panel already uses for Delete through `FileEntryDialog` (`mode: "confirm"`, `destructive`); reuse it verbatim, adding `title`/`description`/`confirmLabel` if its request type lacks them. `notify` is the success notice helper used by `apps/web/src/diagnostics/downloadDiagnosticLogs.ts` after a save; import the same function. Add to `rowActions`: `onDownload: () => void downloadEntry(relativePath)` (always) and, inside the `workspaceUnavailable === null` spread, `onUpload: () => void uploadTo(kind === "directory" ? relativePath : parentRelativePath(relativePath))`; the model disables it on file rows, so the handler is only reachable from directory rows. In the background actions add `onUpload: () => void uploadTo("")` inside the same availability guard. Render once near `FileEntryDialog`:

```tsx
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        onChange={(event) => void handleUploadInputChange(event)}
      />
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/components/files
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/files
git commit -m "feat(files): download entries and upload files from the file tree menu"
```

---

### Task 7: Documentation, reviews, and validation

**Files:**
- Modify: `docs/user/workspace-ui.md:419-445` (Files section), `docs/architecture/rpc-and-orchestration.md` (auth-per-route and path-lease sections near lines 628-631 and 1127-1128), `docs/architecture/remote.md` (near lines 31 and 211-215), `docs/testing/` runbooks that list Files panel flows

- [ ] **Step 1: Update the user doc**

In the Files bullet list, after the "New File… and New Folder…" bullet, add:

```markdown
- **Download** saves the right-clicked file, or a `.zip` of the right-clicked
  folder, into a folder you choose (the desktop app asks for the folder; a
  browser uses its own download location). Folders larger than 2 GiB or
  200,000 entries are refused with a message; symbolic links are skipped.
- **Upload Files…** on a folder row, or on the tree background for the
  workspace root, opens a file picker and uploads the chosen files into that
  folder. It is disabled on file rows. An upload that would replace an existing
  file asks first. Files up to 1 GiB each are accepted. Both actions work for
  remote environments; the transfer goes to the server that owns the workspace.
```

- [ ] **Step 2: Update the architecture docs**

In `rpc-and-orchestration.md`, in the per-route authentication section, add:

```markdown
`GET`/`POST /api/transfers/{token}` authenticate with a five-minute HMAC token
minted by `projects.createDownloadUrl` (read scope) or `projects.createUploadUrl`
(operate scope) while those RPCs hold the workspace path lease. A download token
names one file or folder under a normalized workspace root; a folder streams as
a zip after an entry/byte pre-scan. An upload token names one directory and a
byte cap; uploads land in a `.part` file and rename into place, refusing
collisions unless `overwrite=1`, and never replacing directories. The upload
handler invalidates the entries index for that root.
```

In `remote.md`, next to the note that E2EE-only profiles carry no HTTP authorization, add one sentence: "File transfers use token-in-path URLs for the same reason asset previews do, so they work on every profile."

- [ ] **Step 3: Update runbooks**

```bash
rg -n "Files|file tree|context menu" docs/testing
```

If a runbook enumerates Files panel flows in native visual validation, add a step: right-click a folder → Download → pick a folder → verify the zip; right-click the background → Upload Files… → pick a file → verify it appears. Otherwise report the runbooks as reviewed and unchanged.

- [ ] **Step 4: Run the required reviews**

Invoke the `vercel-react-best-practices` skill on `FileBrowserPanel.tsx` and `fileTransfers.ts`. Review against `UI.md`: disabled Upload on file rows explains itself, the only confirmation is the destructive replace, errors say what failed and what to do, downloads never overwrite local files (unique suffix). Record both outcomes.

- [ ] **Step 5: Run repository gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings
cargo test -p bibcode-server -j 2 transfer:: --lib
cargo test -p bibcode-server -j 2 --test workspace_rpc --test production_http_routes
cargo test -p bibcode-desktop -j 2 bridge::tests
node scripts/run-local-vp.mjs test run packages/contracts packages/client-runtime apps/web/src/components/files apps/web/src/tauriDesktopBridge.test.ts
vp run check:contracts
vp check
vp run typecheck
```

Expected: all green. `git status --short` shows only the files named in Tasks 1-7 plus regenerated fixtures.

- [ ] **Step 6: Manual verification**

With `vp run dev:desktop` against a local project and against a paired remote server: download a file and a folder, upload a file into a folder and into the root, trigger the replace prompt, and confirm the tree refreshes. In browser mode (`vp run dev` and open the web URL), confirm the anchor download and the `<input type="file">` path. Record the observations, and confirm that the browser-mode `POST` to a remote server is not blocked by CORS (see Residual risk).

- [ ] **Step 7: Commit**

```bash
git add docs/user/workspace-ui.md docs/architecture/rpc-and-orchestration.md docs/architecture/remote.md docs/testing
git commit -m "docs(files): describe Download and Upload and the transfer routes"
```

## Residual risk

- Browser mode against a server on a different origin needs CORS to allow `POST /api/transfers/*` from the UI origin; verify the server's CORS layer in `lifecycle.rs` during Task 7 Step 6 and extend the allowed methods/paths if needed. Desktop mode avoids this by transferring from the Rust host.
- A folder archive that fails mid-stream (I/O error) produces a truncated zip; the server logs a warning and the desktop host keeps the partial only after a successful HTTP status, so the user sees a corrupt archive rather than nothing. Pre-scan limits prevent the common oversize case.
- `ZipWriter::new_stream` option compatibility (`large_file`) is confirmed by the Task 2 round-trip test rather than by documentation.
- Uploads over an E2EE relay depend on the relay forwarding HTTP bodies; asset previews already rely on the same path.

## Out of scope

- Drag-and-drop from the OS (the 2026-08-18 design remains a separate proposal, though it can reuse the upload route).
- Multi-selection downloads (one right-clicked entry per download).
- Resumable transfers or progress bars beyond the busy notice; both routes are single-request streams.

## Self-review

- Spec coverage: Download for file and folder (Tasks 2-3, 6), folder picker for the destination (Task 4, 6), Upload enabled on folders and the root, disabled on files (Task 5), file picker (Task 4, 6), remote servers (token-in-path design, Task 3), docs (Task 7).
- Placeholder scan: none; every helper referenced (`confirmDialog`, `notify`, `resolveAssetUrl`, `HttpRouteError` constructors) is named with where it already exists.
- Type consistency: `TransferClaims::{Download, Upload}` fields match between Task 2 and Task 3; `TransferUploadHttpOutcome` variants match between handler and route; `downloadToFolder({ url, directory, fileName })`, `uploadFile({ url, path })`, and `pickFiles()` match between Task 4 (Rust and TS) and Task 6; menu ids `"download"`/`"upload"` and actions `onDownload`/`onUpload` match between Tasks 5 and 6.
