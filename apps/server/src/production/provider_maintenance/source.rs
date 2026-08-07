use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use tokio::io::{AsyncRead, AsyncReadExt};

use super::{
    ProviderMaintenanceTarget,
    latest::{ClaudeReleaseChannel, LatestVersionSource, VersionScheme},
};

const CLAUDE_LOCAL_FILE_LIMIT: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LinuxPackageManager {
    Apt,
    Dnf,
    Apk,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClaudeSourceHints {
    channel: Option<ClaudeReleaseChannel>,
    updates_disabled: bool,
    linux_package: Option<LinuxPackageManager>,
    invalid_managed_channel: bool,
}

impl Default for ClaudeSourceHints {
    fn default() -> Self {
        Self {
            channel: Some(ClaudeReleaseChannel::Stable),
            updates_disabled: false,
            linux_package: None,
            invalid_managed_channel: false,
        }
    }
}

fn claude_hints_from_documents<'a>(
    user: Option<&'a [u8]>,
    managed: impl IntoIterator<Item = &'a [u8]>,
) -> ClaudeSourceHints {
    let mut hints = ClaudeSourceHints::default();
    if let Some(document) = user
        && let Ok(document) = serde_json::from_slice::<serde_json::Value>(document)
    {
        merge_claude_document(&mut hints, &document, false);
    }
    for document in managed {
        if let Ok(document) = serde_json::from_slice::<serde_json::Value>(document) {
            merge_claude_document(&mut hints, &document, true);
        }
    }
    hints
}

fn merge_claude_document(
    hints: &mut ClaudeSourceHints,
    document: &serde_json::Value,
    managed: bool,
) {
    if let Some(value) = document.get("autoUpdatesChannel")
        && !value.is_array()
        && !value.is_object()
        && !value.is_null()
    {
        match value.as_str() {
            Some("stable") => {
                hints.channel = Some(ClaudeReleaseChannel::Stable);
                if managed {
                    hints.invalid_managed_channel = false;
                }
            }
            Some("latest") => {
                hints.channel = Some(ClaudeReleaseChannel::Latest);
                if managed {
                    hints.invalid_managed_channel = false;
                }
            }
            _ if managed => {
                hints.channel = None;
                hints.invalid_managed_channel = true;
            }
            _ => {}
        }
    }
    if let Some(value) = document
        .get("env")
        .and_then(|environment| environment.get("DISABLE_UPDATES"))
        .filter(|value| !value.is_array() && !value.is_object() && !value.is_null())
    {
        hints.updates_disabled = value.as_str() == Some("1");
    }
}

fn parse_claude_repository_marker(
    document: &str,
) -> Option<(LinuxPackageManager, ClaudeReleaseChannel)> {
    let mut marker = None;
    for token in document
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default())
        .flat_map(str::split_whitespace)
    {
        let token = token
            .strip_prefix("baseurl=")
            .unwrap_or(token)
            .trim_matches(['\'', '"']);
        let candidate = match token {
            "https://downloads.claude.ai/claude-code/apt/stable" => {
                Some((LinuxPackageManager::Apt, ClaudeReleaseChannel::Stable))
            }
            "https://downloads.claude.ai/claude-code/apt/latest" => {
                Some((LinuxPackageManager::Apt, ClaudeReleaseChannel::Latest))
            }
            "https://downloads.claude.ai/claude-code/rpm/stable" => {
                Some((LinuxPackageManager::Dnf, ClaudeReleaseChannel::Stable))
            }
            "https://downloads.claude.ai/claude-code/rpm/latest" => {
                Some((LinuxPackageManager::Dnf, ClaudeReleaseChannel::Latest))
            }
            "https://downloads.claude.ai/claude-code/apk/stable" => {
                Some((LinuxPackageManager::Apk, ClaudeReleaseChannel::Stable))
            }
            "https://downloads.claude.ai/claude-code/apk/latest" => {
                Some((LinuxPackageManager::Apk, ClaudeReleaseChannel::Latest))
            }
            _ => None,
        };
        if let Some(candidate) = candidate {
            match marker {
                Some(previous) if previous != candidate => return None,
                Some(_) => {}
                None => marker = Some(candidate),
            }
        }
    }
    marker
}

pub(crate) async fn discover_claude_hints(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
) -> ClaudeSourceHints {
    let managed_settings = claude_managed_settings_path(target);
    let managed_directory = managed_settings
        .as_deref()
        .map(|path| path.with_file_name("managed-settings.d"));
    let repository_paths = [
        PathBuf::from("/etc/apt/sources.list.d/claude-code.list"),
        PathBuf::from("/etc/yum.repos.d/claude-code.repo"),
        PathBuf::from("/etc/apk/repositories"),
    ];
    discover_claude_hints_from_paths(
        target,
        resolved,
        managed_settings.as_deref(),
        managed_directory.as_deref(),
        &repository_paths,
    )
    .await
}

