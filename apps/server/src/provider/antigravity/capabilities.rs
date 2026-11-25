//! Antigravity workspace/user skill discovery and ACP command catalog merging.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use tokio::fs;
use tokio::io::AsyncReadExt;

const PROJECT_SKILL_SUBDIRS: [&str; 4] = [
    ".agents/skills",
    ".agent/skills",
    "_agents/skills",
    "_agent/skills",
];
const USER_GEMINI_SKILLS_SUBDIR: &str = ".gemini/config/skills";

/// Dependency and build folders hold no skills and can be huge.
const SKIPPED_FOLDERS: [&str; 6] = [
    "node_modules",
    ".git",
    "target",
    ".venv",
    "venv",
    "__pycache__",
];
const MAX_SKILL_DEPTH: usize = 10;
const MAX_SKILL_SCAN_ENTRIES: usize = 10_000;
const MAX_SKILL_FILE_READ_BYTES: u64 = 64 * 1024;

/// A single slash command or skill advertised by `agy acp` in `available_commands_update`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AcpAvailableCommand {
    pub name: String,
    pub description: Option<String>,
    pub input_hint: Option<String>,
}

/// A local Antigravity skill discovered under project or user skill roots.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalAntigravitySkill {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub scope: &'static str,
}

/// Bounded local Antigravity skill scan output and any diagnostic issues encountered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LocalSkillScanResult {
    pub skills: Vec<LocalAntigravitySkill>,
    pub issues: Vec<String>,
}

/// Normalized capability catalog split into Antigravity slash commands and skills.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergedAntigravityCapabilities {
    pub slash_commands: Vec<Value>,
    pub skills: Vec<Value>,
}

#[derive(Default)]
struct SkillScan {
    visited: HashMap<PathBuf, Visit>,
    names: HashSet<String>,
    entries: usize,
    exhausted: bool,
    depth_reported: bool,
}

struct Visit {
    depth: usize,
    cut_off: bool,
}

/// Scans Antigravity project skill roots and `~/.gemini/config/skills` using host environment.
#[allow(dead_code)]
pub async fn discover_local_skills(workspace: &Path) -> LocalSkillScanResult {
    let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    discover_local_skills_with_environment(workspace, &environment).await
}

/// Scans `.agents/skills`, `.agent/skills`, `_agents/skills`, `_agent/skills` up to the `.git`
/// root plus `~/.gemini/config/skills`, bounded by depth, scanned entry budget, and cycle checks.
pub async fn discover_local_skills_with_environment(
    workspace: &Path,
    environment: &[(OsString, OsString)],
) -> LocalSkillScanResult {
    let home = configured_home(environment).or_else(dirs::home_dir);
    let roots = antigravity_skill_roots(workspace, home.as_deref()).await;
    let mut scan = SkillScan::default();
    let mut result = LocalSkillScanResult::default();
    for (root, scope) in roots {
        if scan.exhausted {
            break;
        }
        scan_skill_root(&root, scope, &mut scan, &mut result).await;
    }
    result
}

/// Parses an ACP `availableCommands` JSON array into normalized entries, skipping blank names.
pub fn parse_acp_available_commands(commands: &[Value]) -> Vec<AcpAvailableCommand> {
    commands
        .iter()
        .filter_map(|entry| {
            let name = trimmed_non_empty(entry.get("name").and_then(Value::as_str))?.to_owned();
            let description = trimmed_non_empty(entry.get("description").and_then(Value::as_str))
                .map(str::to_owned);
            let input_hint =
                trimmed_non_empty(entry.pointer("/input/hint").and_then(Value::as_str))
                    .map(str::to_owned);
            Some(AcpAvailableCommand {
                name,
                description,
                input_hint,
            })
        })
        .collect()
}

/// Extracts `available_commands_update` command items from ACP `session/update` parameters.
pub fn parse_available_commands_update(params: &Value) -> Option<Vec<AcpAvailableCommand>> {
    let update = params.get("update")?;
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("available_commands_update") {
        return None;
    }
    let commands = update.get("availableCommands")?.as_array()?;
    Some(parse_acp_available_commands(commands))
}

