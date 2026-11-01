use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use tokio::fs;

#[derive(Debug, Default)]
pub struct CursorWorkspaceCapabilities {
    pub slash_commands: Vec<Value>,
    pub skills: Vec<Value>,
    pub agents: Vec<Value>,
    pub issues: Vec<String>,
}

pub async fn discover_workspace_capabilities(workspace: &Path) -> CursorWorkspaceCapabilities {
    let mut capabilities = CursorWorkspaceCapabilities::default();
    discover_into(workspace, dirs::home_dir().as_deref(), &mut capabilities).await;
    capabilities
}

pub async fn discover_workspace_capabilities_with_environment(
    workspace: &Path,
    environment: &[(OsString, OsString)],
) -> CursorWorkspaceCapabilities {
    let mut capabilities = CursorWorkspaceCapabilities::default();
    discover_workspace_capabilities_into(workspace, environment, &mut capabilities).await;
    capabilities
}

/// Fills `capabilities` as it goes, so a caller that cancels the future (for
/// example on a timeout) keeps everything found so far.
pub async fn discover_workspace_capabilities_into(
    workspace: &Path,
    environment: &[(OsString, OsString)],
    capabilities: &mut CursorWorkspaceCapabilities,
) {
    let home = configured_home(environment).or_else(dirs::home_dir);
    discover_into(workspace, home.as_deref(), capabilities).await;
}

#[cfg(test)]
async fn discover_workspace_capabilities_with_home(
    workspace: &Path,
    home: Option<&Path>,
) -> CursorWorkspaceCapabilities {
    let mut capabilities = CursorWorkspaceCapabilities::default();
    discover_into(workspace, home, &mut capabilities).await;
    capabilities
}

async fn discover_into(
    workspace: &Path,
    home: Option<&Path>,
    capabilities: &mut CursorWorkspaceCapabilities,
) {
    let command_roots = scoped_roots(workspace, home, ".cursor/commands");
    let mut command_names = HashSet::new();
    for (root, _scope) in command_roots {
        for (name, _path) in markdown_files(&root).await {
            if command_names.insert(name.to_ascii_lowercase()) {
                capabilities.slash_commands.push(json!({ "name": name }));
            }
        }
    }

    let mut scan = SkillScan::default();
    for (root, scope) in skill_roots(workspace, home).await {
        scan_skills(&root, scope, &mut scan, capabilities).await;
    }

    let mut agent_names = HashSet::new();
    for (root, _scope) in agent_roots(workspace, home) {
        for (name, _path) in markdown_files(&root).await {
            if agent_names.insert(name.to_ascii_lowercase()) {
                capabilities.agents.push(json!({ "name": name }));
            }
        }
    }
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

fn scoped_roots(
    workspace: &Path,
    home: Option<&Path>,
    relative: &str,
) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![(workspace.join(relative), "project")];
    if let Some(home) = home {
        roots.push((home.join(relative), "user"));
    }
    roots
}

async fn skill_roots(workspace: &Path, home: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    const RELATIVE: [&str; 4] = [
        ".cursor/skills",
        ".agents/skills",
        ".claude/skills",
        ".codex/skills",
    ];
    let mut project_directories = vec![workspace];
    // A chat can start below the worktree root. Do not search unrelated ancestors
    // when the selected directory is outside a repository.
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
    let mut roots = project_directories
        .into_iter()
        .flat_map(|directory| RELATIVE.map(|relative| (directory.join(relative), "project")))
        .collect::<Vec<_>>();
    if let Some(home) = home {
        roots.extend(RELATIVE.map(|relative| (home.join(relative), "user")));
    }
    roots
}

fn agent_roots(workspace: &Path, home: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let mut roots = vec![
        (workspace.join(".cursor/agents"), "project"),
        (workspace.join(".claude/agents"), "project"),
        (workspace.join(".codex/agents"), "project"),
    ];
    if let Some(home) = home {
        roots.extend([
            (home.join(".cursor/agents"), "user"),
            (home.join(".claude/agents"), "user"),
            (home.join(".codex/agents"), "user"),
        ]);
    }
    roots
}

