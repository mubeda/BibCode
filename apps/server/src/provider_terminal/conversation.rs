//! The conversation of a Claude AI Terminal's CLI, read for a person's Second opinion or Hand
//! off (spec R112). The path comes from the CLI's own hook, so it is untrusted: it is read only
//! for the session the status hooks bound, only as a direct child of the provider's `projects`
//! folder, never through a symbolic link, and within [`MAX_TRANSCRIPT_BYTES`].

use std::{ffi::OsStr, path::Path};

use super::ObservedConversation;
use crate::{
    agent_sessions::{AgentSessionProvider, ParsedSession, parse_transcript},
    production::thread_context::{HandoffText, handoff_text_from_texts},
    workspace::beneath::{Dir, Open, Root, is_escape},
};

/// The largest transcript read, in bytes.
pub(crate) const MAX_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;

/// A CLI conversation as a handoff text and its last answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConversationText {
    pub session_id: String,
    pub last_answer: Option<String>,
    pub handoff: HandoffText,
}

/// Why a conversation was not read. Never logged: the caller falls back to the output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConversationRefusal {
    NoObservedSession,
    SessionMismatch,
    NotATranscriptFile,
    OutsideProviderFolder,
    SymbolicLink,
    TooLarge,
    Unreadable,
    Empty,
}

/// Reads the conversation of `observed` when it is `expected_session` (the session the status
/// hooks bound now) and its transcript lies directly in a project folder of
/// `<config_dir>/projects`.
pub(crate) fn read_claude_conversation(
    observed: &ObservedConversation,
    expected_session: &str,
    config_dir: &Path,
) -> Result<ConversationText, ConversationRefusal> {
    read_claude_conversation_with(observed, expected_session, config_dir, &|| {})
}

/// [`read_claude_conversation`], running `before_open` after every check on the path and before
/// the file is opened: a test swaps the file there.
fn read_claude_conversation_with(
    observed: &ObservedConversation,
    expected_session: &str,
    config_dir: &Path,
    before_open: &dyn Fn(),
) -> Result<ConversationText, ConversationRefusal> {
    use ConversationRefusal as Refusal;

    if expected_session.is_empty() || observed.session_id != expected_session {
        return Err(Refusal::SessionMismatch);
    }
    let path = &observed.transcript_path;
    let (Some(name), Some(folder)) = (path.file_name(), path.parent()) else {
        return Err(Refusal::NotATranscriptFile);
    };
    if path.file_stem() != Some(OsStr::new(expected_session))
        || path.extension() != Some(OsStr::new("jsonl"))
    {
        return Err(Refusal::NotATranscriptFile);
    }
    // Links above the project folder (a linked config folder) are resolved below; the project
    // folder and the file are never links.
    for entry in [path.as_path(), folder] {
        let metadata = std::fs::symlink_metadata(entry).map_err(|_| Refusal::Unreadable)?;
        if metadata.file_type().is_symlink() {
            return Err(Refusal::SymbolicLink);
        }
    }
    let projects =
        std::fs::canonicalize(config_dir.join("projects")).map_err(|_| Refusal::Unreadable)?;
    let folder = std::fs::canonicalize(folder).map_err(|_| Refusal::Unreadable)?;
    if folder.parent() != Some(projects.as_path()) {
        return Err(Refusal::OutsideProviderFolder);
    }
    let opened = |error: std::io::Error| {
        if is_escape(&error) {
            Refusal::SymbolicLink
        } else {
            Refusal::Unreadable
        }
    };
    let root = Root::new(&projects).map_err(opened)?;
    let dir = Dir::open(&root, &folder, false).map_err(opened)?;
    before_open();
    // Opened through the held folder and refusing a link, so a swap after the checks above
    // follows nothing; what was opened is checked on the open file itself.
    let file = dir.open_file(name, Open::Read).map_err(opened)?;
    let metadata = file.metadata().map_err(|_| Refusal::Unreadable)?;
    if !metadata.is_file() {
        return Err(Refusal::NotATranscriptFile);
    }
    if metadata.len() > MAX_TRANSCRIPT_BYTES {
        return Err(Refusal::TooLarge);
    }
    if metadata.len() == 0 {
        return Err(Refusal::Empty);
    }
    let parsed = parse_transcript(AgentSessionProvider::ClaudeAgent, file, expected_session)
        .ok_or(Refusal::Empty)?;
    if parsed.session_id != expected_session {
        return Err(Refusal::SessionMismatch);
    }
    Ok(conversation_text(parsed))
}

