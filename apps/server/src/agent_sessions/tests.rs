use std::{fs, path::Path, time::SystemTime};

use serde_json::{Value, json};

use super::*;

const CLAUDE_ID: &str = "0f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const CODEX_ID: &str = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FALLBACK: &str = "2026-10-01T00:00:00Z";

fn lines(records: &[Value]) -> String {
    records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse(provider: AgentSessionProvider, records: &[Value]) -> Option<ParsedSession> {
    let text = lines(records);
    let canonical = match provider {
        AgentSessionProvider::ClaudeAgent => HashSet::new(),
        AgentSessionProvider::Codex => {
            codex_canonical_response_users(RecordReader::new(text.as_bytes()))
        }
    };
    build_session(
        provider,
        RecordReader::new(text.as_bytes()),
        &canonical,
        CLAUDE_ID,
        FALLBACK,
    )
}

fn texts(session: &ParsedSession) -> Vec<(&str, &str)> {
    session
        .messages
        .iter()
        .map(|message| (message.role, message.text.as_str()))
        .collect()
}

fn claude_user(text: &str) -> Value {
    json!({"type":"user","sessionId":CLAUDE_ID,"cwd":"/repo","timestamp":"2026-10-02T10:00:00.500Z","message":{"role":"user","content":text}})
}

fn claude_assistant(text: &str) -> Value {
    json!({"type":"assistant","sessionId":CLAUDE_ID,"timestamp":"2026-10-02T10:00:01Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":text},{"type":"tool_use","id":"t","name":"Bash","input":{}}]}})
}

fn codex_meta(cwd: &str) -> Value {
    json!({"type":"session_meta","timestamp":"2026-10-02T09:00:00Z","payload":{"id":CODEX_ID,"cwd":cwd,"base_instructions":{"text":"long"}}})
}

fn codex_response(role: &str, text: &str, turn_id: Option<&str>) -> Value {
    let mut payload = json!({"type":"message","role":role,"content":[{"type": if role == "user" {"input_text"} else {"output_text"},"text":text}]});
    if let Some(turn_id) = turn_id {
        payload["internal_chat_message_metadata_passthrough"] = json!({"turn_id":turn_id});
    }
    json!({"type":"response_item","timestamp":"2026-10-02T09:00:01Z","payload":payload})
}

fn codex_event(text: &str) -> Value {
    json!({"type":"event_msg","timestamp":"2026-10-02T09:00:02Z","payload":{"type":"user_message","message":text}})
}

