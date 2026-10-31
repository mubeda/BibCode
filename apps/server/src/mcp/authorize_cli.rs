//! `bibcode mcp authorize` (#139, slice R): approve or deny a remote AI tool's request to
//! connect from the server's own shell, with the data root's authority, as `bibcode pairing
//! issue` mints a credential. The running server sees the decision on its next authority
//! check, and the consent page's poll reads it from the store.

use clap::Args;

use super::control::McpAccess;
use super::relay::{RelayOptions, open_store, read_settings};
use crate::auth::oauth;
use crate::persistence::{McpOAuthAuthorization, McpOAuthDecision, Repositories};

/// `bibcode mcp authorize [<code>] [--access <level>] [--terminals] [--deny]`.
#[derive(Clone, Debug, Args)]
pub struct AuthorizeArgs {
    /// The code the AI tool's sign-in page shows (`XXXX-XXXX`). Without one, lists the
    /// requests waiting.
    pub code: Option<String>,
    /// The access to approve at, at most Settings → Agents → Agent integrations → Agents
    /// may: read-only, approval-required, auto-accept-edits or full-access. That setting by
    /// default.
    #[arg(long, value_name = "LEVEL", value_parser = super::relay::parse_access)]
    pub access: Option<McpAccess>,
    /// Let the agent use terminals, when it asked for them and Terminals is on at Full access.
    #[arg(long)]
    pub terminals: bool,
    /// Deny the request instead.
    #[arg(long, conflicts_with_all = ["access", "terminals"])]
    pub deny: bool,
}

/// Runs the command; the exit code is 0 on success and 1 when nothing was decided.
pub async fn run_mcp_authorize(options: RelayOptions, args: AuthorizeArgs) -> i32 {
    match authorize(&options, args).await {
        Ok(message) => {
            println!("{message}");
            0
        }
        Err(message) => {
            eprintln!("bibcode: {message}");
            1
        }
    }
}

async fn authorize(options: &RelayOptions, args: AuthorizeArgs) -> Result<String, String> {
    let settings = read_settings(&options.paths().settings)?;
    let (_guard, database) = open_store(options).await?;
    let repositories = Repositories::new(database.clone());
    let outcome = decide(&repositories, &settings_view(settings), args).await;
    database.close().await;
    outcome
}

fn settings_view(settings: super::control::McpServerSettings) -> oauth::McpOAuthSettings {
    oauth::McpOAuthSettings {
        enabled: settings.enabled,
        access: settings.access.as_str().to_owned(),
        terminals: settings.capabilities.terminals,
    }
}

async fn decide(
    repositories: &Repositories,
    settings: &oauth::McpOAuthSettings,
    args: AuthorizeArgs,
) -> Result<String, String> {
    let now = crate::auth::now_ms();
    let pending = repositories
        .list_pending_mcp_oauth_authorizations(now)
        .await
        .map_err(|error| format!("Could not read the requests to connect: {error}"))?;
    let Some(code) = args.code else {
        return Ok(list(&pending, now));
    };
    let code = oauth::normalize_user_code(&code);
    let Some(request) = pending.iter().find(|request| request.user_code == code) else {
        return Err(format!(
            "No waiting request has the code {}. Run `bibcode mcp authorize` to list them.",
            oauth::display_user_code(&code)
        ));
    };
    let client = display_name(request);
    if args.deny {
        return record(repositories, request, McpOAuthDecision::Deny, now)
            .await
            .map(|()| format!("Denied {client}."));
    }
    let access = args.access.map_or_else(
        || settings.access.clone(),
        |access| access.as_str().to_owned(),
    );
    if !oauth::access_within(&access, &settings.access) {
        return Err(format!(
            "--access {access} is above what agents may do here ({}). Choose a lower level, or raise Agents may in Settings → Agents → Agent integrations.",
            settings.access
        ));
    }
    let requested = request
        .scopes
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if args.terminals {
        if !requested
            .iter()
            .any(|scope| scope == crate::auth::SCOPE_TERMINAL_OPERATE)
        {
            return Err(format!(
                "{client} did not ask for terminals. Approve without --terminals, or have it sign in again asking for terminal:operate."
            ));
        }
        if !oauth::terminals_allowed(settings, &access) {
            return Err(
                "Terminals need Terminals on for MCP agents and Full access. Turn them on in Settings → Agents → Agent integrations, then approve with --access full-access --terminals."
                    .to_owned(),
            );
        }
    }
    let scopes = oauth::approved_scopes(&requested, args.terminals);
    record(
        repositories,
        request,
        McpOAuthDecision::Approve {
            access: access.clone(),
            scopes: scopes.join(" "),
        },
        now,
    )
    .await?;
    Ok(format!(
        "Approved {client} at {access}. Its sign-in page returns to {} on its next update.",
        oauth::redirect_host(&request.redirect_uri)
    ))
}

async fn record(
    repositories: &Repositories,
    request: &McpOAuthAuthorization,
    decision: McpOAuthDecision,
    now: i64,
) -> Result<(), String> {
    match repositories
        .decide_mcp_oauth_authorization(request.id.clone(), decision, now)
        .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err("That request was decided or expired meanwhile.".to_owned()),
        Err(error) => Err(format!("Could not record the decision: {error}")),
    }
}

