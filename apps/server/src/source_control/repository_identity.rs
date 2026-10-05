//! Cross-machine repository identity derived from a checkout's `origin` remote.

use serde_json::{Value, json};

use super::{ProviderKind, provider_from_remote, remote_host, remote_repository_path};

/// The identity of the repository behind `remote_url`, or `None` for a local
/// path or a remote without a host and repository path.
#[must_use]
pub fn repository_identity(remote_url: &str, root_path: &str) -> Option<Value> {
    let remote_url = remote_url.trim();
    let host = remote_host(remote_url)?;
    let path = remote_repository_path(remote_url)?;
    let (owner, name) = match path.rsplit_once('/') {
        Some((owner, name)) => (Some(owner), name),
        None => (None, path.as_str()),
    };
    let mut identity = json!({
        "canonicalKey": format!("{host}/{path}"),
        "locator": {
            "source": "git-remote",
            "remoteName": "origin",
            "remoteUrl": without_credentials(remote_url),
        },
        "rootPath": root_path,
        "displayName": name,
        "name": name,
    });
    if let Some(owner) = owner {
        identity["owner"] = json!(owner);
    }
    let provider = provider_from_remote(remote_url).kind;
    if provider != ProviderKind::Unknown {
        identity["provider"] = json!(provider);
    }
    Some(identity)
}

/// The remote without the userinfo of a `scheme://` URL, which can carry an access token as the
/// username or a password. The identity is persisted and sent to every client, so it must never
/// hold one. scp-style `user@host:path` remotes carry no secret and stay as written.
fn without_credentials(remote_url: &str) -> String {
    let Some((scheme, rest)) = remote_url.split_once("://") else {
        return remote_url.to_owned();
    };
    // The authority ends at the first of these, exactly as the URL parser finds it.
    let authority_end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    format!("{scheme}://{host}{tail}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::repository_identity;

    #[test]
    fn equivalent_remote_forms_share_one_canonical_key() {
        for remote in [
            "git@gitlab.internal.pathfinder.app:tripunkt/pathfinder-application-server.git",
            "https://gitlab.internal.pathfinder.app/tripunkt/pathfinder-application-server.git",
            "ssh://git@GitLab.Internal.Pathfinder.App:2222/tripunkt/pathfinder-application-server",
            "https://user@gitlab.internal.pathfinder.app:8443/tripunkt/pathfinder-application-server.git/",
        ] {
            let identity = repository_identity(remote, "/work/repo").expect(remote);
            assert_eq!(
                identity["canonicalKey"],
                "gitlab.internal.pathfinder.app/tripunkt/pathfinder-application-server",
                "{remote}"
            );
            assert_eq!(identity["name"], "pathfinder-application-server");
            assert_eq!(identity["displayName"], "pathfinder-application-server");
            assert_eq!(identity["owner"], "tripunkt");
            assert_eq!(identity["provider"], "gitlab");
            assert_eq!(identity["rootPath"], "/work/repo");
            assert_eq!(identity["locator"]["source"], "git-remote");
            assert_eq!(identity["locator"]["remoteName"], "origin");
            assert_eq!(identity["locator"]["remoteUrl"], without_userinfo(remote));
        }
    }

    fn without_userinfo(remote: &str) -> String {
        remote
            .replacen("ssh://git@", "ssh://", 1)
            .replacen("https://user@", "https://", 1)
    }

    #[test]
    fn credentials_never_reach_the_stored_remote_url() {
        for (remote, stored) in [
            (
                "https://oauth2:glpat-secret@gitlab.example/g/r.git",
                "https://gitlab.example/g/r.git",
            ),
            (
                "https://ghp_secret@github.com/o/r.git",
                "https://github.com/o/r.git",
            ),
            (
                "https://user:p%40ss@host:8443/o/r.git?x=1#f",
                "https://host:8443/o/r.git?x=1#f",
            ),
            ("https://host/o/r@v1.git", "https://host/o/r@v1.git"),
            ("ssh://git@host:2222/o/r.git", "ssh://host:2222/o/r.git"),
            ("git@github.com:o/r.git", "git@github.com:o/r.git"),
            ("https://github.com/o/r.git", "https://github.com/o/r.git"),
        ] {
            let identity = repository_identity(remote, "/r").expect(remote);
            assert_eq!(identity["locator"]["remoteUrl"], stored, "{remote}");
            assert!(!identity.to_string().contains("secret"), "{remote}");
            assert!(!identity.to_string().contains("p%40ss"), "{remote}");
        }
    }

    #[test]
    fn nested_groups_and_path_case_are_kept() {
        let identity = repository_identity("git@github.com:Acme/Team/Repo.git", "C:/repo").unwrap();
        assert_eq!(identity["canonicalKey"], "github.com/Acme/Team/Repo");
        assert_eq!(identity["owner"], "Acme/Team");
        assert_eq!(identity["name"], "Repo");
        assert_eq!(identity["provider"], "github");
    }

    #[test]
    fn single_segment_paths_and_unknown_hosts_omit_owner_and_provider() {
        let identity = repository_identity("https://git.example.org/tools.git", "/r").unwrap();
        assert_eq!(identity["canonicalKey"], "git.example.org/tools");
        assert!(identity.get("owner").is_none());
        assert!(identity.get("provider").is_none());
    }

    #[test]
    fn local_and_hostless_remotes_have_no_identity() {
        for remote in [
            "/srv/git/repo.git",
            "C:/work/repo",
            "./relative",
            "https://host/",
            "",
        ] {
            assert_eq!(repository_identity(remote, "/r"), None, "{remote}");
        }
        for remote in ["git@[fe80::1]:a/b.git", "ssh://git@[fe80::1]:22/a/b.git"] {
            assert_eq!(
                repository_identity(remote, "/r").unwrap()["canonicalKey"],
                json!("fe80::1/a/b"),
                "{remote}"
            );
        }
        assert_ne!(
            repository_identity("ssh://git@[2001:db8::1]/a/b.git", "/r"),
            repository_identity("ssh://git@[2001:db8::2]/a/b.git", "/r")
        );
    }
}