async fn discover_claude_hints_from_paths(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
    managed_settings: Option<&Path>,
    managed_directory: Option<&Path>,
    repository_paths: &[PathBuf],
) -> ClaudeSourceHints {
    let user_settings = claude_config_directory(target).map(|path| path.join("settings.json"));
    let user_document = match user_settings.as_deref() {
        Some(path) => read_bounded_local_file(path).await,
        None => None,
    };
    let mut managed_documents = Vec::new();
    if let Some(path) = managed_settings
        && let Some(document) = read_bounded_local_file(path).await
    {
        managed_documents.push(document);
    }
    if let Some(directory) = managed_directory {
        let mut paths = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(directory).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.extension() == Some(OsStr::new("json")) {
                    paths.push(path);
                }
            }
        }
        paths.sort();
        for path in paths {
            if let Some(document) = read_bounded_local_file(&path).await {
                managed_documents.push(document);
            }
        }
    }
    let mut hints = claude_hints_from_documents(
        user_document.as_deref(),
        managed_documents.iter().map(Vec::as_slice),
    );
    hints.updates_disabled = effective_environment_value(target, "DISABLE_UPDATES")
        .as_deref()
        .is_some_and(|value| value == OsStr::new("1"))
        || hints.updates_disabled;

    if resolved.map(normalized_path).as_deref() == Some("/usr/bin/claude") {
        let mut repository_documents = String::new();
        for path in repository_paths {
            if let Some(document) = read_bounded_local_file(path).await
                && let Ok(document) = std::str::from_utf8(&document)
            {
                repository_documents.push_str(document);
                repository_documents.push('\n');
            }
        }
        if let Some((manager, channel)) = parse_claude_repository_marker(&repository_documents) {
            hints.linux_package = Some(manager);
            hints.channel = Some(channel);
        } else {
            hints.linux_package = None;
            hints.channel = None;
        }
    }
    hints
}

async fn read_bounded_local_file(path: &Path) -> Option<Vec<u8>> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    let regular_file = metadata.is_file();
    if regular_file && metadata.len() > CLAUDE_LOCAL_FILE_LIMIT {
        return None;
    }
    let bytes = read_bounded_local_reader(&mut file).await?;
    if regular_file && file.metadata().await.ok()?.len() > CLAUDE_LOCAL_FILE_LIMIT {
        return None;
    }
    Some(bytes)
}

async fn read_bounded_local_reader(reader: impl AsyncRead + Unpin) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(CLAUDE_LOCAL_FILE_LIMIT)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    Some(bytes)
}