fn conversation_text(parsed: ParsedSession) -> ConversationText {
    let messages = parsed
        .messages
        .iter()
        .map(|message| (message.role, message.text.as_str()))
        .collect::<Vec<_>>();
    let mut handoff = handoff_text_from_texts(&messages);
    // The parser keeps the first message and the newest ones; the rest still count as left out.
    let dropped = parsed.message_count.saturating_sub(parsed.messages.len());
    if dropped > 0 {
        handoff.left_out += dropped;
        handoff.gap = handoff.first_message.is_some();
        handoff.truncated = true;
    }
    ConversationText {
        last_answer: parsed
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant")
            .map(|message| message.text.clone()),
        session_id: parsed.session_id,
        handoff,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::production::thread_context::handoff_text_from_texts;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_SESSION: &str = "22222222-2222-4222-8222-222222222222";

    fn record(session: &str, role: &str, text: &str) -> String {
        let content = if role == "assistant" {
            serde_json::json!([{ "type": "text", "text": text }])
        } else {
            serde_json::json!(text)
        };
        serde_json::json!({
            "type": role,
            "sessionId": session,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "message": { "role": role, "content": content },
        })
        .to_string()
    }

    fn transcript(session: &str, messages: &[(&str, &str)]) -> String {
        messages
            .iter()
            .map(|(role, text)| record(session, role, text) + "\n")
            .collect()
    }

    /// A config folder holding `projects/-work-sample/{session}.jsonl`.
    struct Config {
        dir: tempfile::TempDir,
    }

    impl Config {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("config folder");
            std::fs::create_dir_all(dir.path().join("projects/-work-sample")).expect("project");
            Self { dir }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn project(&self) -> PathBuf {
            self.path().join("projects/-work-sample")
        }

        fn write(&self, session: &str, body: &str) -> PathBuf {
            let path = self.project().join(format!("{session}.jsonl"));
            std::fs::write(&path, body).expect("transcript");
            path
        }
    }

    fn observed_at(session: &str, path: PathBuf) -> ObservedConversation {
        ObservedConversation {
            session_id: session.to_owned(),
            transcript_path: path,
        }
    }

    const SHORT: [(&str, &str); 2] = [
        ("user", "Test question one"),
        ("assistant", "Test answer one"),
    ];

    #[test]
    fn reads_the_observed_session_inside_the_providers_folder() {
        let config = Config::new();
        let path = config.write(SESSION, &transcript(SESSION, &SHORT));

        let text = read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path())
            .expect("readable");

        assert_eq!(text.session_id, SESSION);
        assert_eq!(text.last_answer.as_deref(), Some("Test answer one"));
        assert_eq!(
            text.handoff.render(),
            "[user] Test question one\n[assistant] Test answer one"
        );
    }

    #[test]
    fn a_long_conversation_keeps_the_first_message_and_the_tail() {
        let first = format!("Test question {}", "q".repeat(5_000));
        let texts = (0..300)
            .map(|index| match index {
                0 => first.clone(),
                index if index % 2 == 0 => format!("Test question {index}"),
                index => format!("Test answer {index}"),
            })
            .collect::<Vec<_>>();
        let messages = texts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                let role = if index % 2 == 0 { "user" } else { "assistant" };
                (role, text.as_str())
            })
            .collect::<Vec<_>>();
        let config = Config::new();
        let path = config.write(SESSION, &transcript(SESSION, &messages));

        let text = read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path())
            .expect("readable");

        let first_line = text.handoff.first_message.clone().expect("first message");
        assert_eq!(
            first_line,
            format!("[user] {} [truncated]", &first[..4_000]),
            "the first message is cut at 4,000 characters"
        );
        assert!(text.handoff.gap);
        assert_eq!(text.handoff.tail.len(), 40);
        assert!(
            text.handoff
                .tail
                .iter()
                .map(|line| line.chars().count() + 1)
                .sum::<usize>()
                <= 24_000
        );
        assert_eq!(text.handoff.left_out, 300 - 1 - 40);
        assert_eq!(
            text.handoff.tail.last().unwrap(),
            "[assistant] Test answer 299"
        );
        assert_eq!(text.handoff, handoff_text_from_texts(&messages));
    }

    #[test]
    fn another_session_is_not_read() {
        let config = Config::new();
        let path = config.write(SESSION, &transcript(SESSION, &SHORT));

        let refused =
            read_claude_conversation(&observed_at(SESSION, path), OTHER_SESSION, config.path());

        assert_eq!(refused.err(), Some(ConversationRefusal::SessionMismatch));
    }

    #[test]
    fn records_of_another_session_are_not_read() {
        let config = Config::new();
        let path = config.write(SESSION, &transcript(OTHER_SESSION, &SHORT));

        let refused = read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());

        assert_eq!(refused.err(), Some(ConversationRefusal::SessionMismatch));
    }

    #[test]
    fn a_file_in_another_folder_is_not_read() {
        let config = Config::new();
        let elsewhere = config.path().join("elsewhere/-work-sample");
        std::fs::create_dir_all(&elsewhere).expect("sibling");
        let path = elsewhere.join(format!("{SESSION}.jsonl"));
        std::fs::write(&path, transcript(SESSION, &SHORT)).expect("transcript");
        let nested = config.project().join("nested");
        std::fs::create_dir_all(&nested).expect("nested");
        let deeper = nested.join(format!("{SESSION}.jsonl"));
        std::fs::write(&deeper, transcript(SESSION, &SHORT)).expect("transcript");

        for path in [path, deeper] {
            let refused =
                read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());
            assert_eq!(
                refused.err(),
                Some(ConversationRefusal::OutsideProviderFolder)
            );
        }
    }

    #[test]
    fn a_file_whose_name_is_not_the_session_is_not_read() {
        let config = Config::new();
        let renamed = config.write(OTHER_SESSION, &transcript(SESSION, &SHORT));
        let text_file = config.project().join(format!("{SESSION}.txt"));
        std::fs::write(&text_file, transcript(SESSION, &SHORT)).expect("transcript");

        for path in [renamed, text_file] {
            let refused =
                read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());
            assert_eq!(refused.err(), Some(ConversationRefusal::NotATranscriptFile));
        }
    }

    #[test]
    fn a_file_over_the_bound_is_not_read() {
        let config = Config::new();
        let path = config.write(SESSION, &transcript(SESSION, &SHORT));
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_len(MAX_TRANSCRIPT_BYTES + 1))
            .expect("sparse file");

        let refused = read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());

        assert_eq!(refused.err(), Some(ConversationRefusal::TooLarge));
    }

    #[test]
    fn an_unreadable_or_empty_file_is_refused() {
        let config = Config::new();
        let empty = config.write(SESSION, "");
        let refused =
            read_claude_conversation(&observed_at(SESSION, empty.clone()), SESSION, config.path());
        assert_eq!(refused.err(), Some(ConversationRefusal::Empty));

        std::fs::write(&empty, "not json\n{\"type\":\"summary\"}\n").expect("no messages");
        let refused =
            read_claude_conversation(&observed_at(SESSION, empty.clone()), SESSION, config.path());
        assert_eq!(refused.err(), Some(ConversationRefusal::Empty));

        std::fs::remove_file(&empty).expect("remove");
        let refused =
            read_claude_conversation(&observed_at(SESSION, empty.clone()), SESSION, config.path());
        assert_eq!(refused.err(), Some(ConversationRefusal::Unreadable));

        std::fs::create_dir(&empty).expect("a folder named like the transcript");
        let refused =
            read_claude_conversation(&observed_at(SESSION, empty), SESSION, config.path());
        assert!(refused.is_err(), "a folder is not a transcript");
    }

    #[test]
    fn no_observed_session_is_not_read() {
        let config = Config::new();
        let path = config.write(SESSION, &transcript(SESSION, &SHORT));
        let observed = observed_at(SESSION, path);

        let refused = read_claude_conversation(&observed, "", config.path());

        assert_eq!(refused.err(), Some(ConversationRefusal::SessionMismatch));
    }

    #[cfg(unix)]
    mod links {
        use super::*;

        /// A file holding "Test secret" outside `projects`, and a link to it.
        fn secret(config: &Config) -> PathBuf {
            let secret = config.path().join("secret.jsonl");
            std::fs::write(&secret, transcript(SESSION, &[("user", "Test secret")]))
                .expect("secret");
            secret
        }

        #[test]
        fn a_swap_between_the_check_and_the_open_is_not_followed() {
            let config = Config::new();
            let path = config.write(SESSION, &transcript(SESSION, &SHORT));
            let target = secret(&config);
            let swap = || {
                std::fs::remove_file(&path).expect("remove");
                std::os::unix::fs::symlink(&target, &path).expect("link");
            };

            let result = read_claude_conversation_with(
                &observed_at(SESSION, path.clone()),
                SESSION,
                config.path(),
                &swap,
            );

            let Err(refusal) = result else {
                let text = result.unwrap();
                panic!(
                    "the swapped link was followed; secret read: {}",
                    text.handoff.render().contains("Test secret")
                );
            };
            assert!(matches!(
                refusal,
                ConversationRefusal::SymbolicLink | ConversationRefusal::Unreadable
            ));
        }

        #[test]
        fn a_link_to_a_file_elsewhere_is_not_followed() {
            let config = Config::new();
            let target = secret(&config);
            let path = config.project().join(format!("{SESSION}.jsonl"));
            std::os::unix::fs::symlink(&target, &path).expect("link");

            let refused =
                read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());

            assert_eq!(refused.err(), Some(ConversationRefusal::SymbolicLink));
        }

        #[test]
        fn a_project_folder_that_is_a_link_is_not_followed() {
            let config = Config::new();
            config.write(SESSION, &transcript(SESSION, &SHORT));
            let outside = config.path().join("outside");
            std::fs::create_dir(&outside).expect("outside");
            std::fs::write(
                outside.join(format!("{SESSION}.jsonl")),
                transcript(SESSION, &[("user", "Test secret")]),
            )
            .expect("secret");
            for (name, target) in [
                ("-linked-outside", outside),
                ("-linked-inside", config.project()),
            ] {
                let link = config.path().join("projects").join(name);
                std::os::unix::fs::symlink(&target, &link).expect("link");

                let refused = read_claude_conversation(
                    &observed_at(SESSION, link.join(format!("{SESSION}.jsonl"))),
                    SESSION,
                    config.path(),
                );

                assert_eq!(
                    refused.err(),
                    Some(ConversationRefusal::SymbolicLink),
                    "{name}"
                );
            }
        }
    }
}
