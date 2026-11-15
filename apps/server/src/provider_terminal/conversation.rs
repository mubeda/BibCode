//! The conversation of a Claude or Codex AI Terminal's CLI, read for a person's Second opinion
//! or Hand off (spec R112).
//!
//! Claude's transcript path comes from the CLI's own hook, so it is untrusted: it is read only
//! for the session the status hooks bound, only in the project folder Claude derives from the
//! terminal's own working directory (a direct child of the provider's `projects` folder), never
//! through a symbolic link, and within [`MAX_TRANSCRIPT_BYTES`]. The hook can still name another
//! session of that same working directory: those files belong to the same user and project.
//!
//! Codex is asked through its observer's own connection, for the root thread the observer
//! resumed and nothing else: [`CodexConversationHandle`] carries one request at a time into the
//! observer loop and waits at most [`CODEX_CONVERSATION_DEADLINE`].

use std::{ffi::OsStr, path::Path, sync::Arc, time::Duration};

use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

use super::ObservedConversation;
use crate::{
    agent_sessions::{AgentSessionProvider, ParsedSession, parse_transcript},
    production::thread_context::{HandoffText, handoff_text_from_texts},
    provider::environment::ClaudeProjectDirectoryName,
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
    /// The read did not reach the conversation's start, so the handoff has no first message.
    pub start_missing: bool,
}

/// Why a conversation was not read. Never logged: the caller falls back to the output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConversationRefusal {
    NoObservedSession,
    SessionMismatch,
    NotATranscriptFile,
    OutsideProviderFolder,
    /// The project folder is not the one Claude derives from the terminal's working directory.
    AnotherProject,
    SymbolicLink,
    TooLarge,
    Unreadable,
    Empty,
}

/// Reads the conversation of `observed` when it is `expected_session` (the session the status
/// hooks bound now) and its transcript lies directly in the project folder of `<config_dir>/projects`
/// that Claude keeps for `working_directory`, the folder the server launched the terminal in.
pub(crate) fn read_claude_conversation(
    observed: &ObservedConversation,
    expected_session: &str,
    config_dir: &Path,
    working_directory: &Path,
) -> Result<ConversationText, ConversationRefusal> {
    read_claude_conversation_with(
        observed,
        expected_session,
        config_dir,
        working_directory,
        &|| {},
    )
}

/// [`read_claude_conversation`], running `before_open` after every check on the path and before
/// the file is opened: a test swaps the file there.
fn read_claude_conversation_with(
    observed: &ObservedConversation,
    expected_session: &str,
    config_dir: &Path,
    working_directory: &Path,
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
    // Claude names the folder after the working directory as given and, for a linked one, as
    // resolved; a hook cannot point at another project's conversation.
    let folder_name = folder.file_name().map(OsStr::to_string_lossy);
    let own_project = std::iter::once(working_directory.to_path_buf())
        .chain(std::fs::canonicalize(working_directory).ok())
        .any(|cwd| {
            folder_name
                .as_deref()
                .is_some_and(|name| ClaudeProjectDirectoryName::of(&cwd).matches(name))
        });
    if !own_project {
        return Err(Refusal::AnotherProject);
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
    // Accepted limit: the held folder can still be renamed out of `projects` before this open,
    // but whoever can do that can as easily put the same file inside it, as the same user.
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
        start_missing: false,
    }
}

/// The longest a person waits for a Codex terminal's conversation.
pub(crate) const CODEX_CONVERSATION_DEADLINE: Duration = Duration::from_secs(5);

/// A Codex root thread's newest turns as role and text pairs, oldest first.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct CodexConversation {
    pub thread_id: String,
    pub messages: Vec<(String, String)>,
    /// The turns reach the thread's oldest one.
    pub complete: bool,
}

/// Where the observer loop sends its answer to one request.
type CodexConversationReply = oneshot::Sender<Result<CodexConversation, ConversationRefusal>>;

/// One request into a Codex observer loop. It holds the terminal's admission until the loop has
/// finished with it, so a caller that gave up cannot queue another meanwhile.
#[derive(Debug)]
pub(crate) struct CodexConversationRequest {
    reply: CodexConversationReply,
    admission: Option<OwnedSemaphorePermit>,
}

