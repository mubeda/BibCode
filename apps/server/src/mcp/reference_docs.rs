//! Keeps the agent-facing references in `docs/reference/` in step with the code (#139, slice
//! Z): every client tool an outside agent can call has its own `` #### `name` `` entry in
//! `mcp.md`, every error tag of `feed::ERRORS` appears there, and every webhook event type
//! appears in `webhooks.md`. A tool, error or event added later fails here until it is
//! documented.

use std::{collections::BTreeSet, path::Path};

use super::{
    control::{PrincipalKind, tool_specs},
    tools::{feed::ERRORS, previews::PREVIEW_SCHEMAS},
};
use crate::webhooks::events::{EVENT_TYPES, WEBHOOK_TEST};

fn reference(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/reference")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// The spans in single backticks on `text`'s lines outside fenced blocks, so a name counts
/// only where it is written as code, never as part of a longer word.
fn backticked(text: &str) -> BTreeSet<&str> {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .flat_map(|line| line.split('`').skip(1).step_by(2))
        .collect()
}

/// The tool names of the `` #### `name` `` headings in `text`.
fn tool_headings(text: &str) -> BTreeSet<&str> {
    text.lines()
        .filter_map(|line| line.strip_prefix("#### `")?.strip_suffix('`'))
        .collect()
}

#[test]
fn every_client_tool_has_its_own_entry_in_the_mcp_reference() {
    let text = reference("mcp.md");
    let documented = tool_headings(&text);
    let missing: Vec<&str> = tool_specs(PrincipalKind::Client)
        .map(|spec| spec.name)
        .filter(|name| !documented.contains(name))
        .collect();
    assert!(
        missing.is_empty(),
        "document these tools in docs/reference/mcp.md under #### `name`: {missing:?}"
    );
    let registered: BTreeSet<&str> = tool_specs(PrincipalKind::Client)
        .map(|spec| spec.name)
        .collect();
    let stale: Vec<&&str> = documented.difference(&registered).collect();
    assert!(
        stale.is_empty(),
        "docs/reference/mcp.md documents tools that are not registered: {stale:?}"
    );
}

/// The lines of the `` #### `name` `` entry in `text`, up to the next heading.
fn tool_section<'a>(text: &'a str, name: &str) -> String {
    let heading = format!("#### `{name}`");
    text.lines()
        .skip_while(|line| *line != heading)
        .skip(1)
        .take_while(|line| !line.starts_with("#### "))
        .collect::<Vec<_>>()
        .join(
            "
",
        )
}

#[test]
fn every_preview_argument_is_in_its_mcp_reference_entry() {
    let text = reference("mcp.md");
    for (name, tool) in PREVIEW_SCHEMAS.iter() {
        let section = tool_section(&text, name);
        assert!(!section.is_empty(), "{name} has an entry");
        let documented = backticked(&section);
        let properties = tool["inputSchema"]["properties"].as_object().unwrap();
        let missing: Vec<&String> = properties
            .keys()
            .filter(|argument| !documented.contains(argument.as_str()))
            .collect();
        assert!(
            missing.is_empty(),
            "document these arguments of {name} in docs/reference/mcp.md: {missing:?}"
        );
    }
}

#[test]
fn every_error_tag_is_in_the_mcp_reference() {
    let text = reference("mcp.md");
    let documented = backticked(&text);
    let missing: Vec<&str> = ERRORS
        .iter()
        .map(|(tag, _, _)| *tag)
        .filter(|tag| !documented.contains(tag))
        .collect();
    assert!(
        missing.is_empty(),
        "describe these errors in docs/reference/mcp.md: {missing:?}"
    );
}

#[test]
fn every_webhook_event_is_in_the_webhooks_reference() {
    let text = reference("webhooks.md");
    let documented = backticked(&text);
    let missing: Vec<&str> = EVENT_TYPES
        .iter()
        .map(|(event, _)| *event)
        .chain([WEBHOOK_TEST])
        .filter(|event| !documented.contains(event))
        .collect();
    assert!(
        missing.is_empty(),
        "describe these events in docs/reference/webhooks.md: {missing:?}"
    );
}