/// Merges an optional authoritative ACP command list with locally discovered Antigravity skills.
///
/// When `available_commands` is `Some`, it is authoritative (including `Some(&[])`): entries
/// matching local skills become `skills`, remaining entries become `slash_commands`, and unlisted
/// local skills are omitted. When `available_commands` is `None`, all local skills are returned.
pub fn merge_acp_available_commands(
    available_commands: Option<&[AcpAvailableCommand]>,
    local_skills: &[LocalAntigravitySkill],
) -> MergedAntigravityCapabilities {
    let mut merged = MergedAntigravityCapabilities::default();
    let Some(commands) = available_commands else {
        let mut seen = HashSet::new();
        for skill in local_skills {
            let Some(name) = trimmed_non_empty(Some(skill.name.as_str())) else {
                continue;
            };
            if seen.insert(name.to_ascii_lowercase()) {
                merged
                    .skills
                    .push(build_skill_json(name, skill.description.as_deref(), skill));
            }
        }
        return merged;
    };

    let mut local_by_name: HashMap<String, &LocalAntigravitySkill> = HashMap::new();
    for skill in local_skills {
        if let Some(name) = trimmed_non_empty(Some(skill.name.as_str())) {
            local_by_name
                .entry(name.to_ascii_lowercase())
                .or_insert(skill);
        }
    }

    let mut seen = HashSet::new();
    for command in commands {
        let Some(name) = trimmed_non_empty(Some(command.name.as_str())) else {
            continue;
        };
        let key = name.to_ascii_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }
        if let Some(local) = local_by_name.get(&key) {
            let description = trimmed_non_empty(command.description.as_deref())
                .or_else(|| trimmed_non_empty(local.description.as_deref()));
            merged
                .skills
                .push(build_skill_json(name, description, local));
        } else {
            merged
                .slash_commands
                .push(build_slash_command_json(name, command));
        }
    }
    merged
}

fn build_skill_json(name: &str, description: Option<&str>, local: &LocalAntigravitySkill) -> Value {
    let mut object = Map::new();
    object.insert("name".to_owned(), Value::String(name.to_owned()));
    if let Some(description) = trimmed_non_empty(description) {
        object.insert(
            "description".to_owned(),
            Value::String(description.to_owned()),
        );
    }
    object.insert("path".to_owned(), Value::String(local.path.clone()));
    object.insert("scope".to_owned(), Value::String(local.scope.to_owned()));
    object.insert("enabled".to_owned(), Value::Bool(true));
    object.insert("invocation".to_owned(), Value::String("slash".to_owned()));
    Value::Object(object)
}

fn build_slash_command_json(name: &str, command: &AcpAvailableCommand) -> Value {
    let mut object = Map::new();
    object.insert("name".to_owned(), Value::String(name.to_owned()));
    if let Some(description) = trimmed_non_empty(command.description.as_deref()) {
        object.insert(
            "description".to_owned(),
            Value::String(description.to_owned()),
        );
    }
    if let Some(hint) = trimmed_non_empty(command.input_hint.as_deref()) {
        object.insert("input".to_owned(), json!({ "hint": hint }));
    }
    Value::Object(object)
}

