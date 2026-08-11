use serde_json::{Value, json};

use super::model::{
    SCOPE_ACCESS_READ, SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ, SCOPE_RELAY_WRITE,
    SCOPE_REVIEW_WRITE, SCOPE_TERMINAL_OPERATE,
};

pub(crate) const ACTIVITY_READ_SCOPE: &str = SCOPE_ORCHESTRATION_READ;

#[must_use]
pub(crate) fn required_scope(method: &str) -> Option<&'static str> {
    if matches!(
        method,
        "activity.getSnapshot"
            | "activity.listDetail"
            | "activity.listRoster"
            | "subscribeActivity"
    ) {
        return Some(ACTIVITY_READ_SCOPE);
    }
    match method {
        "assets.createUrl"
        | "filesystem.browse"
        | "orchestration.getArchivedShellSnapshot"
        | "orchestration.getFullThreadDiff"
        | "orchestration.getTurnDiff"
        | "orchestration.replayEvents"
        | "orchestration.subscribeShell"
        | "orchestration.subscribeThread"
        | "preview.list"
        | "projects.listEntries"
        | "projects.readFile"
        | "projects.searchEntries"
        | "server.discoverSourceControl"
        | "server.getConfig"
        | "server.getProcessDiagnostics"
        | "server.getProcessResourceHistory"
        | "server.getProviderUsage"
        | "server.getSettings"
        | "server.getTraceDiagnostics"
        | "sourceControl.lookupRepository"
        | "subscribeDiscoveredLocalServers"
        | "subscribePreviewEvents"
        | "subscribeServerConfig"
        | "subscribeServerLifecycle"
        | "subscribeVcsStatus"
        | "subscribeWorktreeCatalog"
        | "vcs.listCommits"
        | "vcs.listRefs"
        | "vcs.refreshStatus"
        | "vcs.refreshWorktreeCatalog"
        | "worktree.getRemovalPlan" => Some(SCOPE_ORCHESTRATION_READ),
        "git.preparePullRequestThread"
        | "git.resolvePullRequest"
        | "git.runStackedAction"
        | "orchestration.dispatchCommand"
        | "preview.close"
        | "preview.navigate"
        | "preview.open"
        | "preview.refresh"
        | "preview.reportStatus"
        | "preview.resize"
        | "previewAutomation.connect"
        | "previewAutomation.focusHost"
        | "previewAutomation.respond"
        | "projects.createEntry"
        | "projects.deleteEntry"
        | "projects.duplicateEntry"
        | "projects.renameEntry"
        | "projects.writeFile"
        | "server.consumeCodexRateLimitReset"
        | "server.refreshProviders"
        | "server.refreshProviderUsage"
        | "server.removeKeybinding"
        | "server.signalProcess"
        | "server.updateProvider"
        | "server.updateSettings"
        | "server.upsertKeybinding"
        | "shell.openInEditor"
        | "sourceControl.cloneRepository"
        | "sourceControl.publishRepository"
        | "vcs.clone"
        | "vcs.createRef"
        | "vcs.discardFiles"
        | "vcs.generateCommitMessage"
        | "vcs.init"
        | "vcs.pull"
        | "vcs.stageFiles"
        | "vcs.switchRef"
        | "vcs.unstageFiles" => Some(SCOPE_ORCHESTRATION_OPERATE),
        "worktree.adopt"
        | "worktree.createManaged"
        | "worktree.createPanel"
        | "worktree.remove"
        | "worktree.removeFromBibCode"
        | "worktree.retarget"
        | "worktree.updateDiscoveryPolicy" => Some(SCOPE_ORCHESTRATION_OPERATE),
        "terminal.attach"
        | "terminal.clear"
        | "terminal.close"
        | "terminal.open"
        | "terminal.resize"
        | "terminal.restart"
        | "terminal.write"
        | "subscribeTerminalEvents"
        | "subscribeTerminalMetadata" => Some(SCOPE_TERMINAL_OPERATE),
        "review.getDiffPreview" => Some(SCOPE_REVIEW_WRITE),
        "cloud.getRelayClientStatus" | "cloud.installRelayClient" => Some(SCOPE_RELAY_WRITE),
        "subscribeAuthAccess" => Some(SCOPE_ACCESS_READ),
        _ => None,
    }
}

#[must_use]
pub(crate) fn authorization_error(required_scope: &str) -> Value {
    json!({
        "_tag": "EnvironmentAuthorizationError",
        "message": format!(
            "The authenticated token is missing required scope: {required_scope}."
        ),
        "requiredScope": required_scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ACTIVE_RPC_METHODS;

    #[test]
    fn every_active_rpc_method_has_exactly_one_declared_scope() {
        let missing = ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| required_scope(method.name).is_none())
            .map(|method| method.name)
            .collect::<Vec<_>>();

        assert!(missing.is_empty(), "missing RPC scopes: {missing:?}");
        assert_eq!(
            required_scope("server.getConfig"),
            Some(SCOPE_ORCHESTRATION_READ)
        );
        assert_eq!(
            required_scope("server.updateSettings"),
            Some(SCOPE_ORCHESTRATION_OPERATE)
        );
        assert_eq!(
            required_scope("server.consumeCodexRateLimitReset"),
            Some(SCOPE_ORCHESTRATION_OPERATE)
        );
        assert_eq!(
            required_scope("subscribeAuthAccess"),
            Some(SCOPE_ACCESS_READ)
        );
        for method in [
            "activity.getSnapshot",
            "activity.listDetail",
            "activity.listRoster",
            "subscribeActivity",
        ] {
            assert_eq!(
                required_scope(method),
                Some(ACTIVITY_READ_SCOPE),
                "wrong activity RPC scope for {method}"
            );
        }
        for method in [
            "subscribeWorktreeCatalog",
            "vcs.refreshWorktreeCatalog",
            "worktree.getRemovalPlan",
        ] {
            assert_eq!(
                required_scope(method),
                Some(SCOPE_ORCHESTRATION_READ),
                "wrong worktree catalog read scope for {method}"
            );
        }
        assert_eq!(
            required_scope("worktree.updateDiscoveryPolicy"),
            Some(SCOPE_ORCHESTRATION_OPERATE)
        );
        assert_eq!(
            required_scope("worktree.adopt"),
            Some(SCOPE_ORCHESTRATION_OPERATE)
        );
        for method in ["worktree.remove", "worktree.removeFromBibCode"] {
            assert_eq!(required_scope(method), Some(SCOPE_ORCHESTRATION_OPERATE));
        }
        assert_eq!(required_scope("unknown.method"), None);
    }
}