fn claude_config_directory(target: &ProviderMaintenanceTarget) -> Option<PathBuf> {
    effective_environment_value(target, "CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            effective_environment_value(target, "HOME")
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .or_else(|| {
            effective_environment_value(target, "USERPROFILE")
                .map(|home| PathBuf::from(home).join(".claude"))
        })
}

fn effective_environment_value(target: &ProviderMaintenanceTarget, name: &str) -> Option<OsString> {
    target
        .environment
        .iter()
        .find(|(candidate, _)| candidate.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os(name))
}

fn claude_managed_settings_path(target: &ProviderMaintenanceTarget) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let _ = target;
        Some(PathBuf::from(
            "/Library/Application Support/ClaudeCode/managed-settings.json",
        ))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = target;
        Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
    }
    #[cfg(windows)]
    {
        effective_environment_value(target, "ProgramFiles")
            .map(|directory| PathBuf::from(directory).join("ClaudeCode/managed-settings.json"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderUpdateCommand {
    pub(crate) display: String,
    pub(crate) executable: String,
    pub(crate) args: Vec<String>,
    pub(crate) lock_key: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderMaintenanceCapabilities {
    pub(crate) latest: Option<LatestVersionSource>,
    pub(crate) version_scheme: VersionScheme,
    pub(crate) display_command: Option<String>,
    pub(crate) update: Option<ProviderUpdateCommand>,
}

impl ProviderMaintenanceCapabilities {
    pub(crate) fn unknown() -> Self {
        Self {
            latest: None,
            version_scheme: VersionScheme::Semver,
            display_command: None,
            update: None,
        }
    }

    fn executable<I, S>(
        latest: LatestVersionSource,
        version_scheme: VersionScheme,
        executable: impl Into<String>,
        args: I,
        lock_key: &'static str,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::executable_with_optional_latest(
            Some(latest),
            version_scheme,
            executable,
            args,
            lock_key,
        )
    }

    fn executable_with_optional_latest<I, S>(
        latest: Option<LatestVersionSource>,
        version_scheme: VersionScheme,
        executable: impl Into<String>,
        args: I,
        lock_key: &'static str,
    ) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let executable = executable.into();
        let args = args.into_iter().map(Into::into).collect::<Vec<String>>();
        let display = std::iter::once(executable.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        Self {
            latest,
            version_scheme,
            display_command: Some(display.clone()),
            update: Some(ProviderUpdateCommand {
                display,
                executable,
                args,
                lock_key,
            }),
        }
    }

    fn display_only(
        latest: LatestVersionSource,
        version_scheme: VersionScheme,
        display_command: impl Into<String>,
    ) -> Self {
        Self {
            latest: Some(latest),
            version_scheme,
            display_command: Some(display_command.into()),
            update: None,
        }
    }
}

#[derive(Clone, Copy)]
struct NativeUpdate {
    args: &'static [&'static str],
    lock_key: &'static str,
    path_matches: fn(&str) -> bool,
}

#[derive(Clone, Copy)]
struct PackageDefinition {
    latest: LatestVersionSource,
    package_name: &'static str,
    homebrew_args: &'static [&'static str],
    native_update: Option<NativeUpdate>,
}

pub(crate) fn capabilities_for_paths(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
) -> ProviderMaintenanceCapabilities {
    capabilities_for_paths_with_claude_hints(
        &target.driver,
        &target.binary_path,
        resolved,
        canonical,
        &ClaudeSourceHints::default(),
    )
}

pub(crate) fn capabilities_for_paths_with_claude_hints(
    driver: &str,
    binary_path: &str,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
    claude_hints: &ClaudeSourceHints,
) -> ProviderMaintenanceCapabilities {
    match driver {
        "cursor" => cursor_capabilities(binary_path, resolved, canonical),
        "grok" => ProviderMaintenanceCapabilities::unknown(),
        _ => resolve_package_managed_capabilities(
            driver,
            binary_path,
            resolved,
            canonical,
            claude_hints,
        ),
    }
}

fn cursor_capabilities(
    binary_path: &str,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
) -> ProviderMaintenanceCapabilities {
    let Some(canonical_path) = canonical.map(normalized_path) else {
        return ProviderMaintenanceCapabilities::unknown();
    };
    if !is_cursor_release_binary_path(&canonical_path) {
        return ProviderMaintenanceCapabilities::unknown();
    }
    let Some(resolved_path) = resolved.map(normalized_path) else {
        return ProviderMaintenanceCapabilities::unknown();
    };
    if !is_cursor_release_binary_path(&resolved_path) && !is_cursor_launch_link_path(&resolved_path)
    {
        return ProviderMaintenanceCapabilities::unknown();
    }
    ProviderMaintenanceCapabilities::executable(
        LatestVersionSource::CursorInstaller,
        VersionScheme::CursorRelease,
        resolved_or_configured_binary(binary_path, resolved),
        ["update"],
        "cursor-agent",
    )
}

fn resolve_package_managed_capabilities(
    driver: &str,
    binary_path: &str,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
    claude_hints: &ClaudeSourceHints,
) -> ProviderMaintenanceCapabilities {
    let Some(definition) = package_definition(driver) else {
        return ProviderMaintenanceCapabilities::unknown();
    };
    let resolved_path = resolved.map(normalized_path);
    let canonical_path = canonical.map(normalized_path);
    let paths = [resolved_path.as_deref(), canonical_path.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    if driver == "claudeAgent"
        && let Some(capabilities) = claude_source_capabilities(
            resolved_path.as_deref(),
            canonical_path.as_deref(),
            claude_hints,
        )
    {
        return capabilities;
    }

    if let Some(native) = definition.native_update
        && paths.iter().any(|path| (native.path_matches)(path))
        && !(driver == "claudeAgent"
            && canonical_path
                .as_deref()
                .is_some_and(is_script_package_manager_path))
    {
        let latest = if driver == "claudeAgent" {
            (!claude_hints.invalid_managed_channel)
                .then_some(claude_hints.channel)
                .flatten()
                .map(LatestVersionSource::Claude)
        } else {
            Some(definition.latest)
        };
        let mut capabilities = ProviderMaintenanceCapabilities::executable_with_optional_latest(
            latest,
            VersionScheme::Semver,
            resolved_or_configured_binary(binary_path, resolved),
            native.args.iter().copied(),
            native.lock_key,
        );
        if driver == "claudeAgent" && claude_hints.updates_disabled {
            capabilities.update = None;
        }
        return capabilities;
    }
    if driver == "codex"
        && (canonical_path
            .as_deref()
            .is_some_and(|path| path.contains("/.codex/packages/standalone/"))
            || resolved_path
                .as_deref()
                .is_some_and(|path| path.contains("/appdata/local/programs/openai/codex/bin/")))
    {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            resolved_or_configured_binary(binary_path, resolved),
            ["update"],
            "codex-standalone",
        );
    }
    if canonical_path.as_deref().is_some_and(is_homebrew_path) {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            "brew",
            definition.homebrew_args.iter().copied(),
            "homebrew",
        );
    }
    if paths.iter().any(|path| path.contains("/.vite-plus/bin/")) {
        return maybe_disable_claude_update(
            ProviderMaintenanceCapabilities::executable(
                definition.latest,
                VersionScheme::Semver,
                "vp",
                ["i", "-g", definition.package_name],
                "vite-plus",
            ),
            driver,
            claude_hints,
        );
    }
    if paths.iter().any(|path| path.contains("/.bun/bin/")) {
        return maybe_disable_claude_update(
            ProviderMaintenanceCapabilities::executable(
                definition.latest,
                VersionScheme::Semver,
                "bun",
                ["i", "-g", &format!("{}@latest", definition.package_name)],
                "bun",
            ),
            driver,
            claude_hints,
        );
    }
    if paths.iter().any(|path| {
        path.contains("/.local/share/pnpm/")
            || path.contains("/local/share/pnpm/")
            || path.contains("/library/pnpm/")
            || path.contains("/appdata/local/pnpm/")
            || path.contains("/appdata/roaming/pnpm/")
    }) {
        return maybe_disable_claude_update(
            ProviderMaintenanceCapabilities::executable(
                definition.latest,
                VersionScheme::Semver,
                "pnpm",
                ["add", "-g", &format!("{}@latest", definition.package_name)],
                "pnpm",
            ),
            driver,
            claude_hints,
        );
    }
    if paths.iter().any(|path| {
        path.contains("/appdata/roaming/npm/")
            || path.contains("/.npm-global/")
            || path.contains("/lib/node_modules/")
            || path.contains("/node_modules/.bin/")
            || path.contains("/npm/node_modules/")
    }) {
        return maybe_disable_claude_update(
            ProviderMaintenanceCapabilities::executable(
                definition.latest,
                VersionScheme::Semver,
                "npm",
                [
                    "install",
                    "-g",
                    &format!("{}@latest", definition.package_name),
                ],
                "npm",
            ),
            driver,
            claude_hints,
        );
    }
    ProviderMaintenanceCapabilities::unknown()
}