impl CodexConversationRequest {
    /// A request outside any handle, for a test that serves it directly.
    #[cfg(test)]
    pub(crate) fn detached(reply: CodexConversationReply) -> Self {
        Self {
            reply,
            admission: None,
        }
    }

    /// The caller stopped waiting, so nothing should be asked of Codex for it.
    pub(crate) fn caller_gone(&self) -> bool {
        self.reply.is_closed()
    }

    /// Frees the admission, then answers, so the caller can ask again as soon as it hears back.
    pub(crate) fn answer(self, answer: Result<CodexConversation, ConversationRefusal>) {
        let Self { reply, admission } = self;
        drop(admission);
        let _ = reply.send(answer);
    }
}

/// The way into one Codex observer's loop. It names no thread: the loop answers for its own root.
#[derive(Clone, Debug)]
pub(crate) struct CodexConversationHandle {
    requests: mpsc::Sender<CodexConversationRequest>,
    in_flight: Arc<Semaphore>,
}

impl CodexConversationHandle {
    /// A handle and the receiver its observer loop serves.
    pub(crate) fn channel() -> (Self, mpsc::Receiver<CodexConversationRequest>) {
        let (requests, receiver) = mpsc::channel(1);
        let handle = Self {
            requests,
            in_flight: Arc::new(Semaphore::new(1)),
        };
        (handle, receiver)
    }

    /// Asks the loop for the root thread's conversation. One request is in flight per terminal
    /// until the loop finished it, even when its caller gave up; another caller meanwhile is
    /// refused at once. A caller waits at most [`CODEX_CONVERSATION_DEADLINE`].
    pub(crate) async fn request(&self) -> Result<CodexConversation, ConversationRefusal> {
        let Ok(admission) = self.in_flight.clone().try_acquire_owned() else {
            return Err(ConversationRefusal::Unreadable);
        };
        let (reply, answer) = oneshot::channel();
        self.requests
            .try_send(CodexConversationRequest {
                reply,
                admission: Some(admission),
            })
            .map_err(|_| ConversationRefusal::Unreadable)?;
        tokio::time::timeout(CODEX_CONVERSATION_DEADLINE, answer)
            .await
            .map_err(|_| ConversationRefusal::Unreadable)?
            .map_err(|_| ConversationRefusal::Unreadable)?
    }
}