fn display_name(request: &McpOAuthAuthorization) -> String {
    let name = request.client_name.trim();
    if name.is_empty() {
        "This AI tool".to_owned()
    } else {
        format!("\"{}\"", name.replace(char::is_control, ""))
    }
}

fn list(pending: &[McpOAuthAuthorization], now: i64) -> String {
    if pending.is_empty() {
        return "No requests to connect are waiting.".to_owned();
    }
    let mut lines = vec!["Requests to connect:".to_owned()];
    for request in pending {
        let minutes = ((request.expires_at_ms - now) / 60_000).max(0) + 1;
        lines.push(format!(
            "  {}  {}  returns to {}  via {}  asks {}  (expires in {minutes} min)",
            oauth::display_user_code(&request.user_code),
            display_name(request),
            oauth::redirect_host(&request.redirect_uri),
            request.origin,
            request.scopes.replace(' ', ", "),
        ));
    }
    lines.push(
        "Approve one with `bibcode mcp authorize <code>`, or deny it with `--deny`.".to_owned(),
    );
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{McpOAuthClient, NewMcpOAuthAuthorization};

    async fn store_with_request(scopes: &str) -> (Repositories, String) {
        let database = crate::persistence::Database::open_in_memory()
            .await
            .unwrap();
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let repositories = Repositories::new(database);
        let now = crate::auth::now_ms();
        repositories
            .register_mcp_oauth_client(
                McpOAuthClient {
                    client_id: "mcp-c".to_owned(),
                    client_name: "Claude Code".to_owned(),
                    redirect_uris: vec!["http://localhost:53682/callback".to_owned()],
                    source_key: "loopback".to_owned(),
                    created_at_ms: now,
                    approved_at_ms: None,
                    last_used_at_ms: None,
                },
                now,
                oauth::LIMITS,
            )
            .await
            .unwrap();
        repositories
            .create_mcp_oauth_authorization(
                NewMcpOAuthAuthorization {
                    id: "a1".to_owned(),
                    user_code: "ABCD2345".to_owned(),
                    client_id: "mcp-c".to_owned(),
                    redirect_uri: "http://localhost:53682/callback".to_owned(),
                    code_challenge: oauth::s256(&"v".repeat(43)),
                    state: None,
                    resource: "https://env.example.com/mcp".to_owned(),
                    scopes: scopes.to_owned(),
                    origin: "https://env.example.com".to_owned(),
                    source_key: "tunnel".to_owned(),
                    status_cookie_hash: oauth::secret_hash("c"),
                    created_at_ms: now,
                    expires_at_ms: now + oauth::AUTHORIZATION_TTL_MS,
                },
                now,
                oauth::LIMITS,
            )
            .await
            .unwrap();
        (repositories, "a1".to_owned())
    }

    fn settings(access: &str, terminals: bool) -> oauth::McpOAuthSettings {
        oauth::McpOAuthSettings {
            enabled: true,
            access: access.to_owned(),
            terminals,
        }
    }

    fn args(code: Option<&str>) -> AuthorizeArgs {
        AuthorizeArgs {
            code: code.map(str::to_owned),
            access: None,
            terminals: false,
            deny: false,
        }
    }

    #[tokio::test]
    async fn it_lists_then_approves_through_the_data_root_at_the_environment_s_access() {
        let (repositories, id) =
            store_with_request("orchestration:read orchestration:operate").await;
        let settings = settings("approval-required", false);
        let listed = decide(&repositories, &settings, args(None)).await.unwrap();
        assert!(listed.contains("ABCD-2345"), "{listed}");
        assert!(listed.contains("\"Claude Code\""), "{listed}");
        let refused = decide(
            &repositories,
            &settings,
            AuthorizeArgs {
                access: Some(McpAccess::FullAccess),
                ..args(Some("abcd-2345"))
            },
        )
        .await
        .unwrap_err();
        assert!(refused.contains("above what agents may do"), "{refused}");
        let approved = decide(&repositories, &settings, args(Some("abcd-2345")))
            .await
            .unwrap();
        assert!(approved.contains("approval-required"), "{approved}");
        let row = repositories
            .get_mcp_oauth_authorization(id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "approved");
        assert_eq!(row.approved_access.as_deref(), Some("approval-required"));
        assert_eq!(
            decide(&repositories, &settings, args(None)).await.unwrap(),
            "No requests to connect are waiting."
        );
    }

    #[tokio::test]
    async fn terminals_need_the_request_and_the_setting_and_deny_records_a_denial() {
        let (repositories, id) =
            store_with_request("orchestration:read orchestration:operate terminal:operate").await;
        let with_terminals = AuthorizeArgs {
            terminals: true,
            access: Some(McpAccess::FullAccess),
            ..args(Some("ABCD2345"))
        };
        assert!(
            decide(
                &repositories,
                &settings("full-access", false),
                with_terminals.clone()
            )
            .await
            .is_err()
        );
        decide(
            &repositories,
            &settings("full-access", true),
            AuthorizeArgs {
                deny: true,
                terminals: false,
                access: None,
                ..with_terminals
            },
        )
        .await
        .unwrap();
        let row = repositories
            .get_mcp_oauth_authorization(id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "denied");
    }
}
