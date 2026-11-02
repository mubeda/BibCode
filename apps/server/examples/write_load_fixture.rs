//! Writes the transfer-budget load fixture (`tests/support/load_fixture.rs`) into a fresh store.
//!
//! `scripts/measure-remote-latency.ts --link 3g` runs it before it starts a disposable
//! `bibcode serve`, so the 3G measurement and the byte-budget test (`tests/transfer_budget.rs`)
//! read the same data.
//!
//! ```text
//! cargo run -p bibcode-server --example write_load_fixture -- <base-dir> <workspace-parent>
//! ```
//!
//! `<base-dir>` is the `BIBCODE_HOME` the server will start with; the store goes to its
//! `userdata/state.sqlite`. Each fixture project's workspace is a directory under
//! `<workspace-parent>`.

use std::path::PathBuf;

use bibcode_server::{
    ServerConfig,
    persistence::{Database, Repositories, run_migrations},
};

#[path = "../tests/support/load_fixture.rs"]
mod load_fixture;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1).map(PathBuf::from);
    let base_dir = args.next().ok_or("missing base-dir argument")?;
    let workspace_parent = args.next().ok_or("missing workspace-parent argument")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }
    let path = ServerConfig::new(&base_dir).database_path();
    std::fs::create_dir_all(path.parent().ok_or("database path has no parent")?)?;
    let database = Database::create_new(&path).await?;
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await?;
    load_fixture::seed(&Repositories::new(database.clone()), &workspace_parent).await;
    // Fold the write-ahead log into the file, so the server opens one self-contained store.
    database
        .call(|connection| {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok(())
        })
        .await?;
    Ok(())
}