async fn markdown_files(directory: &Path) -> Vec<(String, String)> {
    let Ok(mut entries) = fs::read_dir(directory).await else {
        return Vec::new();
    };
    let mut files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let is_markdown = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        let is_file = entry
            .file_type()
            .await
            .is_ok_and(|file_type| file_type.is_file());
        if !is_file || !is_markdown {
            continue;
        }
        let Some(name) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        files.push((name.to_owned(), path.to_string_lossy().into_owned()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

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

/// State shared by every root of one discovery, so a root that leads into an
/// already walked tree costs nothing and the budget covers the whole scan.
#[derive(Default)]
struct SkillScan {
    visited: HashSet<PathBuf>,
    names: HashSet<String>,
    entries: usize,
    exhausted: bool,
    depth_reported: bool,
}

async fn scan_skills(
    root: &Path,
    scope: &'static str,
    scan: &mut SkillScan,
    capabilities: &mut CursorWorkspaceCapabilities,
) {
    let first = capabilities.skills.len();
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((folder, depth)) = pending.pop() {
        if scan.exhausted {
            break;
        }
        if depth > MAX_SKILL_DEPTH {
            if !std::mem::replace(&mut scan.depth_reported, true) {
                capabilities.issues.push(format!(
                    "Skill list is incomplete: skipped folders deeper than {MAX_SKILL_DEPTH} under {}",
                    root.display()
                ));
            }
            continue;
        }
        let canonical = match fs::canonicalize(&folder).await {
            Ok(path) => path,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound
                    || folder != root
                    || fs::symlink_metadata(&folder).await.is_ok()
                {
                    capabilities.issues.push(format!(
                        "Cannot read skills in {}: {error}",
                        folder.display()
                    ));
                }
                continue;
            }
        };
        if !scan.visited.insert(canonical) {
            continue;
        }
        let path = folder.join("SKILL.md");
        match fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() => {
                if let Some(name) = folder
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    && scan.names.insert(name.to_ascii_lowercase())
                {
                    capabilities.skills.push(json!({
                        "name": name,
                        "path": path.to_string_lossy(),
                        "scope": scope,
                        "enabled": true,
                        "invocation": "slash",
                    }));
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                capabilities
                    .issues
                    .push(format!("Cannot read {}: {error}", path.display()));
            }
            _ => {}
        }
        let mut entries = match fs::read_dir(&folder).await {
            Ok(entries) => entries,
            Err(error) => {
                capabilities.issues.push(format!(
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
                        capabilities.issues.push(format!(
                            "Skill list is incomplete: stopped after {MAX_SKILL_SCAN_ENTRIES} entries under {}",
                            root.display()
                        ));
                        break;
                    }
                    let name = entry.file_name();
                    if SKIPPED_FOLDERS.iter().any(|skipped| name == *skipped) {
                        continue;
                    }
                    // The listing already says what a plain entry is; only a link needs a stat.
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
                        Err(error) => capabilities
                            .issues
                            .push(format!("Cannot read {}: {error}", entry.path().display())),
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    capabilities.issues.push(format!(
                        "Incomplete skills in {}: {error}",
                        folder.display()
                    ));
                    break;
                }
            }
        }
        children.sort();
        pending.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
    }
    capabilities.skills[first..]
        .sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(root: &Path, relative: &str) {
        let directory = root.join(relative);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("SKILL.md"), "# Skill").unwrap();
    }

    #[tokio::test]
    async fn user_catalog_survives_an_empty_repo_and_combines_with_project_skills() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        skill(home.path(), ".agents/skills/group/personal");
        skill(home.path(), ".claude/skills/claude-user");
        skill(home.path(), ".codex/skills/.system/system-user");
        let user_only =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        let names = user_only
            .skills
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["personal", "claude-user", "system-user"]);
        assert!(user_only.skills.iter().all(|s| s["scope"] == "user"));

        skill(project.path(), ".cursor/skills/repository");
        skill(project.path(), ".agents/skills/personal");
        let combined =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        assert_eq!(combined.skills.len(), 4);
        let personal = combined
            .skills
            .iter()
            .find(|s| s["name"] == "personal")
            .unwrap();
        assert_eq!(personal["scope"], "project");
        assert!(combined.skills.iter().any(|s| s["name"] == "claude-user"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn follows_user_skill_links_without_looping_or_leaking_another_home() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        skill(external.path(), "linked-skill");
        let root = home.path().join(".agents/skills");
        std::fs::create_dir_all(&root).unwrap();
        symlink(
            external.path().join("linked-skill"),
            root.join("linked-skill"),
        )
        .unwrap();
        symlink(&root, root.join("cycle")).unwrap();
        symlink(external.path().join("missing"), root.join("broken")).unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())),
        )
        .await
        .unwrap();
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0]["name"], "linked-skill");
        assert_eq!(result.skills[0]["scope"], "user");
        assert_eq!(result.issues.len(), 1);
        assert!(result.issues[0].contains("broken"));
    }

    #[tokio::test]
    async fn includes_worktree_ancestors_but_excludes_sibling_projects() {
        let tree = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tree.path().join(".git")).unwrap();
        let workspace = tree.path().join("packages/current");
        std::fs::create_dir_all(&workspace).unwrap();
        skill(tree.path(), ".cursor/skills/root-skill");
        skill(tree.path(), "packages/sibling/.cursor/skills/sibling-skill");
        skill(&workspace, ".agents/skills/local-skill");
        let result = discover_workspace_capabilities_with_home(&workspace, Some(home.path())).await;
        let names = result
            .skills
            .iter()
            .map(|skill| skill["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["local-skill", "root-skill"]);
    }

    fn names(result: &CursorWorkspaceCapabilities) -> Vec<&str> {
        result
            .skills
            .iter()
            .map(|skill| skill["name"].as_str().unwrap())
            .collect()
    }

    fn files(directory: &Path, count: usize) {
        std::fs::create_dir_all(directory).unwrap();
        for index in 0..count {
            std::fs::write(directory.join(format!("file-{index}")), "").unwrap();
        }
    }

    #[tokio::test]
    async fn dependency_folders_inside_a_skill_do_not_exhaust_the_scan() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        skill(home.path(), ".agents/skills/review");
        files(
            &home.path().join(".agents/skills/review/tests/node_modules"),
            10_001,
        );
        skill(home.path(), ".agents/skills/sibling");
        skill(home.path(), ".claude/skills/later");
        let result =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        assert_eq!(names(&result), ["review", "sibling", "later"]);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
    }

    #[tokio::test]
    async fn skill_files_inside_skipped_folders_are_not_listed() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        skill(home.path(), ".agents/skills/tool/node_modules/package");
        skill(home.path(), ".agents/skills/.git/hooked");
        skill(home.path(), ".agents/skills/.hidden/kept");
        let result =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        assert_eq!(names(&result), ["kept"]);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
    }

    #[tokio::test]
    async fn an_entry_budget_keeps_the_skills_found_before_it_ran_out() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        skill(home.path(), ".agents/skills/a-first");
        files(&home.path().join(".agents/skills/b-bulk"), 10_001);
        skill(home.path(), ".claude/skills/later");
        let started = std::time::Instant::now();
        let result =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        let elapsed = started.elapsed();
        assert!(elapsed < std::time::Duration::from_secs(5), "{elapsed:?}");
        assert_eq!(names(&result), ["a-first"]);
        assert_eq!(result.issues.len(), 1, "{:?}", result.issues);
        assert!(
            result.issues[0].starts_with("Skill list is incomplete: stopped after 10000 entries"),
            "{}",
            result.issues[0]
        );
    }

    #[tokio::test]
    async fn folders_below_the_depth_limit_are_reported_as_incomplete() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let at_limit = (1..=10)
            .map(|level| format!("d{level}"))
            .collect::<Vec<_>>();
        skill(
            home.path(),
            &format!(".agents/skills/{}", at_limit.join("/")),
        );
        skill(
            home.path(),
            &format!(".agents/skills/{}/too-deep", at_limit.join("/")),
        );
        skill(home.path(), ".claude/skills/later");
        let result =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        assert_eq!(names(&result), ["d10", "later"]);
        assert_eq!(result.issues.len(), 1, "{:?}", result.issues);
        assert!(
            result.issues[0]
                .starts_with("Skill list is incomplete: skipped folders deeper than 10"),
            "{}",
            result.issues[0]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlinked_root_is_walked_once_and_keeps_the_first_roots_scope() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        skill(home.path(), ".claude/skills/linked");
        files(&home.path().join(".claude/skills/bulk"), 6_000);
        std::fs::create_dir_all(home.path().join(".agents")).unwrap();
        std::os::unix::fs::symlink(
            home.path().join(".claude/skills"),
            home.path().join(".agents/skills"),
        )
        .unwrap();
        skill(project.path(), ".cursor/skills/own");
        // Walked twice, the 6,000 files would be charged twice and pass the budget.
        let result =
            discover_workspace_capabilities_with_home(project.path(), Some(home.path())).await;
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(names(&result), ["own", "linked"]);
        assert_eq!(result.skills[1]["scope"], "user");
        assert!(
            result.skills[1]["path"]
                .as_str()
                .unwrap()
                .contains(".agents")
        );
    }
}