fn maybe_disable_claude_update(
    mut capabilities: ProviderMaintenanceCapabilities,
    driver: &str,
    hints: &ClaudeSourceHints,
) -> ProviderMaintenanceCapabilities {
    if driver == "claudeAgent" && hints.updates_disabled {
        capabilities.update = None;
    }
    capabilities
}

fn claude_source_capabilities(
    resolved_path: Option<&str>,
    canonical_path: Option<&str>,
    hints: &ClaudeSourceHints,
) -> Option<ProviderMaintenanceCapabilities> {
    let mut capabilities = if canonical_path.is_some_and(is_claude_latest_cask_path) {
        ProviderMaintenanceCapabilities::executable(
            LatestVersionSource::Claude(ClaudeReleaseChannel::Latest),
            VersionScheme::Semver,
            "brew",
            ["upgrade", "--cask", "claude-code@latest"],
            "homebrew",
        )
    } else if canonical_path.is_some_and(is_claude_stable_cask_path) {
        ProviderMaintenanceCapabilities::executable(
            LatestVersionSource::Claude(ClaudeReleaseChannel::Stable),
            VersionScheme::Semver,
            "brew",
            ["upgrade", "--cask", "claude-code"],
            "homebrew",
        )
    } else if canonical_path.is_some_and(is_homebrew_path) {
        ProviderMaintenanceCapabilities::unknown()
    } else if [resolved_path, canonical_path]
        .into_iter()
        .flatten()
        .any(is_claude_winget_path)
    {
        ProviderMaintenanceCapabilities::executable(
            LatestVersionSource::Claude(ClaudeReleaseChannel::Latest),
            VersionScheme::Semver,
            "winget",
            ["upgrade", "Anthropic.ClaudeCode"],
            "winget",
        )
    } else if resolved_path == Some("/usr/bin/claude") {
        match (hints.linux_package, hints.channel) {
            (Some(LinuxPackageManager::Apt), Some(channel)) => {
                ProviderMaintenanceCapabilities::display_only(
                    LatestVersionSource::Claude(channel),
                    VersionScheme::Semver,
                    "sudo apt update && sudo apt upgrade claude-code",
                )
            }
            (Some(LinuxPackageManager::Dnf), Some(channel)) => {
                ProviderMaintenanceCapabilities::display_only(
                    LatestVersionSource::Claude(channel),
                    VersionScheme::Semver,
                    "sudo dnf upgrade claude-code",
                )
            }
            (Some(LinuxPackageManager::Apk), Some(channel)) => {
                ProviderMaintenanceCapabilities::display_only(
                    LatestVersionSource::Claude(channel),
                    VersionScheme::Semver,
                    "apk update && apk upgrade claude-code",
                )
            }
            _ => ProviderMaintenanceCapabilities::unknown(),
        }
    } else {
        return None;
    };
    if hints.updates_disabled {
        capabilities.update = None;
    }
    Some(capabilities)
}