async fn antigravity_skill_roots(
    workspace: &Path,
    home: Option<&Path>,
) -> Vec<(PathBuf, &'static str)> {
    let mut project_directories = vec![workspace];
    // Stay inside the containing repository; outside a repository only scan `workspace` itself.
    for ancestor in workspace.ancestors() {
        if fs::metadata(ancestor.join(".git")).await.is_ok() {
            project_directories = workspace
                .ancestors()
                .take_while(|path| *path != ancestor)
                .collect();
            project_directories.push(ancestor);
            break;
        }
    }
    let mut roots: Vec<(PathBuf, &'static str)> = project_directories
        .into_iter()
        .flat_map(|directory| {
            PROJECT_SKILL_SUBDIRS.map(|relative| (directory.join(relative), "project"))
        })
        .collect();
    if let Some(home) = home {
        roots.push((home.join(USER_GEMINI_SKILLS_SUBDIR), "user"));
    }
    roots
}

fn configured_home(environment: &[(OsString, OsString)]) -> Option<PathBuf> {
    let variable_names: &[&str] = if cfg!(windows) {
        &["USERPROFILE", "HOME"]
    } else {
        &["HOME"]
    };
    variable_names.iter().find_map(|expected_name| {
        environment
            .iter()
            .rev()
            .find(|(name, value)| {
                environment_name_matches(name, expected_name) && !value.is_empty()
            })
            .map(|(_, value)| PathBuf::from(value))
    })
}

fn environment_name_matches(name: &OsStr, expected: &str) -> bool {
    if cfg!(windows) {
        name.to_string_lossy().eq_ignore_ascii_case(expected)
    } else {
        name == OsStr::new(expected)
    }
}

fn mark_cut_off(
    scan: &mut SkillScan,
    chain: &[(Option<usize>, PathBuf)],
    mut node: Option<usize>,
    until: Option<&Path>,
) {
    while let Some(index) = node {
        let (parent, canonical) = &chain[index];
        if until == Some(canonical.as_path()) {
            break;
        }
        if let Some(visit) = scan.visited.get_mut(canonical) {
            visit.cut_off = true;
        }
        node = *parent;
    }
}

async fn scan_skill_root(
    root: &Path,
    scope: &'static str,
    scan: &mut SkillScan,
    result: &mut LocalSkillScanResult,
) {
    let first = result.skills.len();
    let mut chain: Vec<(Option<usize>, PathBuf)> = Vec::new();
    let mut pending: Vec<(PathBuf, usize, Option<usize>)> = vec![(root.to_path_buf(), 0, None)];
    while let Some((folder, depth, parent)) = pending.pop() {
        if scan.exhausted {
            break;
        }
        let canonical = match fs::canonicalize(&folder).await {
            Ok(path) => path,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound
                    || folder != root
                    || fs::symlink_metadata(&folder).await.is_ok()
                {
                    result.issues.push(format!(
                        "Cannot read skills in {}: {error}",
                        folder.display()
                    ));
                }
                continue;
            }
        };
        if let Some(visit) = scan.visited.get(&canonical)
            && !(visit.cut_off && depth < visit.depth)
        {
            let in_progress = std::iter::successors(parent, |&index| chain[index].0)
                .any(|index| chain[index].1 == canonical);
            if visit.cut_off {
                mark_cut_off(scan, &chain, parent, None);
            } else if in_progress {
                mark_cut_off(scan, &chain, parent, Some(&canonical));
            }
            continue;
        }
        if depth > MAX_SKILL_DEPTH {
            mark_cut_off(scan, &chain, parent, None);
            if !std::mem::replace(&mut scan.depth_reported, true) {
                result.issues.push(format!(
                    "Skill list is incomplete: skipped folders deeper than {MAX_SKILL_DEPTH} under {}",
                    root.display()
                ));
            }
            continue;
        }
        scan.visited.insert(
            canonical.clone(),
            Visit {
                depth,
                cut_off: false,
            },
        );
        chain.push((parent, canonical));
        let node = Some(chain.len() - 1);

        let skill_path = folder.join("SKILL.md");
        match fs::metadata(&skill_path).await {
            Ok(metadata) if metadata.is_file() => {
                if let Some((name, description)) =
                    read_skill_metadata(&folder, &skill_path, &mut result.issues).await
                    && scan.names.insert(name.to_ascii_lowercase())
                {
                    result.skills.push(LocalAntigravitySkill {
                        name,
                        description,
                        path: skill_path.to_string_lossy().into_owned(),
                        scope,
                    });
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                result
                    .issues
                    .push(format!("Cannot read {}: {error}", skill_path.display()));
            }
            _ => {}
        }

        let mut entries = match fs::read_dir(&folder).await {
            Ok(entries) => entries,
            Err(error) => {
                result.issues.push(format!(
                    "Cannot read skills in {}: {error}",
                    folder.display()
                ));
                continue;
            }
        };
        let mut children = Vec::new();
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => {
                    scan.entries += 1;
                    if scan.entries > MAX_SKILL_SCAN_ENTRIES {
                        scan.exhausted = true;
                        result.issues.push(format!(
                            "Skill list is incomplete: stopped after {MAX_SKILL_SCAN_ENTRIES} entries under {}",
                            root.display()
                        ));
                        break;
                    }
                    let name = entry.file_name();
                    if SKIPPED_FOLDERS.iter().any(|skipped| name == *skipped) {
                        continue;
                    }
                    let is_directory = match entry.file_type().await {
                        Ok(file_type) if file_type.is_dir() => Ok(true),
                        Ok(file_type) if file_type.is_symlink() => {
                            fs::metadata(entry.path()).await.map(|m| m.is_dir())
                        }
                        Ok(_) => Ok(false),
                        Err(error) => Err(error),
                    };
                    match is_directory {
                        Ok(true) => children.push(entry.path()),
                        Ok(false) => {}
                        Err(error) => result
                            .issues
                            .push(format!("Cannot read {}: {error}", entry.path().display())),
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    result.issues.push(format!(
                        "Incomplete skills in {}: {error}",
                        folder.display()
                    ));
                    break;
                }
            }
        }
        children.sort();
        pending.extend(
            children
                .into_iter()
                .rev()
                .map(|child| (child, depth + 1, node)),
        );
    }
    result.skills[first..].sort_by(|left, right| left.name.cmp(&right.name));
}

