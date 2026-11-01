//! The Source Control reads and the commit message suggestion (#139 slice X7) end to end: the
//! real `vcs.*` and `gitManager.*` handlers on a temporary repository, and the real UI intents
//! service. Every read returns bounded, untrusted text; the suggestion is advice a panel shows,
//! never a commit.

use serde_json::{Value, json};

use super::{
    error_tag,
    git::{Fixture, THREAD, fixture_with},
    structured,
};
use crate::{
    mcp::{control::McpAccess, protocol::MAX_RESULT_CHARS},
    production::ui_intents_rpc::{self, UiIntents},
};

/// A repository thread whose registry also serves the UI intents, and those intents.
async fn fixture() -> (Fixture, UiIntents) {
    let intents = UiIntents::new();
    let registered = intents.clone();
    let fixture = fixture_with(move |registry| {
        ui_intents_rpc::register_ui_intents_rpc(registry, registered);
    })
    .await;
    (fixture, intents)
}

fn text_chars(result: &Value) -> usize {
    result["content"][0]["text"]
        .as_str()
        .expect("a text result")
        .chars()
        .count()
}

fn tag(result: &Value) -> String {
    error_tag(result).to_owned()
}

#[tokio::test]
async fn git_diff_pages_a_working_tree_patch_at_16000_characters() {
    let (fixture, _) = fixture().await;
    let lines: String = (0..3_000).map(|index| format!("line {index}\n")).collect();
    // A hidden character in the file is escaped in the text an agent reads.
    fixture.write("a.txt", &format!("a\n\u{202e}hidden\n{lines}"));
    let mut patch = String::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut arguments = json!({ "path": "a.txt" });
        if let Some(cursor) = &cursor {
            arguments["cursor"] = cursor.as_str().into();
        }
        let page = fixture.call("git_diff", arguments).await;
        assert!(text_chars(&page) <= MAX_RESULT_CHARS);
        assert!(
            !page["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains('\u{202e}')
        );
        let page = structured(&page);
        assert_eq!(page["threadId"], THREAD);
        assert_eq!(page["path"], "a.txt");
        assert_eq!(page["staged"], false);
        assert_eq!(page["kind"], "patch");
        let text = page["patch"].as_str().unwrap();
        assert!(text.chars().count() <= 16_000);
        // Git's raw header (NUL-separated, before the first `diff --git`) is never returned.
        assert!(!text.contains('\0'));
        patch.push_str(text);
        pages += 1;
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    assert!(pages > 1, "a 30,000-character patch takes several pages");
    assert!(
        patch.starts_with("diff --git a/a.txt b/a.txt\n"),
        "{patch:.80}"
    );
    assert_eq!(
        patch.trim_end(),
        fixture.git(&["diff", "--no-color", "--no-ext-diff", "HEAD", "--", "a.txt"])
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_diff_reads_only_what_is_staged_when_asked() {
    let (fixture, _) = fixture().await;
    fixture.write("a.txt", "a\nstaged line\n");
    fixture.git(&["add", "a.txt"]);
    fixture.write("a.txt", "a\nstaged line\nworking line\n");
    fixture.write("new.txt", "brand new\n");

    let staged = fixture
        .call("git_diff", json!({ "path": "a.txt", "staged": true }))
        .await;
    let staged = structured(&staged)["patch"].as_str().unwrap().to_owned();
    assert!(staged.contains("+staged line"), "{staged}");
    assert!(!staged.contains("working line"), "{staged}");

    let all = fixture.call("git_diff", json!({ "path": "a.txt" })).await;
    let all = structured(&all)["patch"].as_str().unwrap().to_owned();
    assert!(
        all.contains("+staged line") && all.contains("+working line"),
        "{all}"
    );

    // An untracked file reads as an added one.
    let untracked = fixture.call("git_diff", json!({ "path": "new.txt" })).await;
    let untracked = structured(&untracked)["patch"].as_str().unwrap().to_owned();
    assert!(untracked.contains("+brand new"), "{untracked}");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_diff_refuses_a_path_it_may_not_read() {
    let (fixture, _) = fixture().await;
    for arguments in [
        json!({}),
        json!({ "path": "../outside.txt" }),
        json!({ "path": "/etc/hosts" }),
        json!({ "path": "*.txt" }),
        json!({ "path": ":(glob)**" }),
        json!({ "path": "a.txt", "cursor": "not-a-cursor" }),
        json!({ "path": "a.txt", "unknown": true }),
    ] {
        let refused = fixture.call("git_diff", arguments.clone()).await;
        assert_eq!(tag(&refused), "McpInvalidArgumentError", "{arguments}");
    }
    // Git's own metadata is refused where every caller's diff runs.
    let metadata = fixture
        .call("git_diff", json!({ "path": ".git/config" }))
        .await;
    assert_eq!(tag(&metadata), "GitManagerOperationError");
    assert_eq!(
        metadata["structuredContent"]["error"]["code"],
        "invalid-path"
    );
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_diff_reports_a_file_too_large_to_show_without_its_content() {
    let (fixture, _) = fixture().await;
    // A line longer than the panel renders (5,000 characters) makes it large text.
    fixture.write("a.txt", &format!("a\n{}\n", "x".repeat(6_000)));
    let large = fixture.call("git_diff", json!({ "path": "a.txt" })).await;
    let large = structured(&large);
    assert_eq!(large["kind"], "large-text");
    assert_eq!(large["patch"], Value::Null);
    assert_eq!(large["nextCursor"], Value::Null);
    assert!(large["byteLength"].as_u64().unwrap() > 6_000);
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_log_reads_head_history_newest_first_and_pages_by_cursor() {
    let (fixture, _) = fixture().await;
    for index in 1..=4 {
        fixture.write("a.txt", &format!("a{index}\n"));
        fixture.git(&["commit", "-qam", &format!("change {index}")]);
    }
    // A commit on another branch is not in HEAD's history.
    fixture.git(&["switch", "-qc", "side"]);
    fixture.write("side.txt", "side\n");
    fixture.git(&["add", "side.txt"]);
    fixture.git(&["commit", "-qm", "side work"]);
    fixture.git(&["switch", "-q", "main"]);

    let mut subjects = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut arguments = json!({ "limit": 2 });
        if let Some(cursor) = &cursor {
            arguments["cursor"] = cursor.as_str().into();
        }
        let page = fixture.call("git_log", arguments).await;
        let page = structured(&page);
        assert_eq!(page["threadId"], THREAD);
        assert_eq!(page["ref"], "HEAD");
        let commits = page["commits"].as_array().unwrap();
        assert!(commits.len() <= 2);
        for commit in commits {
            assert_eq!(commit["sha"].as_str().unwrap().len(), 40);
            subjects.push(commit["subject"].as_str().unwrap().to_owned());
        }
        match page["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_owned()),
            None => break,
        }
    }
    assert_eq!(
        subjects,
        ["change 4", "change 3", "change 2", "change 1", "base"]
    );

    // The cursor stays on the tip it started from, even after HEAD moves.
    let first = fixture.call("git_log", json!({ "limit": 1 })).await;
    let next = structured(&first)["nextCursor"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture.write("a.txt", "moved\n");
    fixture.git(&["commit", "-qam", "after the first page"]);
    let second = fixture
        .call("git_log", json!({ "limit": 1, "cursor": next }))
        .await;
    assert_eq!(structured(&second)["commits"][0]["subject"], "change 3");

    let side = fixture
        .call("git_log", json!({ "ref": "side", "limit": 1 }))
        .await;
    assert_eq!(structured(&side)["commits"][0]["subject"], "side work");
    let remote = fixture
        .call("git_log", json!({ "ref": "origin/main", "limit": 1 }))
        .await;
    assert_eq!(structured(&remote)["commits"][0]["subject"], "base");
    let base = fixture.git(&["rev-parse", "HEAD~5"]);
    let by_sha = fixture
        .call("git_log", json!({ "ref": base, "limit": 5 }))
        .await;
    assert_eq!(structured(&by_sha)["commits"].as_array().unwrap().len(), 1);

    for arguments in [
        json!({ "ref": "--all" }),
        json!({ "ref": "no-such-branch" }),
        json!({ "limit": 0 }),
        json!({ "limit": 101 }),
        json!({ "cursor": "nope" }),
    ] {
        let refused = fixture.call("git_log", arguments.clone()).await;
        assert_eq!(tag(&refused), "McpInvalidArgumentError", "{arguments}");
    }
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_log_cuts_a_long_message_and_a_long_file_list() {
    let (fixture, _) = fixture().await;
    for index in 0..60 {
        fixture.write(&format!("many/{index}.txt"), "x\n");
    }
    fixture.git(&["add", "many"]);
    let body = "b".repeat(10_000);
    fixture.git(&["commit", "-qm", "many files", "-m", &body]);
    let log = fixture.call("git_log", json!({ "limit": 1 })).await;
    assert!(text_chars(&log) <= MAX_RESULT_CHARS);
    let commit = &structured(&log)["commits"][0];
    assert_eq!(commit["subject"], "many files");
    // Git ends the body with a line break.
    assert_eq!(commit["bodyChars"], 10_001);
    assert!(commit["body"].as_str().unwrap().chars().count() <= 2_000);
    assert_eq!(commit["changedFileCount"], 60);
    assert_eq!(commit["changedFiles"].as_array().unwrap().len(), 50);
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_refs_lists_branches_remotes_tags_and_stashes() {
    let (fixture, _) = fixture().await;
    fixture.git(&["tag", "v1"]);
    fixture.git(&["branch", "feature"]);
    fixture.write("a.txt", "stashed\n");
    fixture.git(&["stash", "push", "-qm", "wip"]);
    let refs = fixture.call("git_refs", json!({})).await;
    let refs = structured(&refs);
    assert_eq!(refs["threadId"], THREAD);
    assert_eq!(refs["headRef"], "main");
    assert_eq!(refs["remotes"], json!(["origin"]));
    let names = |key: &str| -> Vec<String> {
        refs[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(names("localBranches"), ["feature", "main"]);
    assert!(names("remoteBranches").contains(&"origin/main".to_owned()));
    assert_eq!(names("tags"), ["v1"]);
    let main = &refs["localBranches"][1];
    assert_eq!(main["current"], true);
    assert_eq!(main["upstream"], "origin/main");
    assert!(main.get("blocked").is_none());
    let stash = &refs["stashes"][0];
    assert_eq!(stash["index"], 0);
    assert!(stash["message"].as_str().unwrap().contains("wip"));
    assert_eq!(stash["files"][0]["path"], "a.txt");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_generate_commit_message_is_the_deterministic_update_line() {
    let (fixture, _) = fixture().await;
    fixture.write("a.txt", "changed\n");
    fixture.write("b.txt", "new\n");
    let named = fixture
        .call(
            "git_generate_commit_message",
            json!({ "paths": ["a.txt", "b.txt"] }),
        )
        .await;
    let named = structured(&named);
    assert_eq!(named["threadId"], THREAD);
    assert_eq!(named["message"], "Update a.txt, b.txt");
    let whole = fixture.call("git_generate_commit_message", json!({})).await;
    assert_eq!(structured(&whole)["message"], "Update a.txt");
    let refused = fixture
        .call("git_generate_commit_message", json!({ "paths": ["../x"] }))
        .await;
    assert_eq!(tag(&refused), "McpInvalidArgumentError");
    // Nothing was committed or staged.
    assert_eq!(fixture.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(fixture.git(&["diff", "--cached", "--name-only"]), "");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn git_set_commit_message_suggests_the_last_message_per_folder_and_commits_nothing() {
    let (fixture, intents) = fixture().await;
    let mut panel = intents.subscribe();
    let suggested = fixture
        .call(
            "git_set_commit_message",
            json!({ "message": "Fix the parser\n\nIt skipped the last line." }),
        )
        .await;
    let suggested = structured(&suggested);
    assert_eq!(suggested["threadId"], THREAD);
    assert_eq!(suggested["subscribers"], 1);
    let intent = panel.try_recv().expect("the open panel got it");
    assert_eq!(intent["kind"], "commitMessage");
    assert_eq!(intent["intentId"], suggested["intentId"]);
    assert_eq!(intent["threadId"], THREAD);
    assert_eq!(intent["cwd"], fixture.repo.to_string_lossy().as_ref());
    assert_eq!(
        intent["message"],
        "Fix the parser\n\nIt skipped the last line."
    );
    assert_eq!(
        intent["actor"]["clientId"],
        fixture.agent.principal.session_id.as_str()
    );

    // A panel opened later still receives it, and a second message for the folder replaces it.
    let replaced = fixture
        .call(
            "git_set_commit_message",
            json!({ "message": "Fix the parser" }),
        )
        .await;
    let replaced = structured(&replaced)["intentId"].clone();
    let snapshot = intents.snapshot();
    let messages: Vec<&Value> = snapshot
        .iter()
        .filter(|intent| intent["kind"] == "commitMessage")
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["intentId"], replaced);
    assert_eq!(messages[0]["message"], "Fix the parser");

    for message in [
        json!(""),
        json!("   \n"),
        json!("x".repeat(8_001)),
        json!("bell\u{7}"),
        json!(3),
    ] {
        let refused = fixture
            .call("git_set_commit_message", json!({ "message": message }))
            .await;
        assert_eq!(tag(&refused), "McpInvalidArgumentError", "{message}");
    }
    let longest = fixture
        .call(
            "git_set_commit_message",
            json!({ "message": "x".repeat(8_000) }),
        )
        .await;
    structured(&longest);
    // A suggestion is advice: nothing was committed or staged.
    assert_eq!(fixture.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(fixture.git(&["diff", "--cached", "--name-only"]), "");
    fixture.harness.shutdown().await;
}

#[tokio::test]
async fn reads_work_at_read_only_and_the_suggestion_tools_do_not() {
    let (fixture, _) = fixture().await;
    let (reader, _) = fixture.harness.agent(McpAccess::ReadOnly).await;
    let listed = fixture.harness.control.tools(&reader);
    let listed: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for (name, arguments) in [
        ("git_diff", json!({ "threadId": THREAD, "path": "a.txt" })),
        ("git_log", json!({ "threadId": THREAD })),
        ("git_refs", json!({ "threadId": THREAD })),
    ] {
        assert!(listed.contains(&name), "{name} is listed at read-only");
        let read = fixture.harness.call(&reader, name, arguments).await;
        structured(&read);
    }
    for name in ["git_generate_commit_message", "git_set_commit_message"] {
        assert!(!listed.contains(&name), "{name} is hidden at read-only");
    }

    let operate = fixture.harness.control.tools(&fixture.agent);
    let hints = |name: &str| {
        operate
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))["annotations"]
            .clone()
    };
    for name in ["git_diff", "git_log", "git_refs"] {
        assert_eq!(hints(name)["readOnlyHint"], true, "{name}");
        assert_eq!(hints(name)["idempotentHint"], true, "{name}");
    }
    assert_eq!(hints("git_generate_commit_message")["idempotentHint"], true);
    assert_eq!(hints("git_set_commit_message")["readOnlyHint"], false);
    assert_eq!(hints("git_set_commit_message")["destructiveHint"], false);

    fixture.harness.settings.send_modify(|settings| {
        settings.capabilities.source_control = false;
    });
    let refused = fixture.call("git_log", json!({})).await;
    assert_eq!(tag(&refused), "McpCapabilityDisabledError");
    fixture.harness.shutdown().await;
}