#[test]
fn claude_keeps_visible_text_and_skips_sidechain_meta_and_compact_records() {
    let session = parse(
        AgentSessionProvider::ClaudeAgent,
        &[
            json!({"type":"summary","summary":"old"}),
            json!({"type":"user","isMeta":true,"message":{"content":"<command>meta</command>"}}),
            claude_user("Fix the login bug\nwith details"),
            json!({"type":"user","isSidechain":true,"message":{"content":"subagent prompt"}}),
            json!({"type":"user","isCompactSummary":true,"message":{"content":"summary of earlier"}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}),
            claude_assistant("Fixed it."),
            json!({"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"API error"}]}}),
        ],
    )
    .expect("session");
    assert_eq!(session.session_id, CLAUDE_ID);
    assert_eq!(session.title, "Fix the login bug");
    assert_eq!(session.model.as_deref(), Some("claude-opus-4-8"));
    assert_eq!(session.message_count, 3);
    assert_eq!(
        texts(&session),
        [
            ("user", "Fix the login bug\nwith details"),
            ("assistant", "Fixed it."),
            ("assistant", "API error"),
        ]
    );
    assert_eq!(session.messages[0].created_at, "2026-10-02T10:00:00.500Z");
    assert_eq!(session.messages[2].created_at, FALLBACK);
}

#[test]
fn claude_prefers_the_ai_title_and_discards_sessions_without_a_user_message() {
    let titled = parse(
        AgentSessionProvider::ClaudeAgent,
        &[
            claude_user("hello"),
            json!({"type":"ai-title","aiTitle":"  Login bug investigation "}),
        ],
    )
    .expect("session");
    assert_eq!(titled.title, "Login bug investigation");
    assert!(parse(AgentSessionProvider::ClaudeAgent, &[claude_assistant("hi")]).is_none());
}

/// `/rename` writes a `custom-title` record; Claude also writes its generated title that way, so
/// the last one is the name `/resume` shows.
#[test]
fn claude_takes_the_last_custom_title_over_an_earlier_one_and_the_ai_title() {
    let renamed = parse(
        AgentSessionProvider::ClaudeAgent,
        &[
            json!({"type":"custom-title","customTitle":"First name","sessionId":CLAUDE_ID}),
            claude_user("hello"),
            json!({"type":"ai-title","aiTitle":"Generated title"}),
            json!({"type":"custom-title","customTitle":"  Login bug  ","sessionId":CLAUDE_ID}),
            claude_assistant("hi"),
        ],
    )
    .expect("session");
    assert_eq!(renamed.title, "Login bug");
}

#[test]
fn claude_session_ids_must_be_uuids_to_resume() {
    assert!(is_resumable(AgentSessionProvider::ClaudeAgent, CLAUDE_ID));
    assert!(is_resumable(
        AgentSessionProvider::ClaudeAgent,
        &CLAUDE_ID.to_uppercase()
    ));
    for invalid in [
        "agent-1234",
        "0f8b5c2e4d6a4b1c9e3f2a7d8c9b1e40",
        "{0f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40}",
        "0f8b5c2e-4d6a-0b1c-9e3f-2a7d8c9b1e40",
        "0f8b5c2e-4d6a-4b1c-7e3f-2a7d8c9b1e40",
    ] {
        assert!(
            !is_resumable(AgentSessionProvider::ClaudeAgent, invalid),
            "{invalid}"
        );
    }
}

#[test]
fn codex_keeps_one_copy_of_a_prompt_written_as_response_item_and_event() {
    let session = parse(
        AgentSessionProvider::Codex,
        &[
            codex_meta("/repo"),
            json!({"type":"turn_context","payload":{"model":"gpt-5.4","cwd":"/repo"}}),
            codex_response("user", "Add tests", None),
            codex_event("Add tests"),
            codex_response("assistant", "Done.", None),
            codex_event("Thanks"),
            codex_response("user", "Thanks", None),
        ],
    )
    .expect("session");
    assert_eq!(session.session_id, CODEX_ID);
    assert_eq!(session.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(session.title, "Add tests");
    assert_eq!(session.message_count, 3);
    assert_eq!(
        texts(&session),
        [
            ("user", "Add tests"),
            ("assistant", "Done."),
            ("user", "Thanks")
        ]
    );
}

#[test]
fn codex_matches_copies_of_a_prompt_longer_than_the_import_limit() {
    let prompt = "x".repeat(MAX_MESSAGE_BYTES + 1);
    for records in [
        [codex_response("user", &prompt, None), codex_event(&prompt)],
        [codex_event(&prompt), codex_response("user", &prompt, None)],
    ] {
        let mut records = records.to_vec();
        records.insert(0, codex_meta("/repo"));
        let session = parse(AgentSessionProvider::Codex, &records).expect("session");
        assert_eq!(session.message_count, 1);
        assert!(session.messages[0].text.ends_with(TRUNCATION_NOTE));
    }
}

#[test]
fn codex_suppresses_generated_setup_text_in_a_turn_with_a_verbatim_event() {
    let session = parse(
        AgentSessionProvider::Codex,
        &[
            codex_meta("/repo"),
            codex_response(
                "user",
                "<environment_context>cwd</environment_context>",
                Some("turn-1"),
            ),
            codex_response("user", "Real prompt", Some("turn-1")),
            codex_event("Real prompt"),
            codex_response("assistant", "Answer", None),
        ],
    )
    .expect("session");
    assert_eq!(
        texts(&session),
        [("user", "Real prompt"), ("assistant", "Answer")]
    );
}

#[test]
fn codex_needs_session_metadata_for_a_resumable_id() {
    assert!(
        parse(
            AgentSessionProvider::Codex,
            &[
                codex_event("hello"),
                codex_response("assistant", "hi", None)
            ]
        )
        .is_none()
    );
}

#[test]
fn long_transcripts_keep_the_first_user_message_and_the_latest_messages() {
    let mut records = vec![claude_user("first prompt")];
    for index in 0..300 {
        records.push(claude_assistant(&format!("reply {index}")));
    }
    let session = parse(AgentSessionProvider::ClaudeAgent, &records).expect("session");
    assert_eq!(session.message_count, 301);
    assert_eq!(session.messages.len(), MAX_IMPORTED_THREAD_MESSAGES);
    assert_eq!(session.messages[0].text, "first prompt");
    assert_eq!(session.messages[1].text, "reply 101");
    assert_eq!(session.messages.last().unwrap().text, "reply 299");
}

#[test]
fn oversized_messages_keep_their_start_and_a_truncation_note() {
    let text = "é".repeat(MAX_MESSAGE_BYTES);
    let truncated = truncate_message(&text);
    assert!(truncated.ends_with(TRUNCATION_NOTE));
    assert!(truncated.len() <= MAX_MESSAGE_BYTES + TRUNCATION_NOTE.len());
    assert_eq!(truncate_message("short"), "short");
}

fn write(path: &Path, records: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, lines(records) + "\n").unwrap();
}

fn age(path: &Path, days: u64) {
    let modified = SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60);
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

struct Homes {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    other: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
}

fn homes() -> Homes {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("repo");
    let other = temp.path().join("other");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&other).unwrap();
    Homes {
        workspace: fs::canonicalize(&workspace).unwrap(),
        other: fs::canonicalize(&other).unwrap(),
        claude: temp.path().join("claude"),
        codex: temp.path().join("codex"),
        _temp: temp,
    }
}

fn sources(homes: &Homes) -> Vec<SessionSource> {
    vec![
        SessionSource {
            provider: AgentSessionProvider::ClaudeAgent,
            home: homes.claude.clone(),
        },
        SessionSource {
            provider: AgentSessionProvider::Codex,
            home: homes.codex.clone(),
        },
    ]
}

fn claude_session(id: &str, cwd: &Path, prompt: &str) -> Vec<Value> {
    vec![
        json!({"type":"user","sessionId":id,"cwd":cwd,"message":{"content":prompt}}),
        json!({"type":"assistant","sessionId":id,"cwd":cwd,"message":{"content":[{"type":"text","text":"ok"}]}}),
    ]
}

#[test]
fn scan_lists_recent_sessions_of_this_folder_newest_first() {
    let homes = homes();
    let claude_dir = homes.claude.join("projects/-repo");
    let current = claude_dir.join(format!("{CLAUDE_ID}.jsonl"));
    write(
        &current,
        &claude_session(CLAUDE_ID, &homes.workspace, "claude prompt"),
    );
    age(&current, 2);
    // Another folder, a stale session and a non-resumable session are left out.
    let elsewhere_id = "1f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    write(
        &homes
            .claude
            .join(format!("projects/-other/{elsewhere_id}.jsonl")),
        &claude_session(elsewhere_id, &homes.other, "elsewhere"),
    );
    let stale_id = "2f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    let stale = claude_dir.join(format!("{stale_id}.jsonl"));
    write(&stale, &claude_session(stale_id, &homes.workspace, "stale"));
    age(&stale, 31);
    write(
        &claude_dir.join("agent-abc.jsonl"),
        &claude_session("agent-abc", &homes.workspace, "not resumable"),
    );
    let rollout = homes.codex.join(format!(
        "sessions/2026/10/07/rollout-2026-10-07T10-00-00-{CODEX_ID}.jsonl"
    ));
    write(
        &rollout,
        &[
            codex_meta(homes.workspace.to_str().unwrap()),
            codex_event("codex prompt"),
            codex_response("assistant", "done", None),
        ],
    );
    age(&rollout, 1);

    let result = scan(
        &sources(&homes),
        &homes.workspace,
        SystemTime::now(),
        &HashSet::new(),
        &CancellationToken::new(),
    );

    assert!(!result.truncated);
    assert!(
        result
            .candidates
            .iter()
            .all(|candidate| candidate.session.messages.is_empty()),
        "a scan keeps no transcript bodies"
    );
    let listed = result
        .candidates
        .iter()
        .map(|candidate| {
            (
                candidate.provider,
                candidate.session.session_id.as_str(),
                candidate.session.title.as_str(),
                candidate.session.message_count,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        listed,
        [
            (AgentSessionProvider::Codex, CODEX_ID, "codex prompt", 2),
            (
                AgentSessionProvider::ClaudeAgent,
                CLAUDE_ID,
                "claude prompt",
                2
            ),
        ]
    );
    // Sessions a BiBCode thread already runs are not offered.
    let owned = HashSet::from([CODEX_ID.to_owned()]);
    let result = scan(
        &sources(&homes),
        &homes.workspace,
        SystemTime::now(),
        &owned,
        &CancellationToken::new(),
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.candidates[0].session.session_id, CLAUDE_ID);
    // A cancelled scan (its RPC was interrupted) stops before reading transcripts.
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let result = scan(
        &sources(&homes),
        &homes.workspace,
        SystemTime::now(),
        &HashSet::new(),
        &cancelled,
    );
    assert!(result.candidates.is_empty());
}

#[test]
fn load_rechecks_the_folder_and_finds_codex_rollouts_by_id() {
    let homes = homes();
    let rollout = homes.codex.join(format!(
        "sessions/2026/10/07/rollout-2026-10-07T10-00-00-{CODEX_ID}.jsonl"
    ));
    write(
        &rollout,
        &[
            codex_meta(homes.workspace.to_str().unwrap()),
            codex_event("codex prompt"),
        ],
    );
    let codex = &sources(&homes)[1];
    let workspace = SessionFolder::new(&homes.workspace);
    let loaded = load(codex, CODEX_ID, &workspace, SystemTime::now()).expect("loads");
    assert_eq!(loaded.messages.len(), 1);
    assert_eq!(
        load(
            codex,
            CODEX_ID,
            &SessionFolder::new(&homes.other),
            SystemTime::now()
        )
        .unwrap_err(),
        LoadFailure::DifferentDirectory
    );
    assert_eq!(
        load(codex, "missing", &workspace, SystemTime::now()).unwrap_err(),
        LoadFailure::NotFound
    );
    let claude = &sources(&homes)[0];
    assert_eq!(
        load(claude, "agent-abc", &workspace, SystemTime::now()).unwrap_err(),
        LoadFailure::NotResumable
    );
}

/// `load` resolves a Claude session in the folder's own project directory, so a History row can
/// always be opened however many transcripts other projects hold; one stored under another
/// directory name is still found by the walk the Import dialog relies on.
#[test]
fn load_finds_a_session_in_the_folder_directory_before_walking_every_project() {
    let homes = homes();
    let claude = &sources(&homes)[0];
    let folder = SessionFolder::new(&homes.workspace);
    let elsewhere_id = "4f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    write(
        &homes
            .claude
            .join(format!("projects/-elsewhere/{elsewhere_id}.jsonl")),
        &claude_session(elsewhere_id, &homes.workspace, "stored elsewhere"),
    );
    assert_eq!(
        load(claude, elsewhere_id, &folder, SystemTime::now())
            .expect("found by the walk")
            .title,
        "stored elsewhere"
    );
    write(
        &folder_directory(&homes, &homes.workspace).join(format!("{CLAUDE_ID}.jsonl")),
        &claude_session(CLAUDE_ID, &homes.workspace, "in the folder"),
    );
    // More transcripts than the walk stats, in a directory that sorts before the folder's.
    let crowded = homes.claude.join("projects/-aaa");
    fs::create_dir_all(&crowded).unwrap();
    for index in 0..=MAX_FILES_PER_SOURCE {
        fs::write(crowded.join(format!("{index}.jsonl")), "").unwrap();
    }
    assert!(
        discover(claude, SystemTime::UNIX_EPOCH).1,
        "the walk runs out"
    );
    let loaded = load(claude, CLAUDE_ID, &folder, SystemTime::now()).expect("found directly");
    assert_eq!(loaded.title, "in the folder");
    assert_eq!(loaded.entrypoint, None);
}

fn folder_directory(homes: &Homes, folder: &Path) -> PathBuf {
    homes.claude.join("projects").join(
        crate::provider::environment::claude_project_directory_name(folder).expect("short folder"),
    )
}

fn terminal_record(id: &str, cwd: &Path, entrypoint: Option<&str>, prompt: &str) -> Value {
    let mut record = json!({
        "type":"user","sessionId":id,"cwd":cwd,"gitBranch":"main",
        "message":{"role":"user","content":prompt}
    });
    if let Some(entrypoint) = entrypoint {
        record["entrypoint"] = json!(entrypoint);
    }
    record
}

fn session_id(index: usize) -> String {
    format!("{index:08x}-4d6a-4b1c-9e3f-2a7d8c9b1e40")
}

fn list(homes: &Homes, folder: &Path) -> HistoryListing {
    list_with(homes, folder, &HashSet::new(), ListingBudget::default())
}

fn list_with(
    homes: &Homes,
    folder: &Path,
    owned: &HashSet<String>,
    budget: ListingBudget,
) -> HistoryListing {
    list_terminal_sessions(
        &homes.claude,
        &SessionFolder::new(folder),
        SystemTime::now(),
        owned,
        budget,
        &CancellationToken::new(),
    )
}

fn listed_ids(listing: &HistoryListing) -> Vec<&str> {
    listing
        .sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect()
}

#[test]
fn history_lists_only_terminal_sessions_run_in_this_folder() {
    let homes = homes();
    let worktree = homes.workspace.join("wt");
    let sub = worktree.join("sub");
    let sibling = homes.workspace.join("wt2");
    for folder in [&worktree, &sub, &sibling] {
        fs::create_dir_all(folder).unwrap();
    }
    let worktree = fs::canonicalize(worktree).unwrap();
    let sub = fs::canonicalize(sub).unwrap();
    let sibling = fs::canonicalize(sibling).unwrap();
    let in_folder = folder_directory(&homes, &worktree);
    let write_session = |directory: &Path, index: usize, cwd: &Path, entrypoint: Option<&str>| {
        let id = session_id(index);
        let path = directory.join(format!("{id}.jsonl"));
        write(
            &path,
            &[
                json!({"type":"file-history-snapshot","messageId":"m"}),
                terminal_record(&id, cwd, entrypoint, &format!("prompt {index}")),
                claude_assistant("ok"),
            ],
        );
        // Older sessions have larger indexes.
        age(&path, u64::try_from(index).unwrap());
    };
    write_session(&in_folder, 1, &worktree, Some("cli"));
    write_session(&in_folder, 2, &worktree, None);
    for (index, entrypoint) in [(3, "sdk-cli"), (4, "sdk-rust"), (5, "claude-desktop")] {
        write_session(&in_folder, index, &worktree, Some(entrypoint));
    }
    // A subfolder's session recorded under the folder's directory is still another folder's.
    write_session(&in_folder, 6, &sub, Some("cli"));
    write_session(&folder_directory(&homes, &sub), 7, &sub, Some("cli"));
    write_session(
        &folder_directory(&homes, &homes.workspace),
        8,
        &homes.workspace,
        Some("cli"),
    );
    write_session(
        &folder_directory(&homes, &sibling),
        9,
        &sibling,
        Some("cli"),
    );

    let listing = list(&homes, &worktree);
    assert!(!listing.truncated);
    assert_eq!(listed_ids(&listing), [session_id(1), session_id(2)]);
    let first = &listing.sessions[0];
    assert_eq!(first.title, "prompt 1");
    assert_eq!(first.branch.as_deref(), Some("main"));
    assert_eq!(
        list(&homes, &homes.workspace)
            .sessions
            .iter()
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>(),
        [session_id(8)]
    );
    // A closed popover cancels its listing before any file.
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let listing = list_terminal_sessions(
        &homes.claude,
        &SessionFolder::new(&worktree),
        SystemTime::now(),
        &HashSet::new(),
        ListingBudget::default(),
        &cancelled,
    );
    assert!(listing.sessions.is_empty());
    assert_eq!(listing.opened, 0);
}

#[test]
fn a_folder_with_a_shortened_directory_name_matches_it_by_prefix() {
    let homes = homes();
    let mut folder = homes.workspace.clone();
    while folder.to_string_lossy().len() <= 220 {
        folder = folder.join("a-long-directory-name");
    }
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(folder).unwrap();
    let crate::provider::environment::ClaudeProjectDirectoryName::Prefix(prefix) =
        crate::provider::environment::ClaudeProjectDirectoryName::of(&folder)
    else {
        panic!("the folder's directory name is shortened");
    };
    let id = session_id(1);
    write(
        &homes
            .claude
            .join("projects")
            .join(format!("{prefix}-1a2b3c"))
            .join(format!("{id}.jsonl")),
        &[terminal_record(&id, &folder, Some("cli"), "deep prompt")],
    );
    assert_eq!(listed_ids(&list(&homes, &folder)), [id.as_str()]);
}

#[test]
fn history_titles_take_the_last_custom_title_then_the_ai_title_then_the_prompt() {
    let homes = homes();
    let directory = folder_directory(&homes, &homes.workspace);
    let renamed = session_id(1);
    write(
        &directory.join(format!("{renamed}.jsonl")),
        &[
            json!({"type":"custom-title","customTitle":"Early name","sessionId":renamed}),
            terminal_record(&renamed, &homes.workspace, Some("cli"), "first prompt"),
            json!({"type":"ai-title","aiTitle":"Generated"}),
            json!({"type":"custom-title","customTitle":"Late name","sessionId":renamed}),
        ],
    );
    let generated = session_id(2);
    write(
        &directory.join(format!("{generated}.jsonl")),
        &[
            terminal_record(&generated, &homes.workspace, Some("cli"), "second prompt"),
            json!({"type":"ai-title","aiTitle":"Generated"}),
        ],
    );
    let plain = session_id(3);
    write(
        &directory.join(format!("{plain}.jsonl")),
        &[terminal_record(
            &plain,
            &homes.workspace,
            None,
            "Third prompt\nwith more lines",
        )],
    );
    let titles = list(&homes, &homes.workspace)
        .sessions
        .into_iter()
        .map(|session| (session.session_id, session.title))
        .collect::<HashMap<_, _>>();
    assert_eq!(titles[&renamed], "Late name");
    assert_eq!(titles[&generated], "Generated");
    assert_eq!(titles[&plain], "Third prompt");
}

/// Records of about `bytes` in total that name no title.
fn filler(id: &str, bytes: usize) -> Vec<Value> {
    let text = "x".repeat(4 * 1024);
    (0..bytes / text.len())
        .map(|_| json!({"type":"assistant","sessionId":id,"message":{"content":[{"type":"text","text":text}]}}))
        .collect()
}

#[test]
fn a_title_buried_between_the_head_and_the_tail_is_found_within_the_walk_budget() {
    let homes = homes();
    let id = session_id(1);
    let path = folder_directory(&homes, &homes.workspace).join(format!("{id}.jsonl"));
    let mut records = vec![terminal_record(
        &id,
        &homes.workspace,
        Some("cli"),
        "first prompt",
    )];
    records.extend(filler(&id, 2 * 1024 * 1024));
    records.push(json!({"type":"custom-title","customTitle":"Renamed mid-file","sessionId":id}));
    records.extend(filler(&id, 1024 * 1024));
    write(&path, &records);
    assert!(fs::metadata(&path).unwrap().len() > 3 * 1024 * 1024);

    let listing = list(&homes, &homes.workspace);
    assert_eq!(listing.sessions[0].title, "Renamed mid-file");
    // With the walk's share spent, the row keeps its first prompt and stays listed.
    let listing = list_with(
        &homes,
        &homes.workspace,
        &HashSet::new(),
        ListingBudget {
            walk_bytes: 512 * 1024,
            ..ListingBudget::default()
        },
    );
    assert_eq!(listed_ids(&listing), [id.as_str()]);
    assert_eq!(listing.sessions[0].title, "first prompt");
}

#[test]
fn a_large_transcript_with_its_title_in_the_tail_is_read_at_its_ends_only() {
    let homes = homes();
    let id = session_id(1);
    let path = folder_directory(&homes, &homes.workspace).join(format!("{id}.jsonl"));
    let mut records = vec![terminal_record(
        &id,
        &homes.workspace,
        Some("cli"),
        "prompt",
    )];
    records.extend(filler(&id, 3 * 1024 * 1024));
    records.push(json!({"type":"custom-title","customTitle":"Named","sessionId":id}));
    records.push(json!({"type":"assistant","sessionId":id,"gitBranch":"feature","message":{"content":"done"}}));
    write(&path, &records);
    let size = fs::metadata(&path).unwrap().len();

    let listing = list(&homes, &homes.workspace);
    let session = &listing.sessions[0];
    assert_eq!(session.title, "Named");
    assert_eq!(session.branch.as_deref(), Some("feature"));
    assert_eq!(listing.opened, 1);
    assert!(
        listing.bytes_read < 4 * TAIL_BYTES,
        "read {} of {size} bytes",
        listing.bytes_read
    );
}

#[test]
fn the_listing_budget_counts_opened_transcripts_whatever_they_hold() {
    let homes = homes();
    let directory = folder_directory(&homes, &homes.workspace);
    fs::create_dir_all(&directory).unwrap();
    // Desktop sessions, newest first, crowd out three older terminal sessions.
    for index in 0..1_503 {
        let id = session_id(index);
        let entrypoint = if index < 1_500 {
            "claude-desktop"
        } else {
            "cli"
        };
        let path = directory.join(format!("{id}.jsonl"));
        write(
            &path,
            &[terminal_record(
                &id,
                &homes.workspace,
                Some(entrypoint),
                "prompt",
            )],
        );
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(
                SystemTime::now() - Duration::from_secs(60 * u64::try_from(index).unwrap()),
            )
            .unwrap();
    }
    let listing = list(&homes, &homes.workspace);
    assert!(listing.truncated);
    assert!(listing.sessions.is_empty());
    assert_eq!(listing.opened, 1_000);
}

#[test]
fn owned_and_duplicate_sessions_are_rejected_without_being_opened() {
    let homes = homes();
    let mut folder = homes.workspace.clone();
    while folder.to_string_lossy().len() <= 220 {
        folder = folder.join("a-long-directory-name");
    }
    fs::create_dir_all(&folder).unwrap();
    let folder = fs::canonicalize(folder).unwrap();
    let crate::provider::environment::ClaudeProjectDirectoryName::Prefix(prefix) =
        crate::provider::environment::ClaudeProjectDirectoryName::of(&folder)
    else {
        panic!("the folder's directory name is shortened");
    };
    let (owned, duplicated, excluded) = (session_id(1), session_id(2), session_id(3));
    for (directory, id, entrypoint) in [
        ("a", &owned, "cli"),
        ("a", &duplicated, "cli"),
        ("b", &duplicated, "cli"),
        ("a", &excluded, "claude-desktop"),
    ] {
        let mut records = vec![terminal_record(id, &folder, Some(entrypoint), "prompt")];
        records.extend(filler(id, 2 * 1024 * 1024));
        records.push(json!({"type":"custom-title","customTitle":"Named","sessionId":id}));
        write(
            &homes
                .claude
                .join("projects")
                .join(format!("{prefix}-{directory}"))
                .join(format!("{id}.jsonl")),
            &records,
        );
    }
    let listing = list_with(
        &homes,
        &folder,
        &HashSet::from([owned.clone()]),
        ListingBudget::default(),
    );
    assert_eq!(listed_ids(&listing), [duplicated.as_str()]);
    // One copy of the duplicate and the excluded transcript; the owned file is never opened.
    assert_eq!(listing.opened, 2);
    // The excluded transcript's head read stops at its first record instead of reading its
    // whole head window.
    assert!(
        listing.bytes_read < 8 * TAIL_BYTES,
        "read {} bytes",
        listing.bytes_read
    );
}

fn write_live_entry(homes: &Homes, name: &str, entry: &Value) {
    let directory = homes.claude.join("sessions");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(name), entry.to_string()).unwrap();
}

