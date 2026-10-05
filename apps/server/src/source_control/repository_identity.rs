//! Cross-machine repository identity derived from a checkout's `origin` remote.

use serde_json::{Value, json};

use super::{ProviderKind, provider_from_remote, remote_host, remote_repository_path};

/// The identity of the repository behind `remote_url`, or `None` for a local
/// path, a remote without a host and repository path, or a path with an empty
/// segment (`a/.git`, `a//b`), whose name or owner clients would reject.
#[must_use]
pub fn repository_identity(remote_url: &str, root_path: &str) -> Option<Value> {
    let remote_url = remote_url.trim();
    let host = remote_host(remote_url)?;
    let path = remote_repository_path(remote_url)?;
    if path.split('/').any(|segment| segment.trim().is_empty()) {
        return None;
    }
    let (owner, name) = match path.rsplit_once('/') {
        Some((owner, name)) => (Some(owner), name),
        None => (None, path.as_str()),
    };
    let mut identity = json!({
        "canonicalKey": format!("{host}/{path}"),
        "locator": {
            "source": "git-remote",
            "remoteName": "origin",
            "remoteUrl": without_credentials(remote_url)?,
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

/// The remote without the userinfo, query, and fragment of a `scheme://` URL, any of which can
/// carry an access token. The identity is persisted in the append-only event log and sent to every
/// client, so it must never hold one. The URL is parsed and re-serialized by the same parser that validates the identity
/// (`remote_host`), so no parser disagreement can leave userinfo behind. scp-style
/// `user@host:path` remotes carry no secret and stay as written. `None` means the URL does not parse.
fn without_credentials(remote_url: &str) -> Option<String> {
    if !remote_url.contains("://") {
        return Some(remote_url.to_owned());
    }
    let mut url = url::Url::parse(remote_url).ok()?;
    // Only fails for URLs that cannot carry userinfo, which then have none to remove.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
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
            assert_eq!(
                identity["locator"]["remoteUrl"],
                url_without_userinfo(remote)
            );
        }
    }

    /// The stored form: re-serialized by the URL parser, so the host is lowercased.
    fn url_without_userinfo(remote: &str) -> String {
        if !remote.contains("://") {
            return remote.to_owned();
        }
        let mut url = url::Url::parse(remote).unwrap();
        url.set_username("").unwrap();
        url.set_password(None).unwrap();
        url.set_query(None);
        url.set_fragment(None);
        url.into()
    }

    /// A backslash credential matches the stored form of its credential-free remote, so the
    /// canonical key never depends on userinfo.
    #[test]
    fn canonical_key_is_unchanged_by_credentials() {
        for (with, without) in [
            ("ssh://tok\\en-secret@host/a/b", "ssh://host/a/b"),
            (
                "git+ssh://user:pa%2Fss-secret@host/a/b",
                "git+ssh://host/a/b",
            ),
            ("https://oauth2:tok-secret@host/a/b", "https://host/a/b"),
        ] {
            assert_eq!(
                repository_identity(with, "/r").unwrap()["canonicalKey"],
                repository_identity(without, "/r").unwrap()["canonicalKey"],
                "{with}"
            );
        }
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
                "https://host:8443/o/r.git",
            ),
            (
                "https://host/o/r.git?private_token=secret#secret",
                "https://host/o/r.git",
            ),
            ("https://host/o/r@v1.git", "https://host/o/r@v1.git"),
            ("ssh://git@host:2222/o/r.git", "ssh://host:2222/o/r.git"),
            ("ssh://tok\\en-secret@host/a/b", "ssh://host/a/b"),
            (
                "git+ssh://user:pa%2Fss-secret@host/a/b",
                "git+ssh://host/a/b",
            ),
            ("https://tok%5Cen-secret@host/a/b", "https://host/a/b"),
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
            "https://host/a/.git",
            "git@host:a/.git",
            "https://host/a//b.git",
            "git@host:a/ /b.git",
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
