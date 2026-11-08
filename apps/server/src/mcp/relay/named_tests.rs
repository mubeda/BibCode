//! `bibcode mcp --client <name>` (#280): the named relay, and the relay's SQL on a store from
//! before named clients.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::*;
use crate::{ServerConfig, ServerHandle, ServerRuntime};

fn options(root: &Path, client: Option<&str>) -> RelayOptions {
    RelayOptions {
        root: crate::data_root::resolve_data_root(crate::data_root::DataRootRequest::explicit(
            crate::data_root::DataRootSource::Cli,
            root.to_path_buf(),
            root.to_path_buf(),
        ))
        .expect("data root"),
        dev_url: None,
        url: None,
        access: None,
        client: client.map(str::to_owned),
    }
}

async fn start_server(root: &Path) -> ServerHandle {
    let providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root).state_dir(),
        json!({ "providers": providers }),
    );
    ServerRuntime::start(ServerConfig::new(root).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts")
}

/// One query against the data root's store, as the relay opens it.
async fn query<T: Send + 'static>(
    root: &Path,
    run: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
) -> T {
    let database =
        crate::persistence::Database::open_existing(ServerConfig::new(root).database_path())
            .await
            .expect("database");
    let value = database
        .call(move |connection| Ok(run(connection)?))
        .await
        .expect("query");
    database.close().await;
    value
}

/// A store that stopped at migration 69, as an older server leaves it.
fn store_before_named_clients(root: &Path) {
    let path = ServerConfig::new(root).database_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut connection = rusqlite::Connection::open(path).unwrap();
    crate::persistence::run_migrations(&mut connection, Some(69)).unwrap();
}

async fn link_count(root: &Path) -> i64 {
    query(root, |connection| {
        connection.query_row("SELECT COUNT(*) FROM auth_pairing_links", [], |row| {
            row.get(0)
        })
    })
    .await
}

#[tokio::test]
async fn the_relay_labels_a_named_client_and_still_revokes_on_eof() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let (mut input, relay_input) = tokio::io::duplex(1 << 16);
    let (relay_output, output) = tokio::io::duplex(1 << 16);
    let relay = tokio::spawn(run(
        options(root.path(), Some("  builder  ")),
        BufReader::new(relay_input),
        relay_output,
        std::future::pending(),
    ));
    let initialize = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "Other Name", "version": "1" },
    }});
    input
        .write_all(format!("{initialize}\n").as_bytes())
        .await
        .unwrap();
    let mut lines = BufReader::new(output).lines();
    let answered = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("an answer in time")
        .unwrap()
        .expect("a line");
    assert!(answered.contains("protocolVersion"), "{answered}");
    drop(input);
    relay.await.unwrap().expect("the relay ends cleanly");

    let (label, revoked, name, identity_revoked) = query(root.path(), |connection| {
        connection.query_row(
            "SELECT s.client_label, s.revoked_at, n.name, n.revoked_at FROM auth_sessions AS s \
             JOIN mcp_named_clients AS n ON n.client_id = s.mcp_named_client_id",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
    })
    .await;
    assert_eq!(label, "MCP · builder", "the name, trimmed, not clientInfo");
    assert!(revoked.is_some(), "EOF revokes the run's credential");
    assert_eq!(name, "builder");
    assert_eq!(identity_revoked, None, "the identity outlives the run");
    server.shutdown();
    server.join().await.expect("server joins");
}

#[tokio::test]
async fn a_bad_client_name_exits_before_any_credential() {
    let root = tempfile::tempdir().expect("root");
    store_before_named_clients(root.path());
    for name in ["", "   ", "tab\there", &"x".repeat(61)] {
        let error = Connection::open(options(root.path(), Some(name)))
            .await
            .err()
            .expect("refused");
        assert_eq!(error, CLIENT_NAME_MESSAGE, "{name:?}");
    }
    assert!(
        client_name(&"é".repeat(60)).is_ok(),
        "60 characters, not bytes"
    );
    assert_eq!(link_count(root.path()).await, 0);
}

#[tokio::test]
async fn a_named_relay_against_a_store_without_named_clients_exits_before_any_credential() {
    let root = tempfile::tempdir().expect("root");
    store_before_named_clients(root.path());
    let minted = mint(
        &options(root.path(), Some("builder")),
        "MCP · builder",
        McpAccess::ReadOnly,
    )
    .await;
    assert_eq!(minted, Err(NAMED_CLIENTS_UNKNOWN_MESSAGE.to_owned()));
    assert_eq!(link_count(root.path()).await, 0);
}

/// A newer relay without `--client` next to an older server: its capacity count, link insert
/// and revoke name only columns the older store has.
#[tokio::test]
async fn an_unnamed_relay_signs_in_and_revokes_against_a_store_before_named_clients() {
    let root = tempfile::tempdir().expect("root");
    store_before_named_clients(root.path());
    let options = options(root.path(), None);
    let (link_id, _) = mint(&options, "MCP · old store", McpAccess::ReadOnly)
        .await
        .expect("mints on a migration-69 store");
    assert_eq!(link_count(root.path()).await, 1);
    revoke_credentials(&options, std::slice::from_ref(&link_id))
        .await
        .expect("revokes on a migration-69 store");
    let revoked: Option<String> = query(root.path(), move |connection| {
        connection.query_row(
            "SELECT revoked_at FROM auth_pairing_links WHERE id = ?",
            [link_id],
            |row| row.get(0),
        )
    })
    .await;
    assert!(revoked.is_some());
}
