use std::path::Path;

use super::{
    ProviderMaintenanceTarget,
    latest::{LatestVersionSource, VersionScheme},
};

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
        let executable = executable.into();
        let args = args.into_iter().map(Into::into).collect::<Vec<String>>();
        let display = std::iter::once(executable.as_str())
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        Self {
            latest: Some(latest),
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

    #[allow(dead_code)] // Reserved for safe manual commands that are intentionally non-executable.
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
    match target.driver.as_str() {
        "cursor" => ProviderMaintenanceCapabilities::executable(
            LatestVersionSource::CursorInstaller,
            VersionScheme::CursorRelease,
            resolved_or_configured_binary(target, resolved),
            ["update"],
            "cursor-agent",
        ),
        "grok" => ProviderMaintenanceCapabilities::unknown(),
        _ => resolve_package_managed_capabilities(target, resolved, canonical),
    }
}

fn resolve_package_managed_capabilities(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
    canonical: Option<&Path>,
) -> ProviderMaintenanceCapabilities {
    let Some(definition) = package_definition(&target.driver) else {
        return ProviderMaintenanceCapabilities::unknown();
    };
    let resolved_path = resolved.map(normalized_path);
    let canonical_path = canonical.map(normalized_path);
    let paths = [resolved_path.as_deref(), canonical_path.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    if let Some(native) = definition.native_update
        && paths.iter().any(|path| (native.path_matches)(path))
    {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            resolved_or_configured_binary(target, resolved),
            native.args.iter().copied(),
            native.lock_key,
        );
    }
    if target.driver == "codex"
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
            resolved_or_configured_binary(target, resolved),
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
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            "vp",
            ["i", "-g", definition.package_name],
            "vite-plus",
        );
    }
    if paths.iter().any(|path| path.contains("/.bun/bin/")) {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            "bun",
            ["i", "-g", &format!("{}@latest", definition.package_name)],
            "bun",
        );
    }
    if paths.iter().any(|path| {
        path.contains("/.local/share/pnpm/")
            || path.contains("/local/share/pnpm/")
            || path.contains("/library/pnpm/")
            || path.contains("/appdata/local/pnpm/")
            || path.contains("/appdata/roaming/pnpm/")
    }) {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            "pnpm",
            ["add", "-g", &format!("{}@latest", definition.package_name)],
            "pnpm",
        );
    }
    if paths.iter().any(|path| {
        path.contains("/appdata/roaming/npm/")
            || path.contains("/.npm-global/")
            || path.contains("/lib/node_modules/")
            || path.contains("/node_modules/.bin/")
            || path.contains("/npm/node_modules/")
    }) {
        return ProviderMaintenanceCapabilities::executable(
            definition.latest,
            VersionScheme::Semver,
            "npm",
            [
                "install",
                "-g",
                &format!("{}@latest", definition.package_name),
            ],
            "npm",
        );
    }
    ProviderMaintenanceCapabilities::unknown()
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

fn resolved_or_configured_binary(
    target: &ProviderMaintenanceTarget,
    resolved: Option<&Path>,
) -> String {
    resolved
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| target.binary_path.clone())
}

fn is_homebrew_path(path: &str) -> bool {
    path.contains("/cellar/") || path.contains("/caskroom/")
}

fn is_claude_native_path(path: &str) -> bool {
    path.ends_with("/.local/bin/claude") || path.ends_with("/.local/bin/claude.exe")
}

fn is_opencode_native_path(path: &str) -> bool {
    path.ends_with("/.opencode/bin/opencode") || path.ends_with("/.opencode/bin/opencode.exe")
}
