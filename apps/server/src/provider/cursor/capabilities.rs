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
    discover_workspace_capabilities_with_home(workspace, dirs::home_dir().as_deref()).await
}

pub async fn discover_workspace_capabilities_with_environment(
    workspace: &Path,
    environment: &[(OsString, OsString)],
) -> CursorWorkspaceCapabilities {
    let home = configured_home(environment).or_else(dirs::home_dir);
    discover_workspace_capabilities_with_home(workspace, home.as_deref()).await
}

async fn discover_workspace_capabilities_with_home(
    workspace: &Path,
    home: Option<&Path>,
) -> CursorWorkspaceCapabilities {
    let mut capabilities = CursorWorkspaceCapabilities::default();

    let command_roots = scoped_roots(workspace, home, ".cursor/commands");
    let mut command_names = HashSet::new();
    for (root, _scope) in command_roots {
        for (name, _path) in markdown_files(&root).await {
            if command_names.insert(name.to_ascii_lowercase()) {
                capabilities.slash_commands.push(json!({ "name": name }));
            }
        }
    }

    let mut skill_names = HashSet::new();
    for (root, scope) in skill_roots(workspace, home).await {
        for (name, path) in skill_files(&root, &mut capabilities.issues).await {
            if skill_names.insert(name.to_ascii_lowercase()) {
                capabilities.skills.push(json!({
                    "name": name,
                    "path": path,
                    "scope": scope,
                    "enabled": true,
                    "invocation": "slash",
                }));
            }
        }
    }

    let mut agent_names = HashSet::new();
    for (root, _scope) in agent_roots(workspace, home) {
        for (name, _path) in markdown_files(&root).await {
            if agent_names.insert(name.to_ascii_lowercase()) {
                capabilities.agents.push(json!({ "name": name }));
            }
        }
    }

    capabilities
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

async fn skill_files(directory: &Path, issues: &mut Vec<String>) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut pending = vec![directory.to_path_buf()];
    let mut visited = HashSet::new();
    while let Some(folder) = pending.pop() {
        let canonical = match fs::canonicalize(&folder).await {
            Ok(path) => path,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound
                    || folder != directory
                    || fs::symlink_metadata(&folder).await.is_ok()
                {
                    issues.push(format!(
                        "Cannot read skills in {}: {error}",
                        folder.display()
                    ));
                }
                continue;
            }
        };
        if !visited.insert(canonical) {
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
                {
                    files.push((name.to_owned(), path.to_string_lossy().into_owned()));
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                issues.push(format!("Cannot read {}: {error}", path.display()));
            }
            _ => {}
        }
        let mut entries = match fs::read_dir(&folder).await {
            Ok(entries) => entries,
            Err(error) => {
                issues.push(format!(
                    "Cannot read skills in {}: {error}",
                    folder.display()
                ));
                continue;
            }
        };
        let mut children = Vec::new();
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => match fs::metadata(entry.path()).await {
                    Ok(metadata) if metadata.is_dir() => children.push(entry.path()),
                    Err(error) => {
                        issues.push(format!("Cannot read {}: {error}", entry.path().display()))
                    }
                    _ => {}
                },
                Ok(None) => break,
                Err(error) => {
                    issues.push(format!(
                        "Incomplete skills in {}: {error}",
                        folder.display()
                    ));
                    break;
                }
            }
        }
        children.sort();
        pending.extend(children.into_iter().rev());
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
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
}
