//! The deterministic large-store fixture behind the transfer budget (#225).
//!
//! One big thread (200 turns, long answers, many tool activities of realistic sizes, proposed
//! plans and one checkpoint that touches 2,400 files) and a shell of 160 non-archived threads
//! across six projects, most of them finished: one default thread per project, workspace
//! threads without a worktree, and chat panels. It is written straight into
//! the store through `Repositories`, so a test and the 3G harness
//! (`scripts/measure-remote-latency.ts`, through `examples/write_load_fixture.rs`) measure the
//! same data. A fixed seed makes two builds byte-identical; all text is synthetic.
//!
//! Integration binaries and the example include this file with `#[path]`; each uses part of it.
#![allow(dead_code)]

use std::path::Path;

use bibcode_server::persistence::{
    ProjectionProject, ProjectionState, ProjectionThread, ProjectionThreadActivity,
    ProjectionThreadMessage, ProjectionThreadProposedPlan, ProjectionThreadSession,
    ProjectionTurnById, Repositories,
};
use serde_json::{Value, json};

pub const BIG_THREAD_ID: &str = "thread-large";
pub const BIG_THREAD_TITLE: &str = "Large fixture thread";
/// The last words of the big thread; a UI measurement waits for them to show.
pub const BIG_THREAD_FINAL_MARKER: &str = "Fixture closing answer.";
pub const PROJECT_COUNT: usize = 6;
pub const NON_ARCHIVED_THREADS: usize = 160;
const ARCHIVED_THREADS: usize = 8;
const BIG_THREAD_TURNS: usize = 200;
/// The turn whose checkpoint touches thousands of files.
const WIDE_CHECKPOINT_TURN: usize = 100;
const WIDE_CHECKPOINT_FILES: usize = 2_400;
/// The projectors' last applied sequence; the shell and thread answers carry it.
const SEQUENCE: i64 = 4_000;
const PROJECTORS: [&str; 9] = [
    "projection.projects",
    "projection.thread-messages",
    "projection.thread-proposed-plans",
    "projection.thread-activities",
    "projection.thread-sessions",
    "projection.thread-turns",
    "projection.checkpoints",
    "projection.pending-approvals",
    "projection.threads",
];
/// A fixed, old instant: a thread's age in the shell keeps its digit count for years.
const LONG_AGO: &str = "2026-01-01T00:00:00.000Z";

/// SplitMix64: a fixed seed gives the same fixture on every platform and toolchain.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).expect("bound fits")).expect("fits")
    }

    fn between(&mut self, low: usize, high: usize) -> usize {
        low + self.below(high - low + 1)
    }
}

/// Pseudo-words drawn with a skew toward a few common ones, so the text compresses about as
/// much as prose and tool output do.
struct Words {
    rng: Rng,
    list: Vec<String>,
}

impl Words {
    fn new(mut rng: Rng) -> Self {
        const SYLLABLES: [&str; 24] = [
            "ba", "ke", "di", "lo", "mu", "na", "pe", "ri", "so", "tu", "va", "we", "xi", "yo",
            "zu", "cha", "dre", "fli", "gro", "sta", "thi", "ple", "qua", "bri",
        ];
        let list = (0..800)
            .map(|_| {
                (0..rng.between(1, 3))
                    .map(|_| SYLLABLES[rng.below(SYLLABLES.len())])
                    .collect()
            })
            .collect();
        Self { rng, list }
    }

    fn word(&mut self) -> String {
        let length = self.list.len();
        let index = self.rng.below(length) * self.rng.below(length) / length;
        self.list[index].clone()
    }

    fn sentence(&mut self) -> String {
        let count = self.rng.between(6, 16);
        let words = (0..count)
            .map(|_| self.word())
            .collect::<Vec<_>>()
            .join(" ");
        let mut chars = words.chars();
        let first = chars.next().map(|c| c.to_ascii_uppercase()).unwrap_or('A');
        format!("{first}{}.", chars.as_str())
    }