/// Reads a Codex terminal's conversation through its observer. A page that does not reach the
/// oldest turn has no first message, and says so.
pub(crate) async fn read_codex_conversation(
    observer: &CodexConversationHandle,
) -> Result<ConversationText, ConversationRefusal> {
    let conversation = observer.request().await?;
    if conversation.messages.is_empty() {
        return Err(ConversationRefusal::Empty);
    }
    let messages = conversation
        .messages
        .iter()
        .map(|(role, text)| (role.as_str(), text.as_str()))
        .collect::<Vec<_>>();
    let mut handoff = handoff_text_from_texts(&messages);
    if !conversation.complete {
        // The first message of the page is not the conversation's first message.
        if handoff.first_message.take().is_some() {
            handoff.left_out += 1;
        }
        handoff.gap = false;
        handoff.truncated = true;
    }
    Ok(ConversationText {
        session_id: conversation.thread_id,
        last_answer: messages
            .iter()
            .rev()
            .find(|(role, _)| *role == "assistant")
            .map(|(_, text)| (*text).to_owned()),
        handoff,
        start_missing: !conversation.complete,
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::production::thread_context::handoff_text_from_texts;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    /// The terminal's working directory, whose Claude project folder is `-work-sample`.
    const WORK_DIR: &str = "/work/sample";

    /// The reader for a terminal launched in [`WORK_DIR`].
    fn read_claude_conversation(
        observed: &ObservedConversation,
        expected_session: &str,
        config_dir: &Path,
    ) -> Result<ConversationText, ConversationRefusal> {
        super::read_claude_conversation(observed, expected_session, config_dir, Path::new(WORK_DIR))
    }
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
    fn a_transcript_of_another_working_directory_is_not_read() {
        let config = Config::new();
        let other = config.path().join("projects/-work-other");
        std::fs::create_dir_all(&other).expect("other project");
        let path = other.join(format!("{SESSION}.jsonl"));
        std::fs::write(&path, transcript(SESSION, &SHORT)).expect("transcript");

        let refused = read_claude_conversation(&observed_at(SESSION, path), SESSION, config.path());

        assert_eq!(refused.err(), Some(ConversationRefusal::AnotherProject));
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
                Path::new(WORK_DIR),
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

    mod codex_reader {
        use std::{
            collections::VecDeque,
            future::Future,
            pin::Pin,
            sync::{Arc, Mutex},
            time::Duration,
        };

        use serde_json::{Value, json};

        use super::super::*;
        use crate::provider_terminal::{
            TerminalAgentState, TerminalObserverGeneration, TerminalObserverGenerationLease,
            codex::{
                CodexRemoteClient, answer_codex_conversation, decode_codex_conversation_page,
                serve_codex_conversation_request,
            },
            conversation::CodexConversationRequest,
            model::{PromptEvidence, PromptReadiness, TerminalAgentReport},
        };

        const ROOT: &str = "thread-1";

        fn recorded_page() -> Value {
            let fixture: Value = serde_json::from_str(include_str!(
                "../../tests/fixtures/provider-terminal/codex-turns-list.json"
            ))
            .expect("fixture");
            fixture["page"].clone()
        }

        enum Reply {
            Page(Value),
            Fail(&'static str),
            Never,
        }

        /// A Codex connection that answers each request from a script and records it.
        #[derive(Default)]
        struct ScriptedClient {
            replies: VecDeque<Reply>,
            requests: Arc<Mutex<Vec<(String, Value)>>>,
            buffered: Vec<Value>,
            lost: bool,
        }

        impl ScriptedClient {
            fn answering(reply: Reply) -> Self {
                Self {
                    replies: VecDeque::from([reply]),
                    ..Self::default()
                }
            }
        }

        impl CodexRemoteClient for ScriptedClient {
            fn request(
                &mut self,
                method: &str,
                params: Value,
            ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
                self.requests
                    .lock()
                    .unwrap()
                    .push((method.to_owned(), params));
                let reply = self.replies.pop_front().unwrap_or(Reply::Never);
                Box::pin(async move {
                    match reply {
                        Reply::Page(page) => Ok(page),
                        Reply::Fail(error) => Err(error.to_owned()),
                        Reply::Never => std::future::pending().await,
                    }
                })
            }

            fn notify(
                &mut self,
                _method: &str,
            ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
                Box::pin(async { Ok(()) })
            }

            fn drain_request_buffered_notifications(&mut self) -> Vec<Value> {
                std::mem::take(&mut self.buffered)
            }

            fn take_lost_notifications(&mut self) -> bool {
                std::mem::take(&mut self.lost)
            }

            fn next(
                &mut self,
            ) -> Pin<Box<dyn Future<Output = Result<Option<Value>, String>> + Send + '_>>
            {
                Box::pin(std::future::pending())
            }
        }

        fn turn(index: usize) -> Value {
            json!({
                "id": format!("turn-{index}"),
                "items": [
                    {"type": "userMessage", "id": format!("item-{index}-1"),
                     "content": [{"type": "text", "text": format!("Test question {index}")}]},
                    {"type": "agentMessage", "id": format!("item-{index}-2"),
                     "text": format!("Test answer {index}")},
                ],
            })
        }

        /// The observer loop's side, for one request: it serves what `client` answers.
        fn serve_one(
            mut requests: tokio::sync::mpsc::Receiver<CodexConversationRequest>,
            mut client: ScriptedClient,
        ) -> tokio::task::JoinHandle<ScriptedClient> {
            tokio::spawn(async move {
                let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
                let (mut readiness, mut stale, mut reconciled) =
                    (PromptReadiness::default(), VecDeque::new(), VecDeque::new());
                let request = requests.recv().await.expect("one request");
                serve_codex_conversation_request(
                    &generation.observation(),
                    &mut readiness,
                    &mut client,
                    ROOT,
                    &mut stale,
                    &mut reconciled,
                    request,
                )
                .await;
                client
            })
        }

        #[test]
        fn codex_decodes_user_and_answer_text_from_the_recorded_page() {
            let (messages, complete) =
                decode_codex_conversation_page(recorded_page()).expect("decodable");

            let pair = |role: &str, text: &str| (role.to_owned(), text.to_owned());
            assert_eq!(
                messages,
                vec![
                    pair("user", "Test question"),
                    pair("assistant", "Test answer"),
                    pair("user", "Test question"),
                    pair("assistant", "Test answer"),
                ]
            );
            assert!(complete, "the page holds the oldest turn");
        }

        #[tokio::test]
        async fn codex_only_the_root_thread_is_requested() {
            let mut client = ScriptedClient::answering(Reply::Page(recorded_page()));
            let requests = client.requests.clone();

            let conversation = answer_codex_conversation(&mut client, ROOT)
                .await
                .expect("readable");

            assert_eq!(conversation.thread_id, ROOT);
            let requests = requests.lock().unwrap();
            assert!(!requests.is_empty());
            for (method, params) in requests.iter() {
                assert_eq!(method, "thread/turns/list");
                assert_eq!(params["threadId"], ROOT, "{params}");
                assert_eq!(params["sortDirection"], "desc");
            }
        }

        #[tokio::test]
        async fn codex_a_long_conversation_has_no_first_message_and_says_so() {
            let page = json!({
                "data": (0..20).rev().map(turn).collect::<Vec<_>>(),
                "nextCursor": "older-turns",
            });
            let (handle, requests) = CodexConversationHandle::channel();
            let observer = serve_one(requests, ScriptedClient::answering(Reply::Page(page)));

            let text = read_codex_conversation(&handle).await.expect("readable");

            observer.await.expect("observer");
            assert_eq!(text.handoff.first_message, None);
            assert!(!text.handoff.gap);
            assert!(text.start_missing);
            assert_eq!(text.last_answer.as_deref(), Some("Test answer 19"));
            assert_eq!(
                text.handoff.tail.last().map(String::as_str),
                Some("[assistant] Test answer 19")
            );
            assert_eq!(text.handoff.tail.len(), 40);
        }

        #[tokio::test]
        async fn codex_a_page_over_the_byte_bound_is_refused() {
            let mut client = ScriptedClient::answering(Reply::Fail(
                crate::provider::codex::model::CODEX_REMOTE_JSON_TOO_LARGE,
            ));
            assert_eq!(
                answer_codex_conversation(&mut client, ROOT).await.err(),
                Some(ConversationRefusal::TooLarge)
            );

            let huge =
                "x".repeat(crate::provider::codex::model::CODEX_REMOTE_MESSAGE_MAX_BYTES + 1);
            let page = json!({
                "data": [{"id": "turn-1", "items": [{"type": "agentMessage", "text": huge}]}],
                "nextCursor": null,
            });
            assert_eq!(
                decode_codex_conversation_page(page).err(),
                Some(ConversationRefusal::TooLarge)
            );
        }

        #[tokio::test(start_paused = true)]
        async fn codex_a_request_that_times_out_falls_back() {
            let started = tokio::time::Instant::now();
            let mut client = ScriptedClient::answering(Reply::Never);
            client.buffered = vec![json!({"method": "turn/started"})];
            let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
            let (mut readiness, mut stale, mut reconciled) =
                (PromptReadiness::default(), VecDeque::new(), VecDeque::new());
            let (reply, answer) = tokio::sync::oneshot::channel();

            serve_codex_conversation_request(
                &generation.observation(),
                &mut readiness,
                &mut client,
                ROOT,
                &mut stale,
                &mut reconciled,
                CodexConversationRequest::detached(reply),
            )
            .await;

            assert!(started.elapsed() <= CODEX_CONVERSATION_DEADLINE);
            assert_eq!(
                answer.await.expect("answered"),
                Err(ConversationRefusal::Unreadable)
            );
            assert_eq!(
                reconciled,
                [json!({"method": "turn/started"})],
                "what the request buffered is still read"
            );

            // The caller gives up within the same bound when the loop never answers.
            let (handle, _requests) = CodexConversationHandle::channel();
            let asked = tokio::time::Instant::now();
            assert_eq!(handle.request().await, Err(ConversationRefusal::Unreadable));
            assert!(asked.elapsed() <= CODEX_CONVERSATION_DEADLINE);
        }

        #[tokio::test(start_paused = true)]
        async fn codex_a_second_request_while_one_is_in_flight_is_refused() {
            let (handle, mut requests) = CodexConversationHandle::channel();
            let first = tokio::spawn({
                let handle = handle.clone();
                async move { handle.request().await }
            });
            // The observer loop took the first request and is serving it.
            let _serving = requests.recv().await.expect("first request");

            let second = tokio::time::timeout(Duration::from_millis(1), handle.request()).await;

            assert_eq!(second, Ok(Err(ConversationRefusal::Unreadable)));
            assert!(
                requests.try_recv().is_err(),
                "the second never reached the loop"
            );
            first.abort();
        }

        #[tokio::test(start_paused = true)]
        async fn codex_a_caller_that_gave_up_keeps_the_admission_until_the_observer_finished() {
            let (handle, mut requests) = CodexConversationHandle::channel();
            let first = tokio::spawn({
                let handle = handle.clone();
                async move { handle.request().await }
            });
            // The observer loop took the first request and is still serving it.
            let _serving = requests.recv().await.expect("first request");
            assert_eq!(
                first.await.expect("first caller"),
                Err(ConversationRefusal::Unreadable),
                "the caller gave up after its deadline"
            );

            let retry = tokio::time::timeout(Duration::from_millis(1), handle.request()).await;

            assert_eq!(
                retry,
                Ok(Err(ConversationRefusal::Unreadable)),
                "a retry while the observer still serves the first falls back at once"
            );
            assert!(
                requests.try_recv().is_err(),
                "the retry never reached the loop"
            );
        }

        #[tokio::test(start_paused = true)]
        async fn codex_a_dequeued_request_whose_caller_is_gone_sends_nothing() {
            let (handle, requests) = CodexConversationHandle::channel();
            assert_eq!(handle.request().await, Err(ConversationRefusal::Unreadable));

            let client = serve_one(requests, ScriptedClient::answering(Reply::Never))
                .await
                .expect("observer");

            assert!(
                client.requests.lock().unwrap().is_empty(),
                "the provider was asked for a caller that gave up"
            );
        }

        #[tokio::test]
        async fn codex_a_request_that_buffers_past_the_backlog_limit_stays_bounded() {
            let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
            let lease = generation.observation();
            let mut readiness = PromptReadiness::default();
            idle_and_ready(&lease, &mut readiness).await;
            let mut client = ScriptedClient::answering(Reply::Page(recorded_page()));
            client.buffered = (0..300)
                .map(|index| json!({ "method": "item/completed", "index": index }))
                .collect();
            let (mut stale, mut reconciled) = (VecDeque::new(), VecDeque::new());

            serve(
                &lease,
                &mut readiness,
                &mut client,
                &mut stale,
                &mut reconciled,
            )
            .await
            .expect("readable");
            next_wait(&lease, &mut readiness).await;

            assert!(
                stale.len() + reconciled.len() <= 256,
                "{} events kept",
                stale.len() + reconciled.len()
            );
            assert!(
                !reads_ready(&lease),
                "dropped events leave the root's state unknown"
            );
        }

        /// Text of the conversation never reaches a log. In a process of its own, so no sibling
        /// test can turn a callsite off for this capture.
        #[tokio::test]
        async fn codex_no_text_is_logged() {
            let Some(child) = crate::test_support::in_own_process(
                "provider_terminal::conversation::tests::codex_reader::codex_no_text_is_logged",
            ) else {
                return;
            };
            let log = CapturedLog::default();
            let _logging = tracing::subscriber::set_default(
                tracing_subscriber::fmt()
                    .with_ansi(false)
                    .with_max_level(tracing::Level::TRACE)
                    .with_writer({
                        let log = log.clone();
                        move || log.clone()
                    })
                    .finish(),
            );
            for reply in [
                Reply::Page(recorded_page()),
                Reply::Fail("Test question in an error"),
            ] {
                let (handle, requests) = CodexConversationHandle::channel();
                let observer = serve_one(requests, ScriptedClient::answering(reply));
                let _ = read_codex_conversation(&handle).await;
                observer.await.expect("observer");
            }
            tracing::info!("the capture saw the run");

            let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
            assert!(log.contains("the capture saw the run"), "{log}");
            for canary in ["Test question", "Test answer"] {
                assert!(!log.contains(canary), "{canary} reached the log:\n{log}");
            }
            child.complete();
        }

        #[derive(Clone, Default)]
        struct CapturedLog(Arc<Mutex<Vec<u8>>>);

        impl std::io::Write for CapturedLog {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        fn reads_ready(generation: &TerminalObserverGenerationLease) -> bool {
            generation
                .subscribe_agent_status()
                .borrow()
                .is_some_and(|observation| observation.ready_for_prompt)
        }

        /// The root's latest event says the CLI waits, and a wait on the live stream made the
        /// terminal ready.
        async fn idle_and_ready(
            generation: &TerminalObserverGenerationLease,
            readiness: &mut PromptReadiness,
        ) {
            readiness.observe(
                generation,
                TerminalAgentReport::Set(TerminalAgentState::Done, false),
                true,
                PromptEvidence::Fresh,
            );
            next_wait(generation, readiness).await;
        }

        /// One wait on a live stream with nothing to read.
        async fn next_wait(
            generation: &TerminalObserverGenerationLease,
            readiness: &mut PromptReadiness,
        ) {
            let _ = tokio::time::timeout(
                Duration::ZERO,
                readiness.wait(generation, std::future::pending::<()>()),
            )
            .await;
        }

        async fn serve(
            generation: &TerminalObserverGenerationLease,
            readiness: &mut PromptReadiness,
            client: &mut ScriptedClient,
            stale: &mut VecDeque<Value>,
            reconciled: &mut VecDeque<Value>,
        ) -> Result<CodexConversation, ConversationRefusal> {
            let (reply, answer) = tokio::sync::oneshot::channel();
            serve_codex_conversation_request(
                generation,
                readiness,
                client,
                ROOT,
                stale,
                reconciled,
                CodexConversationRequest::detached(reply),
            )
            .await;
            answer.await.expect("answered")
        }

        #[tokio::test]
        async fn codex_a_ready_terminal_reads_ready_again_at_the_next_wait() {
            let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
            let lease = generation.observation();
            let mut readiness = PromptReadiness::default();
            idle_and_ready(&lease, &mut readiness).await;
            assert!(reads_ready(&lease));
            let mut client = ScriptedClient::answering(Reply::Page(recorded_page()));

            let (mut stale, mut reconciled) = (VecDeque::new(), VecDeque::new());
            serve(
                &lease,
                &mut readiness,
                &mut client,
                &mut stale,
                &mut reconciled,
            )
            .await
            .expect("readable");

            assert!(!reads_ready(&lease), "the request withdrew readiness");
            next_wait(&lease, &mut readiness).await;
            assert!(reads_ready(&lease), "the next wait made it ready again");
        }

        #[tokio::test]
        async fn codex_a_terminal_whose_readiness_was_taken_stays_not_ready() {
            let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
            let lease = generation.observation();
            let mut readiness = PromptReadiness::default();
            idle_and_ready(&lease, &mut readiness).await;
            // The pointer typed its line, which takes the ready period.
            assert!(lease.clear_ready_for_prompt());
            let mut client = ScriptedClient::answering(Reply::Page(recorded_page()));

            let (mut stale, mut reconciled) = (VecDeque::new(), VecDeque::new());
            serve(
                &lease,
                &mut readiness,
                &mut client,
                &mut stale,
                &mut reconciled,
            )
            .await
            .expect("readable");
            next_wait(&lease, &mut readiness).await;

            assert!(!reads_ready(&lease), "a request handed out taken readiness");
        }

        #[tokio::test]
        async fn codex_buffered_notifications_keep_their_order_or_go_stale_when_lost() {
            let generation = TerminalObserverGeneration::new("thread".into(), "term".into());
            let lease = generation.observation();
            let note = |index: usize| json!({ "method": "item/completed", "index": index });
            for lost in [false, true] {
                let mut readiness = PromptReadiness::default();
                idle_and_ready(&lease, &mut readiness).await;
                let mut client = ScriptedClient::answering(Reply::Page(recorded_page()));
                client.buffered = vec![note(1), note(2)];
                client.lost = lost;
                let (mut stale, mut reconciled) = (VecDeque::new(), VecDeque::from([note(0)]));

                serve(
                    &lease,
                    &mut readiness,
                    &mut client,
                    &mut stale,
                    &mut reconciled,
                )
                .await
                .expect("readable");
                next_wait(&lease, &mut readiness).await;

                let all = VecDeque::from([note(0), note(1), note(2)]);
                if lost {
                    assert_eq!((stale, reconciled), (all, VecDeque::new()));
                    assert!(!reads_ready(&lease), "a loss forgets the idle event");
                } else {
                    assert_eq!((stale, reconciled), (VecDeque::new(), all));
                    assert!(reads_ready(&lease));
                }
            }
        }
    }
}
