use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
};

use thiserror::Error;

use crate::crypto::sha256_hex;

use super::GitWorktreeRecord;

const MAX_WORKTREE_RECORDS: usize = 512;
const WORKTREE_KEY_VERSION: &str = "bibcode.worktree.v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostPathPlatform {
    Posix,
    Windows,
}

#[must_use]
pub const fn host_path_platform() -> HostPathPlatform {
    if cfg!(windows) {
        HostPathPlatform::Windows
    } else {
        HostPathPlatform::Posix
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct WorktreeRepositoryKey(String);

impl WorktreeRepositoryKey {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct WorktreeKey(String);

impl WorktreeKey {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum WorktreeParseError {
    #[error("Git worktree porcelain output is empty")]
    Empty,
    #[error("Git worktree porcelain output has an unterminated record")]
    Unterminated,
    #[error("Git worktree porcelain output contains an empty record")]
    EmptyRecord,
    #[error("Git worktree porcelain output contains more than {MAX_WORKTREE_RECORDS} records")]
    TooManyRecords,
    #[error("Git worktree porcelain record is missing its worktree path")]
    MissingPath,
    #[error("Git worktree porcelain record has duplicate {field} fields")]
    DuplicateField { field: &'static str },
    #[error("Git worktree porcelain record has an invalid {field} field")]
    InvalidField { field: &'static str },
}

#[derive(Debug, Error)]
pub enum WorktreeIdentityError {
    #[error("failed to canonicalize the common Git directory {path}")]
    CommonDir {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to canonicalize the registered worktree path {path}")]
    WorktreePath {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[must_use]
pub fn normalize_worktree_path_key(path: &Path, platform: HostPathPlatform) -> String {
    let source = match platform {
        HostPathPlatform::Posix => path.to_string_lossy().into_owned(),
        HostPathPlatform::Windows => path.to_string_lossy().replace('\\', "/"),
    };
    let normalized = normalize_lexical_components(&source, platform);
    match platform {
        HostPathPlatform::Posix => normalized,
        HostPathPlatform::Windows => normalized.to_ascii_lowercase(),
    }
}

fn normalize_lexical_components(path: &str, platform: HostPathPlatform) -> String {
    let collapsed = collapse_separators(path, platform == HostPathPlatform::Windows);
    let (prefix, remainder, locked_components, anchored) = match platform {
        HostPathPlatform::Windows if collapsed.starts_with("//") => {
            ("//", &collapsed[2..], 2, true)
        }
        HostPathPlatform::Windows
            if collapsed.as_bytes().get(1) == Some(&b':')
                && collapsed
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic) =>
        {
            if collapsed.as_bytes().get(2) == Some(&b'/') {
                (&collapsed[..3], &collapsed[3..], 0, true)
            } else {
                (&collapsed[..2], &collapsed[2..], 0, false)
            }
        }
        _ if collapsed.starts_with('/') => ("/", &collapsed[1..], 0, true),
        _ => ("", collapsed.as_str(), 0, false),
    };

    let mut components: Vec<&str> = Vec::new();
    for component in remainder.split('/') {
        match component {
            "" | "." => {}
            ".." if components.len() > locked_components && components.last() != Some(&"..") => {
                components.pop();
            }
            ".." if anchored => {}
            ".." => components.push(component),
            _ => components.push(component),
        }
    }

    if components.is_empty() {
        return if prefix.is_empty() {
            if collapsed.is_empty() { "" } else { "." }.to_owned()
        } else {
            prefix.to_owned()
        };
    }
    let joined = components.join("/");
    format!("{prefix}{joined}")
}

fn collapse_separators(path: &str, preserve_unc_prefix: bool) -> String {
    let preserve_unc_prefix = preserve_unc_prefix && path.starts_with("//");
    let mut normalized = String::with_capacity(path.len());
    let mut previous_was_separator = false;
    for (index, character) in path.char_indices() {
        if character != '/' {
            normalized.push(character);
            previous_was_separator = false;
            continue;
        }
        if !previous_was_separator || (preserve_unc_prefix && index == 1) {
            normalized.push(character);
        }
        previous_was_separator = true;
    }
    normalized
}

#[must_use]
pub fn worktree_repository_key(
    common_dir: &Path,
    platform: HostPathPlatform,
) -> WorktreeRepositoryKey {
    WorktreeRepositoryKey(opaque_key(
        &normalize_worktree_path_key(common_dir, platform),
        None,
    ))
}

#[must_use]
pub fn worktree_key(common_dir: &Path, path: &Path, platform: HostPathPlatform) -> WorktreeKey {
    WorktreeKey(opaque_key(
        &normalize_worktree_path_key(common_dir, platform),
        Some(&normalize_worktree_path_key(path, platform)),
    ))
}

pub async fn resolved_worktree_keys(
    common_dir: &Path,
    git_path: &Path,
    platform: HostPathPlatform,
) -> Result<(WorktreeRepositoryKey, WorktreeKey), WorktreeIdentityError> {
    let common_dir = canonicalize_or_git_path(common_dir, true).await?;
    let git_path = canonicalize_or_git_path(git_path, false).await?;
    Ok((
        worktree_repository_key(&common_dir, platform),
        worktree_key(&common_dir, &git_path, platform),
    ))
}

async fn canonicalize_or_git_path(
    path: &Path,
    common_dir: bool,
) -> Result<PathBuf, WorktreeIdentityError> {
    match tokio::fs::canonicalize(path).await {
        Ok(path) => Ok(path),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(source) if common_dir => Err(WorktreeIdentityError::CommonDir {
            path: path.to_path_buf(),
            source,
        }),
        Err(source) => Err(WorktreeIdentityError::WorktreePath {
            path: path.to_path_buf(),
            source,
        }),
    }
}

pub fn parse_worktree_porcelain(
    output: &str,
    nul_delimited: bool,
) -> Result<Vec<GitWorktreeRecord>, WorktreeParseError> {
    let raw_records = if nul_delimited {
        split_nul_records(output)?
    } else {
        split_legacy_records(output)?
    };
    if raw_records.is_empty() {
        return Err(WorktreeParseError::Empty);
    }
    if raw_records.len() > MAX_WORKTREE_RECORDS {
        return Err(WorktreeParseError::TooManyRecords);
    }
    raw_records
        .into_iter()
        .enumerate()
        .map(|(index, fields)| parse_record(&fields, !nul_delimited, index == 0))
        .collect()
}

fn opaque_key(common_dir_key: &str, path_key: Option<&str>) -> String {
    let mut input = Vec::with_capacity(
        WORKTREE_KEY_VERSION.len() + common_dir_key.len() + path_key.map_or(0, str::len) + 2,
    );
    input.extend_from_slice(WORKTREE_KEY_VERSION.as_bytes());
    input.push(b'\0');
    input.extend_from_slice(common_dir_key.as_bytes());
    if let Some(path_key) = path_key {
        input.push(b'\0');
        input.extend_from_slice(path_key.as_bytes());
    }
    sha256_hex(input)
}

fn split_nul_records(output: &str) -> Result<Vec<Vec<&str>>, WorktreeParseError> {
    if output.is_empty() {
        return Err(WorktreeParseError::Empty);
    }
    if !output.ends_with("\0\0") {
        return Err(WorktreeParseError::Unterminated);
    }
    let mut records = Vec::new();
    let mut fields = Vec::new();
    for field in output.split_terminator('\0') {
        if field.is_empty() {
            if fields.is_empty() {
                return Err(WorktreeParseError::EmptyRecord);
            }
            records.push(std::mem::take(&mut fields));
        } else {
            fields.push(field);
        }
    }
    if !fields.is_empty() {
        return Err(WorktreeParseError::Unterminated);
    }
    Ok(records)
}

fn split_legacy_records(output: &str) -> Result<Vec<Vec<&str>>, WorktreeParseError> {
    if output.is_empty() {
        return Err(WorktreeParseError::Empty);
    }
    if !output.ends_with("\n\n") {
        return Err(WorktreeParseError::Unterminated);
    }
    let mut records = Vec::new();
    for record in output[..output.len() - 1].split("\n\n") {
        if record.is_empty() {
            return Err(WorktreeParseError::EmptyRecord);
        }
        let fields: Vec<&str> = record.lines().collect();
        if fields.is_empty() || fields.iter().any(|field| field.is_empty()) {
            return Err(WorktreeParseError::EmptyRecord);
        }
        records.push(fields);
    }
    Ok(records)
}

fn parse_record(
    fields: &[&str],
    legacy: bool,
    is_primary: bool,
) -> Result<GitWorktreeRecord, WorktreeParseError> {
    let mut seen = HashSet::new();
    let mut path = None;
    let mut head = None;
    let mut branch = None;
    let mut is_bare = false;
    let mut locked = false;
    let mut lock_reason = None;
    let mut is_prunable = false;
    let mut prunable_reason = None;
    let mut detached = false;
    let mut unborn = false;

    for field in fields {
        let (name, value) = split_field(field);
        let singleton = match name {
            "worktree" => Some("worktree"),
            "HEAD" => Some("HEAD"),
            "branch" => Some("branch"),
            "bare" => Some("bare"),
            "locked" => Some("locked"),
            "prunable" => Some("prunable"),
            "detached" => Some("detached"),
            "unborn" => Some("unborn"),
            _ => None,
        };
        if let Some(singleton) = singleton
            && !seen.insert(singleton)
        {
            return Err(WorktreeParseError::DuplicateField { field: singleton });
        }
        match name {
            "worktree" => {
                let value = value.ok_or(WorktreeParseError::MissingPath)?;
                if value.is_empty() {
                    return Err(WorktreeParseError::MissingPath);
                }
                path = Some(PathBuf::from(if legacy {
                    decode_c_style(value)?
                } else {
                    value.to_owned()
                }));
            }
            "HEAD" => {
                head = Some(
                    value
                        .filter(|value| !value.is_empty())
                        .ok_or(WorktreeParseError::InvalidField { field: "HEAD" })?
                        .to_owned(),
                );
            }
            "branch" => {
                let branch_ref = value
                    .filter(|value| !value.is_empty())
                    .ok_or(WorktreeParseError::InvalidField { field: "branch" })?;
                branch = Some(
                    branch_ref
                        .strip_prefix("refs/heads/")
                        .ok_or(WorktreeParseError::InvalidField { field: "branch" })?
                        .to_owned(),
                );
            }
            "bare" => {
                if value.is_some() {
                    return Err(WorktreeParseError::InvalidField { field: "bare" });
                }
                is_bare = true;
            }
            "locked" => {
                locked = true;
                lock_reason = value.map(str::to_owned).filter(|value| !value.is_empty());
            }
            "prunable" => {
                is_prunable = true;
                prunable_reason = value.map(str::to_owned).filter(|value| !value.is_empty());
            }
            "detached" => {
                if value.is_some() {
                    return Err(WorktreeParseError::InvalidField { field: "detached" });
                }
                detached = true;
            }
            "unborn" => {
                if value.is_some() {
                    return Err(WorktreeParseError::InvalidField { field: "unborn" });
                }
                unborn = true;
            }
            _ => {}
        }
    }

    let path = path.ok_or(WorktreeParseError::MissingPath)?;
    Ok(GitWorktreeRecord {
        path,
        head,
        branch: (!detached && !unborn).then_some(branch).flatten(),
        is_primary,
        is_bare,
        locked,
        lock_reason,
        is_prunable,
        prunable_reason,
    })
}

fn split_field(field: &str) -> (&str, Option<&str>) {
    match field.split_once(' ') {
        Some((name, value)) => (name, Some(value)),
        None => (field, None),
    }
}

fn decode_c_style(value: &str) -> Result<String, WorktreeParseError> {
    if !value.starts_with('"') {
        return Ok(value.to_owned());
    }
    if value.len() < 2 || !value.ends_with('"') {
        return Err(WorktreeParseError::InvalidField { field: "worktree" });
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 1;
    while index < bytes.len() - 1 {
        let byte = bytes[index];
        if byte != b'\\' {
            decoded.push(byte);
            index += 1;
            continue;
        }
        index += 1;
        let Some(escaped) = bytes.get(index).copied() else {
            return Err(WorktreeParseError::InvalidField { field: "worktree" });
        };
        let value = match escaped {
            b'a' => b'\x07',
            b'b' => b'\x08',
            b'f' => b'\x0c',
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => b'\x0b',
            b'\\' => b'\\',
            b'"' => b'"',
            b'0'..=b'7' => {
                let digits = bytes
                    .get(index..index + 3)
                    .filter(|digits| digits.iter().all(|digit| matches!(digit, b'0'..=b'7')))
                    .ok_or(WorktreeParseError::InvalidField { field: "worktree" })?;
                index += 2;
                (digits[0] - b'0') * 64 + (digits[1] - b'0') * 8 + (digits[2] - b'0')
            }
            _ => return Err(WorktreeParseError::InvalidField { field: "worktree" }),
        };
        decoded.push(value);
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| WorktreeParseError::InvalidField { field: "worktree" })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        HostPathPlatform, WorktreeIdentityError, normalize_worktree_path_key,
        parse_worktree_porcelain, resolved_worktree_keys, worktree_key, worktree_repository_key,
    };

    #[test]
    fn parses_nul_records_with_special_paths_and_state() {
        let records = parse_worktree_porcelain(
            "worktree /repo main\ncopy\0HEAD abc123\0branch refs/heads/feature/space\0locked maintenance\0\0worktree /repo linked\0HEAD def456\0detached\0prunable stale admin\0\0",
            true,
        )
        .expect("NUL porcelain parses");

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].path, Path::new("/repo main\ncopy"));
        assert_eq!(records[0].branch.as_deref(), Some("feature/space"));
        assert!(records[0].locked);
        assert_eq!(records[0].lock_reason.as_deref(), Some("maintenance"));
        assert!(records[0].is_primary);
        assert_eq!(records[1].branch, None);
        assert!(records[1].is_prunable);
        assert_eq!(records[1].prunable_reason.as_deref(), Some("stale admin"));
    }

    #[test]
    fn preserves_prunable_state_with_and_without_a_reason_and_ignores_unknown_fields() {
        let records = parse_worktree_porcelain(
            "worktree /prunable\nlocked\nprunable\nfuture-field preserved\n\nworktree /reasoned\nlocked maintenance\nprunable stale registration\n\n",
            false,
        )
        .expect("legacy porcelain with forward-compatible fields parses");

        assert!(records[0].locked);
        assert_eq!(records[0].lock_reason, None);
        assert!(records[0].is_prunable);
        assert_eq!(records[0].prunable_reason, None);
        assert!(records[1].locked);
        assert_eq!(records[1].lock_reason.as_deref(), Some("maintenance"));
        assert!(records[1].is_prunable);
        assert_eq!(
            records[1].prunable_reason.as_deref(),
            Some("stale registration")
        );
    }

    #[test]
    fn parses_legacy_c_quoted_paths_and_unborn_bare_records() {
        let records = parse_worktree_porcelain(
            "worktree \"/repo path\\nnext\"\nHEAD abc123\nbranch refs/heads/main\n\nworktree /bare\nbare\nbranch refs/heads/unborn\nunborn\n\n",
            false,
        )
        .expect("legacy porcelain parses");

        assert_eq!(records[0].path, Path::new("/repo path\nnext"));
        assert_eq!(records[0].branch.as_deref(), Some("main"));
        assert!(records[1].is_bare);
        assert_eq!(records[1].branch, None);
    }

    #[test]
    fn rejects_malformed_and_non_authoritative_records() {
        for (porcelain, nul_delimited) in [
            ("", false),
            ("worktree /one\nworktree /two\n\n", false),
            ("worktree /one\nbranch refs/heads/main", false),
            ("HEAD abc\n\n", false),
            ("worktree /one\0HEAD abc\0", true),
        ] {
            assert!(parse_worktree_porcelain(porcelain, nul_delimited).is_err());
        }

        let many = (0..513)
            .map(|index| format!("worktree /repo/{index}\n\n"))
            .collect::<String>();
        assert!(parse_worktree_porcelain(&many, false).is_err());
    }

    #[test]
    fn normalizes_host_path_keys_and_derives_stable_opaque_keys() {
        assert_eq!(
            normalize_worktree_path_key(Path::new(r"C:\Repo\Work\"), HostPathPlatform::Windows),
            "c:/repo/work"
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"\\Server\Share\Repo\"),
                HostPathPlatform::Windows
            ),
            "//server/share/repo"
        );
        assert_ne!(
            normalize_worktree_path_key(Path::new("/Repo"), HostPathPlatform::Posix),
            normalize_worktree_path_key(Path::new("/repo"), HostPathPlatform::Posix)
        );
        assert_ne!(
            normalize_worktree_path_key(Path::new(r"/repo\\name"), HostPathPlatform::Posix),
            normalize_worktree_path_key(Path::new("/repo/name"), HostPathPlatform::Posix)
        );
        assert_eq!(
            normalize_worktree_path_key(Path::new(r"C:\Repo\Work\"), HostPathPlatform::Windows),
            normalize_worktree_path_key(Path::new("c:/repo/work"), HostPathPlatform::Windows)
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"\\Server\Share\Repo"),
                HostPathPlatform::Windows
            ),
            normalize_worktree_path_key(
                Path::new("//server/share/repo"),
                HostPathPlatform::Windows
            )
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new("/repo//worktrees/./feature/src/../src"),
                HostPathPlatform::Posix,
            ),
            "/repo/worktrees/feature/src"
        );
        assert_eq!(
            normalize_worktree_path_key(Path::new("/../../repo/worktree"), HostPathPlatform::Posix,),
            "/repo/worktree",
            "absolute parent traversal cannot escape the POSIX root",
        );
        assert_eq!(
            normalize_worktree_path_key(Path::new("../../repo"), HostPathPlatform::Posix),
            "../../repo",
            "relative parent components retain their unresolved meaning",
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"C:\Repo\\Work\.\src\..\src"),
                HostPathPlatform::Windows,
            ),
            "c:/repo/work/src"
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"C:\..\..\Repo\Work"),
                HostPathPlatform::Windows,
            ),
            "c:/repo/work",
            "drive-root parent traversal cannot escape the drive root",
        );
        assert_eq!(
            normalize_worktree_path_key(Path::new(r"C:..\Repo\.\Work"), HostPathPlatform::Windows,),
            "c:../repo/work",
            "drive-relative parent traversal must remain drive-relative",
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"\\Server\Share\Repo\..\Work"),
                HostPathPlatform::Windows,
            ),
            "//server/share/work"
        );
        assert_eq!(
            normalize_worktree_path_key(
                Path::new(r"\\Server\Share\..\..\Work"),
                HostPathPlatform::Windows,
            ),
            "//server/share/work",
            "UNC parent traversal cannot escape the share root",
        );

        let repository = worktree_repository_key(Path::new("/repo/.git"), HostPathPlatform::Posix);
        let worktree = worktree_key(
            Path::new("/repo/.git"),
            Path::new("/repo"),
            HostPathPlatform::Posix,
        );
        assert_eq!(
            repository.as_str(),
            "645ba9aff325a5b317ca9f1e74cf2cb08fae039ffd44fce517bc46891d96343e"
        );
        assert_eq!(
            worktree.as_str(),
            "6ddf15a6da57b88326fff5d03a6f4e18c16682c3aac7e8a1c17232559d495294"
        );
        assert_eq!(
            worktree,
            worktree_key(
                Path::new("/repo/.git/"),
                Path::new("/repo/"),
                HostPathPlatform::Posix,
            )
        );
    }

    #[tokio::test]
    async fn canonical_key_resolution_distinguishes_missing_and_other_io_errors() {
        let present = tempfile::tempdir().expect("present path fixture");
        let missing = present.path().join("missing");
        let invalid = Path::new("\0not-a-path");

        let resolved =
            resolved_worktree_keys(present.path(), present.path(), HostPathPlatform::Posix)
                .await
                .expect("present paths canonicalize");
        let canonical_present = tokio::fs::canonicalize(present.path())
            .await
            .expect("canonical present fixture");
        assert_eq!(
            resolved.1,
            worktree_key(
                &canonical_present,
                &canonical_present,
                HostPathPlatform::Posix
            )
        );
        assert!(
            resolved_worktree_keys(present.path(), &missing, HostPathPlatform::Posix)
                .await
                .expect("missing worktree falls back to Git path")
                .1
                .as_str()
                .len()
                == 64
        );
        assert!(matches!(
            resolved_worktree_keys(present.path(), invalid, HostPathPlatform::Posix).await,
            Err(WorktreeIdentityError::WorktreePath { .. })
        ));
        assert!(matches!(
            resolved_worktree_keys(invalid, present.path(), HostPathPlatform::Posix).await,
            Err(WorktreeIdentityError::CommonDir { .. })
        ));
    }
}
