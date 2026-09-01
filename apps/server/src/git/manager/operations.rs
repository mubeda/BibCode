//! Serialized Git Manager mutation operations.

use std::{
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{
    GitCommandError, GitRepository, OutputPolicy, ProcessRequest, ProcessRunner, validate_pathspecs,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoAuthor {
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRequest {
    pub summary: String,
    pub description: Option<String>,
    pub amend: bool,
    pub no_verify: bool,
    pub signoff: bool,
    pub allow_empty: bool,
    pub co_authors: Vec<CoAuthor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UndoCommitDraft {
    pub summary: String,
    pub description: String,
    pub co_authors: Vec<CoAuthor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscardRequest {
    pub cwd: PathBuf,
    pub paths: Vec<String>,
    pub permit_permanent: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DiscardOutcome {
    pub trashed: Vec<String>,
    pub permanently_discarded: Vec<String>,
    pub trash_unavailable: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("the operating-system trash is unavailable")]
pub struct TrashUnavailable;

pub type FileTrashFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), TrashUnavailable>> + Send + 'a>>;

pub trait FileTrash: Send + Sync {
    fn trash<'a>(
        &'a self,
        path: PathBuf,
        cancellation: &'a CancellationToken,
    ) -> FileTrashFuture<'a>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeFileTrash {
    runner: ProcessRunner,
}

impl FileTrash for NativeFileTrash {
    fn trash<'a>(
        &'a self,
        path: PathBuf,
        cancellation: &'a CancellationToken,
    ) -> FileTrashFuture<'a> {
        Box::pin(async move {
            let request = native_trash_request(&path).await?;
            self.runner
                .run(request, cancellation)
                .await
                .map(|_| ())
                .map_err(|_| TrashUnavailable)
        })
    }
}

#[derive(Debug, Error)]
pub enum DiscardError {
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

#[must_use]
pub fn commit_arguments(request: &CommitRequest) -> Vec<String> {
    let mut args = vec!["commit".to_owned()];
    if request.amend {
        args.push("--amend".to_owned());
    }
    if request.no_verify {
        args.push("--no-verify".to_owned());
    }
    if request.signoff {
        args.push("--signoff".to_owned());
    }
    if request.allow_empty {
        args.push("--allow-empty".to_owned());
    }
    args.extend(["-F".to_owned(), "-".to_owned()]);
    args
}

#[must_use]
pub fn commit_message_body(request: &CommitRequest) -> String {
    let mut message = request.summary.clone();
    if let Some(description) = request
        .description
        .as_deref()
        .filter(|description| !description.is_empty())
    {
        message.push_str("\n\n");
        message.push_str(description);
    }
    for (index, co_author) in request.co_authors.iter().enumerate() {
        if index == 0 {
            message.push_str("\n\n");
        } else {
            message.push('\n');
        }
        message.push_str("Co-Authored-By: ");
        message.push_str(&co_author.name);
        message.push_str(" <");
        message.push_str(&co_author.email);
        message.push('>');
    }
    message.push('\n');
    message
}

#[must_use]
pub fn parse_undo_commit_message(message: &str) -> UndoCommitDraft {
    let mut lines = message
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let trailer_start = lines
        .iter()
        .rposition(|line| line.trim().is_empty())
        .map_or(lines.len(), |index| index + 1);
    let trailer_block = &lines[trailer_start..];
    let has_coauthor_trailers = !trailer_block.is_empty()
        && trailer_block.iter().all(|line| is_trailer_line(line))
        && trailer_block
            .iter()
            .any(|line| parse_coauthor_trailer(line).is_some());
    let mut retained = Vec::new();
    let mut co_authors = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        if has_coauthor_trailers
            && index >= trailer_start
            && let Some(co_author) = parse_coauthor_trailer(line)
        {
            co_authors.push(co_author);
        } else {
            retained.push(line);
        }
    }

    let summary = retained.first().copied().unwrap_or_default().to_owned();
    let mut description = retained.get(1..).unwrap_or_default();
    while description
        .first()
        .is_some_and(|line| line.trim().is_empty())
    {
        description = &description[1..];
    }
    while description
        .last()
        .is_some_and(|line| line.trim().is_empty())
    {
        description = &description[..description.len() - 1];
    }
    UndoCommitDraft {
        summary,
        description: description.join("\n"),
        co_authors,
    }
}

fn is_trailer_line(line: &str) -> bool {
    line.split_once(':').is_some_and(|(key, value)| {
        !value.trim().is_empty()
            && !key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn parse_coauthor_trailer(line: &str) -> Option<CoAuthor> {
    let (key, value) = line.split_once(':')?;
    if !key.eq_ignore_ascii_case("Co-Authored-By") {
        return None;
    }
    let value = value.trim();
    let email_end = value.strip_suffix('>')?;
    let email_start = email_end.rfind('<')?;
    let name = email_end[..email_start].trim();
    let email = email_end[email_start + 1..].trim();
    (!name.is_empty() && !email.is_empty()).then(|| CoAuthor {
        name: name.to_owned(),
        email: email.to_owned(),
    })
}

pub async fn discard_paths(
    repository: &GitRepository,
    trash: Arc<dyn FileTrash>,
    request: DiscardRequest,
    cancellation: &CancellationToken,
) -> Result<DiscardOutcome, DiscardError> {
    validate_pathspecs("GitManager.discard", &request.cwd, &request.paths)?;
    let tracked = repository
        .git_manager_tracked_paths(&request.cwd, &request.paths, cancellation)
        .await?;
    let mut outcome = DiscardOutcome::default();
    let mut restore_only = Vec::new();
    for path in &request.paths {
        let absolute_path = request.cwd.join(path);
        let tracked_path = tracked
            .iter()
            .any(|candidate| path_matches(path, candidate));
        if tracked_path
            && matches!(
                tokio::fs::symlink_metadata(&absolute_path).await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            )
        {
            restore_only.push(path.clone());
            continue;
        }
        match trash.trash(absolute_path, cancellation).await {
            Ok(()) => outcome.trashed.push(path.clone()),
            Err(_) if request.permit_permanent => {
                outcome.permanently_discarded.push(path.clone());
            }
            Err(_) => outcome.trash_unavailable.push(path.clone()),
        }
    }

    let mut discarded_paths = outcome.trashed.clone();
    discarded_paths.extend(outcome.permanently_discarded.iter().cloned());
    discarded_paths.extend(restore_only);
    if discarded_paths.is_empty() {
        return Ok(outcome);
    }
    let tracked_to_unstage = tracked
        .into_iter()
        .filter(|tracked_path| {
            discarded_paths
                .iter()
                .any(|path| path_matches(path, tracked_path))
        })
        .collect::<Vec<_>>();
    repository
        .unstage_files(&request.cwd, &tracked_to_unstage, cancellation)
        .await?;
    let tracked_to_restore = repository
        .git_manager_tracked_paths(&request.cwd, &discarded_paths, cancellation)
        .await?;
    repository
        .git_manager_restore_tracked_paths(&request.cwd, &tracked_to_restore, cancellation)
        .await?;
    if !outcome.permanently_discarded.is_empty() {
        repository
            .discard_files(&request.cwd, &outcome.permanently_discarded, cancellation)
            .await?;
    }
    Ok(outcome)
}

fn path_matches(requested: &str, candidate: &str) -> bool {
    candidate == requested
        || candidate
            .strip_prefix(requested)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

async fn native_trash_request(path: &Path) -> Result<ProcessRequest, TrashUnavailable> {
    let cwd = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or(TrashUnavailable)?
        .to_path_buf();
    let (command, args) = native_trash_command(path).await?;
    Ok(ProcessRequest {
        operation: "GitManager.discard.trash".to_owned(),
        command,
        args,
        cwd,
        env: Vec::new(),
        stdin: None,
        timeout: Duration::from_secs(30),
        max_output_bytes: 64 * 1024,
        output_policy: OutputPolicy::Truncate,
        append_truncation_marker: false,
        allow_non_zero_exit: false,
    })
}

#[cfg(target_os = "linux")]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Ok((
        PathBuf::from("gio"),
        vec![OsString::from("trash"), OsString::from("--"), path.into()],
    ))
}

#[cfg(target_os = "macos")]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Ok((
        PathBuf::from("/usr/bin/osascript"),
        vec![
            OsString::from("-e"),
            OsString::from("on run argv"),
            OsString::from("-e"),
            OsString::from("tell application \"Finder\" to delete POSIX file (item 1 of argv)"),
            OsString::from("-e"),
            OsString::from("end run"),
            OsString::from("--"),
            path.into(),
        ],
    ))
}