async fn read_skill_metadata(
    folder: &Path,
    skill_path: &Path,
    issues: &mut Vec<String>,
) -> Option<(String, Option<String>)> {
    let mut frontmatter_name = None;
    let mut frontmatter_description = None;
    match fs::File::open(skill_path).await {
        Ok(file) => {
            let mut buffer = Vec::new();
            match file
                .take(MAX_SKILL_FILE_READ_BYTES)
                .read_to_end(&mut buffer)
                .await
            {
                Ok(_) => {
                    let contents = String::from_utf8_lossy(&buffer);
                    (frontmatter_name, frontmatter_description) =
                        parse_skill_frontmatter(&contents);
                }
                Err(error) => {
                    issues.push(format!("Cannot read {}: {error}", skill_path.display()));
                }
            }
        }
        Err(error) => {
            issues.push(format!("Cannot read {}: {error}", skill_path.display()));
        }
    }

    let name = frontmatter_name.or_else(|| {
        folder
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| trimmed_non_empty(Some(value)))
            .map(str::to_owned)
    })?;
    Some((name, frontmatter_description))
}

fn parse_skill_frontmatter(contents: &str) -> (Option<String>, Option<String>) {
    let trimmed_bom = contents.trim_start_matches('\u{feff}');
    let mut lines = trimmed_bom.lines();
    let Some(first_line) = lines.next() else {
        return (None, None);
    };
    if first_line.trim() != "---" {
        return (None, None);
    }

    let mut name = None;
    let mut description = None;
    let mut closed = false;
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            closed = true;
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once(':') else {
            continue;
        };
        let key = raw_key.trim();
        if key == "name" && name.is_none() {
            name = unquote_yaml_scalar(raw_value);
        } else if key == "description" && description.is_none() {
            description = unquote_yaml_scalar(raw_value);
        }
    }

    if closed {
        (name, description)
    } else {
        (None, None)
    }
}

fn unquote_yaml_scalar(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    trimmed_non_empty(Some(unquoted)).map(str::to_owned)
}

fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|trimmed| !trimmed.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_skill(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir).expect("create skill dir");
        std::fs::write(dir.join("SKILL.md"), body).expect("write SKILL.md");
    }

    fn isolated_home_env(home: &Path) -> Vec<(OsString, OsString)> {
        vec![
            (OsString::from("HOME"), home.as_os_str().to_os_string()),
            (
                OsString::from("USERPROFILE"),
                home.as_os_str().to_os_string(),
            ),
        ]
    }

    #[tokio::test]
    async fn scans_project_skill_folders_up_to_git_root_and_user_gemini_skills() {
        let temp = tempfile::tempdir().expect("tempdir");
        let outside = temp.path().join("outside/.agents/skills/should-not-scan");
        write_skill(&outside, "# Outside\n");

        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).expect("create .git");
        let sub = repo.join("packages/app");
        let home = temp.path().join("home");

        write_skill(&sub.join(".agents/skills/ws-dot-agents"), "# WS\n");
        write_skill(&sub.join(".agent/skills/ws-dot-agent"), "# WS\n");
        write_skill(&sub.join("_agents/skills/ws-under-agents"), "# WS\n");
        write_skill(&sub.join("_agent/skills/ws-under-agent"), "# WS\n");
        write_skill(&repo.join(".agents/skills/root-skill"), "# Root\n");
        write_skill(&home.join(".gemini/config/skills/user-skill"), "# User\n");

        let env = isolated_home_env(&home);
        let result = discover_local_skills_with_environment(&sub, &env).await;
        assert!(result.issues.is_empty(), "issues: {:?}", result.issues);

        let names: Vec<(&str, &str)> = result
            .skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.scope))
            .collect();
        for expected in [
            ("ws-dot-agents", "project"),
            ("ws-dot-agent", "project"),
            ("ws-under-agents", "project"),
            ("ws-under-agent", "project"),
            ("root-skill", "project"),
            ("user-skill", "user"),
        ] {
            assert!(
                names.contains(&expected),
                "missing {expected:?} in {names:?}"
            );
        }
        assert!(
            !names.iter().any(|(name, _)| *name == "should-not-scan"),
            "should not scan above .git: {names:?}"
        );

        // Without .git in ancestors, unrelated parent folders must not be scanned.
        let unrooted_parent = temp.path().join("plain-parent");
        write_skill(
            &unrooted_parent.join(".agents/skills/parent-unrooted"),
            "# Parent\n",
        );
        let unrooted_ws = unrooted_parent.join("child");
        write_skill(
            &unrooted_ws.join(".agents/skills/child-unrooted"),
            "# Child\n",
        );
        let empty_home = temp.path().join("empty-home");
        let unrooted =
            discover_local_skills_with_environment(&unrooted_ws, &isolated_home_env(&empty_home))
                .await;
        let unrooted_names: Vec<&str> = unrooted.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(unrooted_names, vec!["child-unrooted"]);
    }

    #[tokio::test]
    async fn parses_frontmatter_metadata_and_deduplicates_case_insensitively() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).expect("create .git");
        let home = temp.path().join("home");

        write_skill(
            &repo.join(".agents/skills/folder-renamed"),
            "---\nname: \"frontmatter-skill\"\ndescription: 'Quoted description'\n---\n# Body\n",
        );
        write_skill(
            &repo.join(".agent/skills/no-name-frontmatter"),
            "---\ndescription: Only description\n---\n",
        );
        write_skill(
            &repo.join("_agents/skills/SharedSkill"),
            "---\nname: SharedSkill\ndescription: Project copy\n---\n",
        );
        write_skill(
            &home.join(".gemini/config/skills/sharedskill"),
            "---\nname: sharedskill\ndescription: User copy\n---\n",
        );

        let result = discover_local_skills_with_environment(&repo, &isolated_home_env(&home)).await;
        assert!(result.issues.is_empty(), "issues: {:?}", result.issues);

        let by_name = |name: &str| result.skills.iter().find(|s| s.name == name);
        let frontmatter = by_name("frontmatter-skill").expect("frontmatter-skill present");
        assert_eq!(
            frontmatter.description.as_deref(),
            Some("Quoted description")
        );
        assert_eq!(frontmatter.scope, "project");

        let folder_fallback = by_name("no-name-frontmatter").expect("folder name fallback present");
        assert_eq!(
            folder_fallback.description.as_deref(),
            Some("Only description")
        );

        let shared: Vec<_> = result
            .skills
            .iter()
            .filter(|s| s.name.eq_ignore_ascii_case("SharedSkill"))
            .collect();
        assert_eq!(
            shared.len(),
            1,
            "expected project copy to deduplicate user copy"
        );
        assert_eq!(shared[0].scope, "project");
        assert_eq!(shared[0].description.as_deref(), Some("Project copy"));
    }

    #[tokio::test]
    async fn skips_ignored_folders_and_bounds_depth_cycles_and_entry_count() {
        let temp = tempfile::tempdir().expect("tempdir");
        let empty_home = temp.path().join("empty-home");
        let root = temp.path().join("ws");
        let skills_root = root.join(".agents/skills");
        for skipped in [
            "node_modules",
            ".git",
            "target",
            ".venv",
            "venv",
            "__pycache__",
        ] {
            write_skill(&skills_root.join(skipped).join("hidden-skill"), "# Skip\n");
        }
        write_skill(&skills_root.join("visible-skill"), "# Ok\n");

        // Deep nesting > depth 10.
        let mut deep = skills_root.join("deep");
        for level in 0..12 {
            deep = deep.join(format!("l{level}"));
        }
        write_skill(&deep, "# Too deep\n");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&skills_root, skills_root.join("loop-back"))
            .expect("create cycle symlink");

        let result =
            discover_local_skills_with_environment(&root, &isolated_home_env(&empty_home)).await;
        let names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["visible-skill"]);
        assert!(
            result
                .issues
                .iter()
                .any(|issue| issue.contains("deeper than 10")),
            "expected depth issue, got: {:?}",
            result.issues
        );

        // Exceed 10,000 scanned entries and verify bounded truncation notice.
        let big_temp = tempfile::tempdir().expect("big tempdir");
        let big_skills = big_temp.path().join(".agents/skills");
        std::fs::create_dir_all(&big_skills).expect("create big skills dir");
        for index in 0..10_010 {
            let file = big_skills.join(format!("entry-{index:05}.txt"));
            std::fs::write(file, "").expect("write filler entry");
        }
        let capped = discover_local_skills_with_environment(
            big_temp.path(),
            &isolated_home_env(&empty_home),
        )
        .await;
        assert!(
            capped
                .issues
                .iter()
                .any(|issue| issue.contains("10000") || issue.contains("10,000")),
            "expected entry cap issue, got: {:?}",
            capped.issues
        );
    }

    #[test]
    fn merge_respects_authoritative_acp_catalog_including_empty_and_falls_back_on_none() {
        let local = vec![
            LocalAntigravitySkill {
                name: "review-branch".to_owned(),
                description: Some("Local review skill".to_owned()),
                path: "/ws/.agents/skills/review-branch/SKILL.md".to_owned(),
                scope: "project",
            },
            LocalAntigravitySkill {
                name: "docs-check".to_owned(),
                description: Some("Local docs check".to_owned()),
                path: "/home/.gemini/config/skills/docs-check/SKILL.md".to_owned(),
                scope: "user",
            },
        ];

        // Authoritative empty list drops all local skills rather than falling back.
        let auth_empty = merge_acp_available_commands(Some(&[]), &local);
        assert!(auth_empty.skills.is_empty());
        assert!(auth_empty.slash_commands.is_empty());

        // `None` falls back cleanly to local slash-invocable skills with zero duplicates.
        let dup_local = [local.clone(), vec![local[0].clone()]].concat();
        let fallback = merge_acp_available_commands(None, &dup_local);
        assert!(fallback.slash_commands.is_empty());
        assert_eq!(fallback.skills.len(), 2);
        assert_eq!(
            fallback.skills[0],
            json!({
                "name": "review-branch",
                "description": "Local review skill",
                "path": "/ws/.agents/skills/review-branch/SKILL.md",
                "scope": "project",
                "enabled": true,
                "invocation": "slash",
            })
        );

        // `Some(list)` classifies matches as skills, non-matches as slashCommands, zero duplicates,
        // and omits local skills not listed by ACP.
        let parsed = parse_acp_available_commands(&[
            json!({ "name": "review-branch", "description": "ACP review skill" }),
            json!({ "name": "Review-Branch", "description": "Duplicate differing case" }),
            json!({ "name": "plan", "description": "Switch to plan", "input": { "hint": "goal" } }),
            json!({ "name": "plan", "description": "Duplicate command" }),
            json!({ "name": "   " }),
        ]);
        let merged = merge_acp_available_commands(Some(&parsed), &local);
        assert_eq!(merged.skills.len(), 1);
        assert_eq!(
            merged.skills[0],
            json!({
                "name": "review-branch",
                "description": "ACP review skill",
                "path": "/ws/.agents/skills/review-branch/SKILL.md",
                "scope": "project",
                "enabled": true,
                "invocation": "slash",
            })
        );
        assert_eq!(merged.slash_commands.len(), 1);
        assert_eq!(
            merged.slash_commands[0],
            json!({
                "name": "plan",
                "description": "Switch to plan",
                "input": { "hint": "goal" },
            })
        );

        let update = json!({
            "sessionId": "session-1",
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": [{ "name": "review-branch" }]
            }
        });
        assert_eq!(
            parse_available_commands_update(&update),
            Some(vec![AcpAvailableCommand {
                name: "review-branch".to_owned(),
                description: None,
                input_hint: None,
            }])
        );
        assert_eq!(parse_available_commands_update(&json!({})), None);
    }
}