    fn text(&mut self, sentences: usize) -> String {
        (0..sentences)
            .map(|_| self.sentence())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// `text` with a random number of sentences from `low` to `high`.
    fn paragraph(&mut self, low: usize, high: usize) -> String {
        let count = self.rng.between(low, high);
        self.text(count)
    }

    fn path(&mut self) -> String {
        format!("src/{}/{}/{}.rs", self.word(), self.word(), self.word())
    }

    /// Roughly `length` bytes of tool output: file paths with line numbers and a few words.
    fn output(&mut self, length: usize) -> String {
        let mut output = String::with_capacity(length + 80);
        while output.len() < length {
            let line = self.rng.between(1, 900);
            output.push_str(&format!("{}:{line}: {}\n", self.path(), self.text(1)));
        }
        output.truncate(length);
        output
    }
}

/// `2026-10-DDTHH:MM:SS.mmmZ` for a minute offset from the first of the month.
fn timestamp(minutes: usize, millis: usize) -> String {
    format!(
        "2026-10-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        1 + minutes / 1_440,
        minutes / 60 % 24,
        minutes % 60,
        millis / 1_000 % 60,
        millis % 1_000
    )
}

fn thread_row(
    thread_id: &str,
    project: usize,
    title: &str,
    latest_turn: Option<&str>,
    minutes: usize,
) -> ProjectionThread {
    ProjectionThread {
        thread_id: thread_id.to_owned(),
        project_id: format!("project-{project}"),
        title: title.to_owned(),
        kind: "default".to_owned(),
        model_selection: json!({"instanceId": "codex", "model": "gpt-5"}),
        runtime_mode: "full-access".to_owned(),
        interaction_mode: "default".to_owned(),
        branch: Some("main".to_owned()),
        worktree_path: None,
        latest_turn_id: latest_turn.map(str::to_owned),
        created_at: timestamp(minutes, 0),
        updated_at: timestamp(minutes + 2, 0),
        archived_at: None,
        latest_user_message_at: Some(timestamp(minutes, 0)),
        pending_approval_count: 0,
        pending_user_input_count: 0,
        has_actionable_proposed_plan: 0,
        unresolved_delivery_state: None,
        unresolved_delivery_detail: None,
        deleted_at: None,
        host_thread_id: None,
        compaction: None,
        last_activity_at: Some(LONG_AGO.to_owned()),
        requester: None,
        side_chat: false,
        code_review: false,
    }
}

fn message_row(
    thread_id: &str,
    turn: &str,
    role: &str,
    text: String,
    at: String,
) -> ProjectionThreadMessage {
    ProjectionThreadMessage {
        message_id: format!("{thread_id}-{turn}-{role}"),
        thread_id: thread_id.to_owned(),
        turn_id: Some(turn.to_owned()),
        role: role.to_owned(),
        text,
        attachments: None,
        is_streaming: false,
        delivery_state: None,
        delivery_provider: None,
        delivery_provider_instance_id: None,
        delivery_detail: None,
        delivery_reason: None,
        delivery_mode: None,
        delivery_held: None,
        resend_of_message_id: None,
        actor: None,
        source_thread_id: None,
        created_at: at.clone(),
        updated_at: at,
    }
}

fn turn_row(thread_id: &str, turn: &str, at: &str, running: bool) -> ProjectionTurnById {
    ProjectionTurnById {
        thread_id: thread_id.to_owned(),
        turn_id: turn.to_owned(),
        pending_message_id: None,
        source_proposed_plan_thread_id: None,
        source_proposed_plan_id: None,
        assistant_message_id: (!running).then(|| format!("{thread_id}-{turn}-assistant")),
        state: if running { "running" } else { "completed" }.to_owned(),
        requested_at: at.to_owned(),
        started_at: Some(at.to_owned()),
        completed_at: (!running).then(|| at.to_owned()),
        checkpoint_turn_count: None,
        checkpoint_ref: None,
        checkpoint_status: None,
        checkpoint_files: json!([]),
    }
}

fn session_row(thread_id: &str, running: bool) -> ProjectionThreadSession {
    ProjectionThreadSession {
        thread_id: thread_id.to_owned(),
        status: if running { "running" } else { "ready" }.to_owned(),
        provider_name: Some("codex".to_owned()),
        provider_instance_id: Some("codex".to_owned()),
        runtime_mode: "full-access".to_owned(),
        active_turn_id: None,
        last_error: None,
        last_error_class: None,
        updated_at: LONG_AGO.to_owned(),
    }
}

/// One tool activity whose detail is about `detail_length` bytes (the cap is 16 KiB).
fn activity_row(
    words: &mut Words,
    thread_id: &str,
    turn: &str,
    index: usize,
    sequence: i64,
    at: String,
    detail_length: usize,
) -> ProjectionThreadActivity {
    ProjectionThreadActivity {
        activity_id: format!("{thread_id}-{turn}-activity-{index:02}"),
        thread_id: thread_id.to_owned(),
        turn_id: Some(turn.to_owned()),
        tone: "tool".to_owned(),
        kind: "tool.completed".to_owned(),
        summary: format!("Ran {}", words.text(1)),
        payload: json!({
            "itemType": "command_execution",
            "status": "completed",
            "title": words.text(1),
            "detail": words.output(detail_length),
            "data": { "command": words.text(1), "exitCode": 0 },
        }),
        sequence: Some(sequence),
        created_at: at,
    }
}

/// Mostly small outputs, some larger, a few that reach the 16 KiB cap: about 2 KB on average.
fn detail_length(rng: &mut Rng) -> usize {
    match rng.below(100) {
        0..=54 => rng.between(200, 900),
        55..=84 => rng.between(900, 3_000),
        85..=96 => rng.between(3_000, 8_000),
        _ => rng.between(12_000, 16_000),
    }
}

fn checkpoint_files(words: &mut Words, count: usize) -> Value {
    Value::Array(
        (0..count)
            .map(|_| {
                let kind = ["modified", "added", "deleted"][words.rng.below(3)];
                json!({
                    "path": words.path(),
                    "kind": kind,
                    "additions": words.rng.below(120),
                    "deletions": words.rng.below(60),
                })
            })
            .collect(),
    )
}

async fn seed_big_thread(repositories: &Repositories, words: &mut Words, sequence: &mut i64) {
    let last_turn = format!("turn-{:03}", BIG_THREAD_TURNS - 1);
    // The newest thread of the first project.
    let thread = thread_row(BIG_THREAD_ID, 0, BIG_THREAD_TITLE, Some(&last_turn), 14_000);
    repositories.upsert_thread(thread).await.unwrap();
    for turn_index in 0..BIG_THREAD_TURNS {
        let turn = format!("turn-{turn_index:03}");
        let minutes = 10_000 + turn_index * 3;
        let at = timestamp(minutes, 0);
        let mut answer = words.paragraph(8, 40);
        if turn_index == BIG_THREAD_TURNS - 1 {
            answer.push(' ');
            answer.push_str(BIG_THREAD_FINAL_MARKER);
        }
        let prompt = words.paragraph(1, 3);
        repositories
            .upsert_message(message_row(
                BIG_THREAD_ID,
                &turn,
                "user",
                prompt,
                at.clone(),
            ))
            .await
            .unwrap();
        for index in 0..words.rng.between(8, 14) {
            *sequence += 1;
            let length = detail_length(&mut words.rng);
            let activity = activity_row(
                words,
                BIG_THREAD_ID,
                &turn,
                index,
                *sequence,
                timestamp(minutes, 100 + index * 50),
                length,
            );
            repositories.upsert_activity(activity).await.unwrap();
        }
        let reply = message_row(
            BIG_THREAD_ID,
            &turn,
            "assistant",
            answer,
            timestamp(minutes + 1, 0),
        );
        repositories.upsert_message(reply).await.unwrap();
        if turn_index % 20 == 10 {
            let sections = words.rng.between(6, 14);
            let plan_markdown = (0..sections)
                .map(|section| {
                    let intro = words.text(2);
                    let detail = words.text(1);
                    format!("## Step {section}\n\n- {intro}\n- {detail}\n")
                })
                .collect::<Vec<_>>()
                .join("\n");
            repositories
                .upsert_proposed_plan(ProjectionThreadProposedPlan {
                    plan_id: format!("{BIG_THREAD_ID}-plan-{turn_index:03}"),
                    thread_id: BIG_THREAD_ID.to_owned(),
                    turn_id: Some(turn.clone()),
                    plan_markdown,
                    implemented_at: None,
                    implementation_thread_id: None,
                    created_at: at.clone(),
                    updated_at: at.clone(),
                })
                .await
                .unwrap();
        }
        let files = if turn_index == WIDE_CHECKPOINT_TURN {
            WIDE_CHECKPOINT_FILES
        } else {
            words.rng.between(1, 6)
        };
        let mut row = turn_row(BIG_THREAD_ID, &turn, &at, false);
        row.checkpoint_turn_count = Some(i64::try_from(turn_index + 1).unwrap());
        row.checkpoint_ref = Some(format!(
            "refs/bibcode/checkpoints/{BIG_THREAD_ID}/{turn_index}"
        ));
        row.checkpoint_status = Some("ready".to_owned());
        row.checkpoint_files = checkpoint_files(words, files);
        repositories.upsert_turn_by_id(row).await.unwrap();
    }
    repositories
        .upsert_thread_session(session_row(BIG_THREAD_ID, false))
        .await
        .unwrap();
}

/// A shell thread: two turns of short messages, the second still running for every twentieth.
async fn seed_shell_thread(
    repositories: &Repositories,
    words: &mut Words,
    index: usize,
    sequence: &mut i64,
) {
    let thread_id = format!("thread-{index:03}");
    let minutes = 5_000 + index * 40;
    let running = index % 20 == 7;
    let title = words.text(1);
    let mut thread = thread_row(
        &thread_id,
        index % PROJECT_COUNT,
        &title,
        Some("turn-1"),
        minutes,
    );
    // One default thread per project (the big thread is project 0's); the rest are workspace
    // threads without a worktree, and every eighth a chat panel of the thread one round of
    // projects back, which is in the same project.
    if index >= PROJECT_COUNT && index % 8 == 3 {
        thread.kind = "panel".to_owned();
        thread.host_thread_id = Some(format!("thread-{:03}", index - PROJECT_COUNT));
    } else if index >= PROJECT_COUNT {
        thread.kind = "workspace".to_owned();
    }
    if index >= NON_ARCHIVED_THREADS {
        thread.archived_at = Some(timestamp(minutes + 5, 0));
    }
    repositories.upsert_thread(thread).await.unwrap();
    for turn_index in 0..2 {
        let turn = format!("turn-{turn_index}");
        let at = timestamp(minutes + turn_index * 5, 0);
        let live = running && turn_index == 1;
        let prompt = words.paragraph(1, 3);
        repositories
            .upsert_message(message_row(&thread_id, &turn, "user", prompt, at.clone()))
            .await
            .unwrap();
        if !live {
            let reply = message_row(
                &thread_id,
                &turn,
                "assistant",
                words.paragraph(3, 10),
                timestamp(minutes + turn_index * 5 + 1, 0),
            );
            repositories.upsert_message(reply).await.unwrap();
        }
        *sequence += 1;
        let length = words.rng.between(200, 900);
        let activity = activity_row(
            words,
            &thread_id,
            &turn,
            0,
            *sequence,
            timestamp(minutes + turn_index * 5, 500),
            length,
        );
        repositories.upsert_activity(activity).await.unwrap();
        repositories
            .upsert_turn_by_id(turn_row(&thread_id, &turn, &at, live))
            .await
            .unwrap();
    }
    repositories
        .upsert_thread_session(session_row(&thread_id, running))
        .await
        .unwrap();
}

/// Writes the fixture through `repositories`, whose store has been migrated and is empty.
/// Each project's workspace is a directory under `workspace_parent`.
pub async fn seed(repositories: &Repositories, workspace_parent: &Path) {
    let mut words = Words::new(Rng(0x00B1_BC0D_E225));
    let mut sequence = 0;
    for project in 0..PROJECT_COUNT {
        let root = workspace_parent.join(format!("project-{project}"));
        std::fs::create_dir_all(&root).expect("project workspace");
        repositories
            .upsert_project(ProjectionProject {
                project_id: format!("project-{project}"),
                title: format!("Fixture project {project}"),
                workspace_root: root.to_string_lossy().replace('\\', "/"),
                default_model_selection: None,
                scripts: json!([]),
                worktree_discovery: json!({
                    "visibility": "hidden",
                    "initialPromptDismissedAt": null,
                    "baselinePaths": [],
                }),
                worktree_repository_key: None,
                created_at: timestamp(project, 0),
                updated_at: timestamp(project, 0),
                deleted_at: None,
                repository_identity: None,
                code_review_prompt: String::new(),
            })
            .await
            .unwrap();
    }
    seed_big_thread(repositories, &mut words, &mut sequence).await;
    // The big thread stands for the first of the shell's non-archived threads.
    for index in 1..NON_ARCHIVED_THREADS + ARCHIVED_THREADS {
        seed_shell_thread(repositories, &mut words, index, &mut sequence).await;
    }
    for projector in PROJECTORS {
        repositories
            .upsert_projection_state(ProjectionState {
                projector: projector.to_owned(),
                last_applied_sequence: SEQUENCE.max(sequence),
                updated_at: LONG_AGO.to_owned(),
            })
            .await
            .unwrap();
    }
}