#[cfg(windows)]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| TrashUnavailable)?;
    let method = if metadata.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::{method}($args[0], \
         [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, \
         [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
    );
    Ok((
        PathBuf::from("powershell.exe"),
        vec![
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-Command"),
            OsString::from(script),
            path.into(),
        ],
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn native_trash_command(_path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Err(TrashUnavailable)
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
        sync::{Arc, Mutex},
    };

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::GitRepository;

    struct RecordingTrash {
        destination: PathBuf,
        trashed: Mutex<Vec<PathBuf>>,
    }

    struct UnavailableTrash;

    impl FileTrash for UnavailableTrash {
        fn trash<'a>(
            &'a self,
            _path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async { Err(TrashUnavailable) })
        }
    }

    impl FileTrash for RecordingTrash {
        fn trash<'a>(
            &'a self,
            path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async move {
                let destination = self.destination.join(
                    path.file_name()
                        .expect("discard fixture path has a file name"),
                );
                tokio::fs::rename(&path, destination)
                    .await
                    .map_err(|_| TrashUnavailable)?;
                self.trashed
                    .lock()
                    .expect("recording trash mutex")
                    .push(path);
                Ok(())
            })
        }
    }

    #[test]
    fn builds_commit_arguments_from_the_request_options() {
        let request = CommitRequest {
            summary: "Fix the parser".into(),
            description: Some("Handles NUL records.".into()),
            amend: true,
            no_verify: true,
            signoff: true,
            allow_empty: false,
            co_authors: vec![CoAuthor {
                name: "Ann Author".into(),
                email: "ann@example.test".into(),
            }],
        };
        let args = commit_arguments(&request);
        assert_eq!(args[0], "commit");
        assert!(args.contains(&"--amend".to_owned()));
        assert!(args.contains(&"--no-verify".to_owned()));
        assert!(args.contains(&"--signoff".to_owned()));
        assert!(!args.contains(&"--allow-empty".to_owned()));
        assert!(args.contains(&"-F".to_owned()) && args.contains(&"-".to_owned()));
        assert_eq!(
            commit_message_body(&request),
            "Fix the parser\n\nHandles NUL records.\n\nCo-Authored-By: Ann Author <ann@example.test>\n"
        );
    }

    #[test]
    fn builds_several_coauthors_as_one_trailing_block() {
        let request = CommitRequest {
            summary: "Fix the parser".into(),
            description: Some("Handles trailer blocks.".into()),
            amend: false,
            no_verify: false,
            signoff: false,
            allow_empty: false,
            co_authors: vec![
                CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                },
                CoAuthor {
                    name: "Bob Builder".into(),
                    email: "bob@example.test".into(),
                },
            ],
        };

        assert_eq!(
            commit_message_body(&request),
            "Fix the parser\n\nHandles trailer blocks.\n\n\
             Co-Authored-By: Ann Author <ann@example.test>\n\
             Co-Authored-By: Bob Builder <bob@example.test>\n"
        );
    }

    #[test]
    fn splits_a_message_without_trailers_unchanged() {
        assert_eq!(
            parse_undo_commit_message("Fix the parser\n\nHandles NUL records.\n"),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: Vec::new(),
            }
        );
    }

    #[test]
    fn splits_one_trailing_coauthor_from_the_description() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nHandles NUL records.\n\n\
                 Co-Authored-By: Ann Author <ann@example.test>\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                }],
            }
        );
    }

    #[test]
    fn splits_several_coauthors_from_one_trailing_block() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nHandles NUL records.\n\n\
                 Co-Authored-By: Ann Author <ann@example.test>\n\
                 Co-Authored-By: Bob Builder <bob@example.test>\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![
                    CoAuthor {
                        name: "Ann Author".into(),
                        email: "ann@example.test".into(),
                    },
                    CoAuthor {
                        name: "Bob Builder".into(),
                        email: "bob@example.test".into(),
                    },
                ],
            }
        );
    }

    #[test]
    fn preserves_a_coauthor_shaped_line_in_the_middle_of_the_body() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nBefore the example.\n\
                 Co-Authored-By: Documentation Example <docs@example.test>\n\
                 After the example.\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Before the example.\n\
                              Co-Authored-By: Documentation Example <docs@example.test>\n\
                              After the example."
                    .into(),
                co_authors: Vec::new(),
            }
        );
    }

    #[test]
    fn ignores_trailing_whitespace_around_the_trailer_block() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\r\n\r\nHandles NUL records.\r\n \t\r\n\
                 Co-Authored-By: Ann Author <ann@example.test>   \r\n \t\r\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                }],
            }
        );
    }

    #[test]
    fn restores_the_commit_draft_without_coauthor_trailers() {
        let draft = parse_undo_commit_message(
            "Fix the parser\n\nHandles NUL records.\n\
             Co-Authored-By: Documentation Example <docs@example.test>\n\
             explains the trailer syntax above.\n\n\
             Co-Authored-By: Ann Author <ann@example.test>\n\
             Signed-off-by: Dev User <dev@example.test>\n\
             Co-Authored-By: Bob Builder <bob@example.test>\n",
        );

        assert_eq!(draft.summary, "Fix the parser");
        assert_eq!(
            draft.description,
            "Handles NUL records.\nCo-Authored-By: Documentation Example <docs@example.test>\n\
             explains the trailer syntax above.\n\nSigned-off-by: Dev User <dev@example.test>"
        );
        assert_eq!(
            draft.co_authors,
            [
                CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                },
                CoAuthor {
                    name: "Bob Builder".into(),
                    email: "bob@example.test".into(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn discard_trashes_files_then_restores_tracked_content() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "Git Manager Test")
                .env("GIT_AUTHOR_EMAIL", "git-manager@example.test")
                .env("GIT_COMMITTER_NAME", "Git Manager Test")
                .env("GIT_COMMITTER_EMAIL", "git-manager@example.test")
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("tracked.txt"), "changed\n")
            .expect("changed tracked file");
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n")
            .expect("untracked file");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });

        let result = discard_paths(
            &GitRepository::default(),
            trash,
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["tracked.txt".into(), "untracked.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("discard succeeds");

        assert_eq!(result.trashed, ["tracked.txt", "untracked.txt"]);
        assert!(result.permanently_discarded.is_empty());
        assert!(result.trash_unavailable.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.path().join("tracked.txt"))
                .expect("tracked file restored"),
            "base\n"
        );
        assert!(!fixture.path().join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn discard_requires_permission_before_permanently_removing_an_untracked_file() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(
            fixture.path(),
            &[
                "-c",
                "user.name=Git Manager Test",
                "-c",
                "user.email=git-manager@example.test",
                "commit",
                "-q",
                "-m",
                "base",
            ],
        );
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n")
            .expect("untracked file");
        let repository = GitRepository::default();

        let unavailable = discard_paths(
            &repository,
            Arc::new(UnavailableTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["untracked.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("trash unavailability is an outcome");
        assert_eq!(unavailable.trash_unavailable, ["untracked.txt"]);
        assert!(fixture.path().join("untracked.txt").exists());

        let permanent = discard_paths(
            &repository,
            Arc::new(UnavailableTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["untracked.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("confirmed permanent discard succeeds");
        assert_eq!(permanent.permanently_discarded, ["untracked.txt"]);
        assert!(!fixture.path().join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn discard_restores_an_absent_tracked_file_without_trash_confirmation() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(
            fixture.path(),
            &[
                "-c",
                "user.name=Git Manager Test",
                "-c",
                "user.email=git-manager@example.test",
                "commit",
                "-q",
                "-m",
                "base",
            ],
        );
        let repository = GitRepository::default();

        for permit_permanent in [false, true] {
            std::fs::remove_file(fixture.path().join("tracked.txt")).expect("delete tracked file");
            let outcome = discard_paths(
                &repository,
                Arc::new(UnavailableTrash),
                DiscardRequest {
                    cwd: fixture.path().to_path_buf(),
                    paths: vec!["tracked.txt".into()],
                    permit_permanent,
                },
                &CancellationToken::new(),
            )
            .await
            .expect("deleted tracked file is restored");

            assert!(outcome.trash_unavailable.is_empty());
            assert!(outcome.permanently_discarded.is_empty());
            assert_eq!(
                std::fs::read_to_string(fixture.path().join("tracked.txt"))
                    .expect("tracked file restored"),
                "base\n"
            );
        }
    }
}