fn exited_pid() -> u32 {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.wait().unwrap();
    child.id()
}

#[test]
fn liveness_reads_running_session_files_and_doubts_an_incomplete_read() {
    let homes = homes();
    let (live, closed, own) = (session_id(1), session_id(2), session_id(3));
    // No directory: a Claude Code that writes none, which says nothing.
    assert_eq!(
        read_live_sessions(&homes.claude).liveness(&live),
        Liveness::Unknown
    );
    let current = std::process::id();
    write_live_entry(
        &homes,
        "1.json",
        &json!({"pid":current,"sessionId":live,"entrypoint":"cli","kind":"interactive"}),
    );
    write_live_entry(
        &homes,
        "2.json",
        &json!({"pid":exited_pid(),"sessionId":closed,"entrypoint":"cli"}),
    );
    // BiBCode's own Claude process for a session does not make it live.
    write_live_entry(
        &homes,
        "3.json",
        &json!({"pid":current,"sessionId":own,"entrypoint":"sdk-rust"}),
    );
    // Not an entry.
    fs::write(homes.claude.join("sessions/1.0123abcd.key"), "secret").unwrap();
    let sessions = read_live_sessions(&homes.claude);
    assert!(sessions.complete);
    assert_eq!(sessions.liveness(&live), Liveness::Live);
    assert_eq!(sessions.liveness(&closed), Liveness::Closed);
    assert_eq!(sessions.liveness(&own), Liveness::Closed);

    for spoil in ["unparsable", "oversized"] {
        let homes = self::homes();
        write_live_entry(
            &homes,
            "1.json",
            &json!({"pid":current,"sessionId":live,"entrypoint":"cli"}),
        );
        let directory = homes.claude.join("sessions");
        if spoil == "unparsable" {
            fs::write(directory.join("2.json"), "{not json").unwrap();
        } else {
            fs::write(
                directory.join("2.json"),
                json!({"pid":1,"sessionId":closed,"padding":"x".repeat(64 * 1024)}).to_string(),
            )
            .unwrap();
        }
        let sessions = read_live_sessions(&homes.claude);
        assert!(!sessions.complete, "{spoil}");
        assert_eq!(sessions.liveness(&live), Liveness::Live, "{spoil}");
        assert_eq!(sessions.liveness(&closed), Liveness::Unknown, "{spoil}");
    }

    let homes = self::homes();
    let dead = exited_pid();
    for index in 0..=MAX_LIVE_SESSION_FILES {
        write_live_entry(
            &homes,
            &format!("{index}.json"),
            &json!({"pid":dead,"sessionId":session_id(index + 10)}),
        );
    }
    let sessions = read_live_sessions(&homes.claude);
    assert!(!sessions.complete, "more files than are read");
    assert_eq!(sessions.liveness(&closed), Liveness::Unknown);
}