fn package_definition(driver: &str) -> Option<PackageDefinition> {
    match driver {
        "codex" => Some(PackageDefinition {
            latest: LatestVersionSource::Npm("@openai/codex"),
            package_name: "@openai/codex",
            homebrew_args: &["upgrade", "--cask", "codex"],
            native_update: None,
        }),
        "claudeAgent" => Some(PackageDefinition {
            latest: LatestVersionSource::Npm("@anthropic-ai/claude-code"),
            package_name: "@anthropic-ai/claude-code",
            homebrew_args: &["upgrade", "claude-code"],
            native_update: Some(NativeUpdate {
                args: &["update"],
                lock_key: "claude-native",
                path_matches: is_claude_native_path,
            }),
        }),
        "opencode" => Some(PackageDefinition {
            latest: LatestVersionSource::Npm("opencode-ai"),
            package_name: "opencode-ai",
            homebrew_args: &["upgrade", "anomalyco/tap/opencode"],
            native_update: Some(NativeUpdate {
                args: &["upgrade"],
                lock_key: "opencode-native",
                path_matches: is_opencode_native_path,
            }),
        }),
        _ => None,
    }
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn resolved_or_configured_binary(binary_path: &str, resolved: Option<&Path>) -> String {
    resolved
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary_path.to_owned())
}

fn is_homebrew_path(path: &str) -> bool {
    path.contains("/cellar/") || path.contains("/caskroom/")
}

fn is_claude_stable_cask_path(path: &str) -> bool {
    path.contains("/caskroom/claude-code/")
}

fn is_claude_latest_cask_path(path: &str) -> bool {
    path.contains("/caskroom/claude-code@latest/")
}

fn is_claude_winget_path(path: &str) -> bool {
    path.ends_with("/appdata/local/microsoft/winget/links/claude.exe")
        || (path.contains("/appdata/local/microsoft/winget/packages/anthropic.claudecode_")
            && path.ends_with("/claude.exe"))
}

fn is_script_package_manager_path(path: &str) -> bool {
    path.contains("/.vite-plus/bin/")
        || path.contains("/.bun/bin/")
        || path.contains("/.local/share/pnpm/")
        || path.contains("/local/share/pnpm/")
        || path.contains("/library/pnpm/")
        || path.contains("/appdata/local/pnpm/")
        || path.contains("/appdata/roaming/pnpm/")
        || path.contains("/appdata/roaming/npm/")
        || path.contains("/.npm-global/")
        || path.contains("/lib/node_modules/")
        || path.contains("/node_modules/.bin/")
        || path.contains("/npm/node_modules/")
}

fn is_claude_native_path(path: &str) -> bool {
    path.ends_with("/.local/bin/claude") || path.ends_with("/.local/bin/claude.exe")
}

fn is_opencode_native_path(path: &str) -> bool {
    path.ends_with("/.opencode/bin/opencode") || path.ends_with("/.opencode/bin/opencode.exe")
}

fn is_cursor_release_binary_path(path: &str) -> bool {
    path.contains("/.local/share/cursor-agent/versions/")
        && (path.ends_with("/cursor-agent") || path.ends_with("/cursor-agent.exe"))
}

fn is_cursor_launch_link_path(path: &str) -> bool {
    path.ends_with("/.local/bin/cursor-agent")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ObservedReader {
        remaining: usize,
        consumed: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl tokio::io::AsyncRead for ObservedReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
            buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let reader = self.get_mut();
            let amount = reader.remaining.min(buffer.remaining());
            buffer.initialize_unfilled()[..amount].fill(b'x');
            buffer.advance(amount);
            reader.remaining -= amount;
            reader
                .consumed
                .fetch_add(amount, std::sync::atomic::Ordering::SeqCst);
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn claude_target(environment: &[(&str, &std::ffi::OsStr)]) -> ProviderMaintenanceTarget {
        ProviderMaintenanceTarget {
            instance_id: "claude".to_owned(),
            driver: "claudeAgent".to_owned(),
            binary_path: "claude".to_owned(),
            environment: environment
                .iter()
                .map(|(name, value)| ((*name).into(), (*value).to_owned()))
                .collect(),
        }
    }

    #[test]
    fn managed_claude_channel_overrides_user_channel() {
        let hints = claude_hints_from_documents(
            Some(br#"{"autoUpdatesChannel":"latest"}"#),
            [br#"{"autoUpdatesChannel":"stable"}"#.as_slice()],
        );
        assert_eq!(hints.channel, Some(ClaudeReleaseChannel::Stable));
    }

    #[test]
    fn later_managed_claude_scalars_override_earlier_values() {
        let hints = claude_hints_from_documents(
            Some(br#"{"autoUpdatesChannel":"latest","env":{"DISABLE_UPDATES":"1"}}"#),
            [
                br#"{"autoUpdatesChannel":"stable","env":{"DISABLE_UPDATES":"1"}}"#.as_slice(),
                br#"{"autoUpdatesChannel":"preview","env":{"DISABLE_UPDATES":"0"}}"#.as_slice(),
            ],
        );
        assert_eq!(hints.channel, None);
        assert!(!hints.updates_disabled);
        assert!(hints.invalid_managed_channel);
    }

    #[tokio::test]
    async fn discovers_sorted_bounded_claude_settings_from_target_environment() {
        let directory = tempfile::tempdir().expect("temp directory");
        let config = directory.path().join("target-claude");
        let managed = directory.path().join("managed-settings.json");
        let managed_directory = directory.path().join("managed-settings.d");
        std::fs::create_dir_all(&config).expect("config directory");
        std::fs::create_dir_all(&managed_directory).expect("managed directory");
        std::fs::write(
            config.join("settings.json"),
            br#"{"autoUpdatesChannel":"latest"}"#,
        )
        .expect("user settings");
        std::fs::write(&managed, br#"{"autoUpdatesChannel":"stable"}"#).expect("managed settings");
        std::fs::write(
            managed_directory.join("01-stable.json"),
            br#"{"autoUpdatesChannel":"stable"}"#,
        )
        .expect("first managed settings");
        std::fs::write(
            managed_directory.join("02-latest.json"),
            br#"{"autoUpdatesChannel":"latest"}"#,
        )
        .expect("last managed settings");
        let target = claude_target(&[
            ("CLAUDE_CONFIG_DIR", config.as_os_str()),
            ("DISABLE_UPDATES", std::ffi::OsStr::new("1")),
            ("DISABLE_AUTOUPDATER", std::ffi::OsStr::new("1")),
        ]);

        let hints = discover_claude_hints_from_paths(
            &target,
            None,
            Some(&managed),
            Some(&managed_directory),
            &[],
        )
        .await;

        assert_eq!(hints.channel, Some(ClaudeReleaseChannel::Latest));
        assert!(hints.updates_disabled);
    }

    #[tokio::test]
    async fn disable_autoupdater_does_not_disable_the_explicit_claude_action() {
        let directory = tempfile::tempdir().expect("temp directory");
        let target = claude_target(&[
            ("CLAUDE_CONFIG_DIR", directory.path().as_os_str()),
            ("DISABLE_UPDATES", std::ffi::OsStr::new("0")),
            ("DISABLE_AUTOUPDATER", std::ffi::OsStr::new("1")),
        ]);
        let hints = discover_claude_hints_from_paths(&target, None, None, None, &[]).await;

        assert!(!hints.updates_disabled);
    }

    #[tokio::test]
    async fn local_claude_documents_are_capped_at_64_kib() {
        let directory = tempfile::tempdir().expect("temp directory");
        let exact = directory.path().join("exact.json");
        let oversized = directory.path().join("oversized.json");
        std::fs::write(&exact, vec![b' '; CLAUDE_LOCAL_FILE_LIMIT as usize])
            .expect("exact document");
        std::fs::write(&oversized, vec![b' '; CLAUDE_LOCAL_FILE_LIMIT as usize + 1])
            .expect("oversized document");

        assert_eq!(
            read_bounded_local_file(&exact)
                .await
                .map(|bytes| bytes.len()),
            Some(CLAUDE_LOCAL_FILE_LIMIT as usize)
        );
        assert!(read_bounded_local_file(&oversized).await.is_none());
    }

    #[tokio::test]
    async fn bounded_claude_reader_never_consumes_a_sentinel_byte() {
        let consumed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let bytes = read_bounded_local_reader(ObservedReader {
            remaining: CLAUDE_LOCAL_FILE_LIMIT as usize + 1,
            consumed: consumed.clone(),
        })
        .await
        .expect("bounded read");

        assert_eq!(bytes.len(), CLAUDE_LOCAL_FILE_LIMIT as usize);
        assert_eq!(
            consumed.load(std::sync::atomic::Ordering::SeqCst),
            CLAUDE_LOCAL_FILE_LIMIT as usize
        );
    }

    #[tokio::test]
    async fn repository_discovery_rejects_conflicting_claude_channels() {
        let directory = tempfile::tempdir().expect("temp directory");
        let config = directory.path().join("claude-config");
        let apt = directory.path().join("claude-code.list");
        let rpm = directory.path().join("claude-code.repo");
        std::fs::create_dir_all(&config).expect("config directory");
        std::fs::write(
            &apt,
            "deb https://downloads.claude.ai/claude-code/apt/stable stable main",
        )
        .expect("apt repository");
        std::fs::write(
            &rpm,
            "baseurl=https://downloads.claude.ai/claude-code/rpm/latest",
        )
        .expect("rpm repository");
        let target = claude_target(&[("CLAUDE_CONFIG_DIR", config.as_os_str())]);
        let repositories = vec![apt.clone(), rpm.clone()];

        let conflicting = discover_claude_hints_from_paths(
            &target,
            Some(Path::new("/usr/bin/claude")),
            None,
            None,
            &repositories,
        )
        .await;
        assert_eq!(conflicting.channel, None);
        assert_eq!(conflicting.linux_package, None);

        std::fs::write(&rpm, "[unrelated]").expect("remove rpm marker");
        let marked = discover_claude_hints_from_paths(
            &target,
            Some(Path::new("/usr/bin/claude")),
            None,
            None,
            &repositories,
        )
        .await;
        assert_eq!(marked.channel, Some(ClaudeReleaseChannel::Stable));
        assert_eq!(marked.linux_package, Some(LinuxPackageManager::Apt));
    }

    #[test]
    fn claude_disable_updates_removes_only_the_executable_action() {
        let hints = ClaudeSourceHints {
            channel: Some(ClaudeReleaseChannel::Latest),
            updates_disabled: true,
            linux_package: None,
            invalid_managed_channel: false,
        };
        let capabilities = capabilities_for_paths_with_claude_hints(
            "claudeAgent",
            "claude",
            Some(Path::new("/home/me/.local/bin/claude")),
            Some(Path::new("/home/me/.local/share/claude/versions/2.1.224")),
            &hints,
        );
        assert_eq!(
            capabilities.latest,
            Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest))
        );
        assert_eq!(
            capabilities.display_command,
            Some("/home/me/.local/bin/claude update".to_owned())
        );
        assert!(capabilities.update.is_none());
    }

    #[test]
    fn claude_disable_updates_also_preserves_package_manager_guidance() {
        let hints = ClaudeSourceHints {
            updates_disabled: true,
            ..ClaudeSourceHints::default()
        };
        let capabilities = capabilities_for_paths_with_claude_hints(
            "claudeAgent",
            "claude",
            Some(Path::new("/usr/local/bin/claude")),
            Some(Path::new(
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            )),
            &hints,
        );
        assert_eq!(
            capabilities.latest,
            Some(LatestVersionSource::Npm("@anthropic-ai/claude-code"))
        );
        assert_eq!(
            capabilities.display_command.as_deref(),
            Some("npm install -g @anthropic-ai/claude-code@latest")
        );
        assert!(capabilities.update.is_none());
    }

    #[test]
    fn parses_claude_linux_repository_channels() {
        assert_eq!(
            parse_claude_repository_marker(
                "deb https://downloads.claude.ai/claude-code/apt/stable stable main"
            ),
            Some((LinuxPackageManager::Apt, ClaudeReleaseChannel::Stable))
        );
        assert_eq!(
            parse_claude_repository_marker(
                "baseurl=https://downloads.claude.ai/claude-code/rpm/latest"
            ),
            Some((LinuxPackageManager::Dnf, ClaudeReleaseChannel::Latest))
        );
        assert_eq!(
            parse_claude_repository_marker(
                "https://downloads.claude.ai/claude-code/apt/stable-spoof"
            ),
            None
        );
    }

    #[test]
    fn resolves_claude_installation_sources() {
        let stable = ClaudeSourceHints::default();
        let latest = ClaudeSourceHints {
            channel: Some(ClaudeReleaseChannel::Latest),
            ..ClaudeSourceHints::default()
        };
        let apt = ClaudeSourceHints {
            channel: Some(ClaudeReleaseChannel::Stable),
            linux_package: Some(LinuxPackageManager::Apt),
            ..ClaudeSourceHints::default()
        };
        let dnf = ClaudeSourceHints {
            channel: Some(ClaudeReleaseChannel::Latest),
            linux_package: Some(LinuxPackageManager::Dnf),
            ..ClaudeSourceHints::default()
        };
        let apk = ClaudeSourceHints {
            channel: Some(ClaudeReleaseChannel::Stable),
            linux_package: Some(LinuxPackageManager::Apk),
            ..ClaudeSourceHints::default()
        };
        let unmarked = ClaudeSourceHints {
            channel: None,
            ..ClaudeSourceHints::default()
        };
        let invalid_managed = ClaudeSourceHints {
            invalid_managed_channel: true,
            ..ClaudeSourceHints::default()
        };
        let cases = [
            (
                "C:/Users/me/.local/bin/claude.exe",
                Some("C:/Users/me/.local/share/claude/versions/2.1.220/claude.exe"),
                &stable,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Stable)),
                Some("C:/Users/me/.local/bin/claude.exe update"),
                Some("claude-native"),
            ),
            (
                "/opt/homebrew/bin/claude",
                Some("/opt/homebrew/Caskroom/claude-code/2.1.220/claude"),
                &stable,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Stable)),
                Some("brew upgrade --cask claude-code"),
                Some("homebrew"),
            ),
            (
                "/opt/homebrew/bin/claude",
                Some("/opt/homebrew/Caskroom/claude-code@latest/2.1.224/claude"),
                &stable,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest)),
                Some("brew upgrade --cask claude-code@latest"),
                Some("homebrew"),
            ),
            (
                "C:/Users/me/AppData/Local/Microsoft/WinGet/Links/claude.exe",
                Some(
                    "C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe",
                ),
                &stable,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest)),
                Some("winget upgrade Anthropic.ClaudeCode"),
                Some("winget"),
            ),
            (
                "C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe",
                None,
                &stable,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest)),
                Some("winget upgrade Anthropic.ClaudeCode"),
                Some("winget"),
            ),
            (
                "/usr/bin/claude",
                Some("/usr/bin/claude"),
                &apt,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Stable)),
                Some("sudo apt update && sudo apt upgrade claude-code"),
                None,
            ),
            (
                "/usr/bin/claude",
                Some("/usr/bin/claude"),
                &dnf,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest)),
                Some("sudo dnf upgrade claude-code"),
                None,
            ),
            (
                "/usr/bin/claude",
                Some("/usr/bin/claude"),
                &apk,
                Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Stable)),
                Some("apk update && apk upgrade claude-code"),
                None,
            ),
            (
                "/usr/bin/claude",
                Some("/usr/bin/claude"),
                &unmarked,
                None,
                None,
                None,
            ),
            (
                "/home/me/.local/bin/claude",
                Some("/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
                &latest,
                Some(LatestVersionSource::Npm("@anthropic-ai/claude-code")),
                Some("npm install -g @anthropic-ai/claude-code@latest"),
                Some("npm"),
            ),
            (
                "/home/me/.local/bin/claude",
                Some("/home/me/.local/share/claude/versions/2.1.220"),
                &invalid_managed,
                None,
                Some("/home/me/.local/bin/claude update"),
                Some("claude-native"),
            ),
        ];

        for (resolved, canonical, hints, expected_latest, expected_display, expected_lock) in cases
        {
            let capabilities = capabilities_for_paths_with_claude_hints(
                "claudeAgent",
                "claude",
                Some(Path::new(resolved)),
                canonical.map(Path::new),
                hints,
            );
            assert_eq!(capabilities.latest, expected_latest, "{resolved}");
            assert_eq!(
                capabilities.display_command.as_deref(),
                expected_display,
                "{resolved}"
            );
            assert_eq!(
                capabilities.update.as_ref().map(|update| update.lock_key),
                expected_lock,
                "{resolved}"
            );
        }
    }

    #[test]
    fn recognizes_only_official_cursor_release_paths() {
        let official = capabilities_for_paths(
            &ProviderMaintenanceTarget {
                instance_id: "cursor".to_owned(),
                driver: "cursor".to_owned(),
                binary_path: "cursor-agent".to_owned(),
                environment: Vec::new(),
            },
            Some(Path::new("/home/me/.local/bin/cursor-agent")),
            Some(Path::new(
                "/home/me/.local/share/cursor-agent/versions/2026.06.19-653a7fb/cursor-agent",
            )),
        );
        assert_eq!(official.latest, Some(LatestVersionSource::CursorInstaller));
        assert_eq!(official.version_scheme, VersionScheme::CursorRelease);
        assert_eq!(
            official.display_command.as_deref(),
            Some("/home/me/.local/bin/cursor-agent update")
        );
        assert!(official.update.is_some());

        let wrapper = capabilities_for_paths(
            &ProviderMaintenanceTarget {
                instance_id: "cursor".to_owned(),
                driver: "cursor".to_owned(),
                binary_path: "cursor-agent".to_owned(),
                environment: Vec::new(),
            },
            Some(Path::new("/srv/tools/cursor-agent")),
            None,
        );
        assert_eq!(wrapper, ProviderMaintenanceCapabilities::unknown());
    }
}