#[test]
fn listed_sessions_carry_their_liveness() {
    let homes = homes();
    let directory = folder_directory(&homes, &homes.workspace);
    let (live, closed) = (session_id(1), session_id(2));
    for id in [&live, &closed] {
        write(
            &directory.join(format!("{id}.jsonl")),
            &[terminal_record(id, &homes.workspace, Some("cli"), "prompt")],
        );
    }
    write_live_entry(
        &homes,
        "1.json",
        &json!({"pid":std::process::id(),"sessionId":live,"entrypoint":"cli"}),
    );
    let listing = list(&homes, &homes.workspace);
    let liveness = listing
        .sessions
        .iter()
        .map(|session| (session.session_id.as_str(), session.liveness))
        .collect::<HashMap<_, _>>();
    assert_eq!(liveness[live.as_str()], Liveness::Live);
    assert_eq!(liveness[closed.as_str()], Liveness::Closed);
    assert!(!listing.liveness_incomplete);
}

#[test]
fn a_cancelled_scan_stops_reading_a_transcript_between_records() {
    let text = lines(&[
        json!({"type": "user", "sessionId": CLAUDE_ID, "message": {"content": "first"}}),
        json!({"type": "assistant", "sessionId": CLAUDE_ID, "message": {"content": "second"}}),
    ]);
    let cancellation = CancellationToken::new();
    let mut live = RecordReader::new(text.as_bytes()).with_cancellation(&cancellation);
    assert!(live.next().is_some());
    cancellation.cancel();
    assert!(live.next().is_none());
    assert!(live.failed, "a cancelled read is not a complete transcript");
}
