use std::path::Path;

use bibcode_server::{
    ServerConfig,
    data_root::{DataRootRequest, DataRootSource, resolve_data_root},
    persistence::{
        Database, LegacyConnectCleanupFailpointForIntegrationTest, LegacyConnectCleanupReceipt,
        StatePaths, complete_legacy_connect_cleanup,
        complete_legacy_connect_cleanup_for_integration_test, run_migrations,
    },
};
use tempfile::TempDir;

fn state_paths(temp: &TempDir) -> StatePaths {
    let mut config = ServerConfig::new(temp.path());
    let resolved = resolve_data_root(DataRootRequest::explicit(
        DataRootSource::Cli,
        temp.path().to_path_buf(),
        temp.path().to_path_buf(),
    ))
    .expect("resolved test data root");
    config.base_dir.clone_from(&resolved.effective);
    config.resolved_data_root = Some(resolved);
    StatePaths::from_config(&config)
}

async fn seeded_store(paths: &StatePaths, canary: &str) -> Database {
    std::fs::create_dir_all(&paths.state_dir).expect("state directory");
    let database = Database::create_new(&paths.database)
        .await
        .expect("test database");
    let canary = canary.to_owned();
    database
        .call(move |connection| {
            run_migrations(connection, Some(48))?;
            connection.execute_batch(
                "CREATE TABLE connect_native_secrets (value TEXT NOT NULL);\
                 CREATE TABLE connect_native_replay (value TEXT NOT NULL);",
            )?;
            connection.execute("INSERT INTO connect_native_secrets VALUES (?)", [&canary])?;
            connection.execute("INSERT INTO connect_native_replay VALUES (?)", [&canary])?;
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("seed and migrate database");
    database
}

fn assert_bytes_absent(path: &Path, needle: &[u8]) {
    if let Ok(bytes) = std::fs::read(path) {
        assert!(
            !bytes.windows(needle.len()).any(|window| window == needle),
            "secret canary remained in {}",
            path.display()
        );
    }
}

#[tokio::test]
async fn cleanup_compacts_sqlite_removes_only_owned_paths_and_is_idempotent() {
    let temp = TempDir::new().expect("temporary data root");
    let paths = state_paths(&temp);
    let canary = "legacy-secret-canary-never-report";
    let database = seeded_store(&paths, canary).await;
    let credential_path = paths.state_dir.join("environment-jwt.json");
    std::fs::write(&credential_path, canary).expect("legacy credential fixture");
    let tool_directory = paths
        .base_dir
        .join("tools")
        .join(["cloud", "flared"].concat());
    std::fs::create_dir_all(&tool_directory).expect("legacy tool directory");
    std::fs::write(tool_directory.join("binary"), canary).expect("legacy tool fixture");
    let backup = paths.backups_dir.join("copied-state.bak");
    std::fs::create_dir_all(&paths.backups_dir).expect("backup directory");
    std::fs::write(&backup, canary).expect("backup fixture");

    let receipt = complete_legacy_connect_cleanup(&paths, &database)
        .await
        .expect("privacy cleanup");
    let repeated = complete_legacy_connect_cleanup(&paths, &database)
        .await
        .expect("idempotent privacy cleanup");

    assert_eq!(receipt, repeated);
    assert_eq!(
        receipt,
        LegacyConnectCleanupReceipt {
            version: 1,
            sqlite_compacted: true,
            owned_paths_removed: true,
            completed_at: receipt.completed_at.clone(),
        }
    );
    assert!(!credential_path.exists());
    assert!(!tool_directory.exists());
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), canary);
    let receipt_path = paths.state_dir.join("legacy-connect-cleanup.json");
    let receipt_text = std::fs::read_to_string(&receipt_path).expect("cleanup receipt");
    assert!(!receipt_text.contains(canary));
    assert_bytes_absent(&paths.database, canary.as_bytes());
    assert_bytes_absent(
        Path::new(&format!("{}-wal", paths.database.display())),
        canary.as_bytes(),
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_refuses_owned_leaf_symlinks_without_touching_the_target() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().expect("temporary data root");
    let paths = state_paths(&temp);
    let database = seeded_store(&paths, "database-canary").await;
    let outside = temp
        .path()
        .parent()
        .unwrap()
        .join(format!("outside-legacy-cleanup-{}", uuid::Uuid::new_v4()));
    std::fs::write(&outside, "outside-canary").expect("outside fixture");
    let credential_path = paths.state_dir.join("environment-jwt.json");
    symlink(&outside, &credential_path).expect("malicious leaf symlink");

    let error = complete_legacy_connect_cleanup(&paths, &database)
        .await
        .expect_err("symlink must stop cleanup");

    assert!(error.to_string().contains("unsafe owned path"));
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside-canary");
    assert!(!paths.state_dir.join("legacy-connect-cleanup.json").exists());
    std::fs::remove_file(outside).expect("remove outside fixture");
}

#[tokio::test]
async fn every_interrupted_phase_retries_without_publishing_a_partial_receipt() {
    for failpoint in [
        LegacyConnectCleanupFailpointForIntegrationTest::BeforeVacuum,
        LegacyConnectCleanupFailpointForIntegrationTest::AfterSqlite,
        LegacyConnectCleanupFailpointForIntegrationTest::AfterOwnedPaths,
    ] {
        let temp = TempDir::new().expect("temporary data root");
        let paths = state_paths(&temp);
        let canary = format!("failpoint-canary-{failpoint:?}");
        let database = seeded_store(&paths, &canary).await;
        let credential_path = paths.state_dir.join("environment-jwt.json");
        std::fs::write(&credential_path, &canary).expect("legacy credential fixture");
        let tool_directory = paths
            .base_dir
            .join("tools")
            .join(["cloud", "flared"].concat());
        std::fs::create_dir_all(&tool_directory).expect("legacy tool directory");
        std::fs::write(tool_directory.join("binary"), &canary).expect("legacy tool fixture");

        let error =
            complete_legacy_connect_cleanup_for_integration_test(&paths, &database, failpoint)
                .await
                .expect_err("failpoint must interrupt cleanup");

        assert!(!error.to_string().contains(&canary));
        assert!(!paths.state_dir.join("legacy-connect-cleanup.json").exists());

        let receipt = complete_legacy_connect_cleanup(&paths, &database)
            .await
            .expect("retry privacy cleanup");
        assert!(receipt.sqlite_compacted);
        assert!(receipt.owned_paths_removed);
        assert!(!credential_path.exists());
        assert!(!tool_directory.exists());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_refuses_owned_directory_symlinks_without_traversal() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().expect("temporary data root");
    let paths = state_paths(&temp);
    let database = seeded_store(&paths, "database-canary").await;
    let outside = temp
        .path()
        .parent()
        .unwrap()
        .join(format!("outside-legacy-tools-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&outside).expect("outside directory");
    std::fs::write(outside.join("keep"), "outside-canary").expect("outside fixture");
    let tools = paths.base_dir.join("tools");
    std::fs::create_dir(&tools).expect("tools directory");
    let tool_directory = tools.join(["cloud", "flared"].concat());
    symlink(&outside, &tool_directory).expect("malicious directory symlink");

    let error = complete_legacy_connect_cleanup(&paths, &database)
        .await
        .expect_err("directory symlink must stop cleanup");

    assert!(error.to_string().contains("unsafe owned path"));
    assert_eq!(
        std::fs::read_to_string(outside.join("keep")).unwrap(),
        "outside-canary"
    );
    assert!(!paths.state_dir.join("legacy-connect-cleanup.json").exists());
    std::fs::remove_file(tool_directory).expect("remove symlink fixture");
    std::fs::remove_dir_all(outside).expect("remove outside fixture");
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_reports_read_only_state_without_disclosing_secret_content() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().expect("temporary data root");
    let paths = state_paths(&temp);
    let canary = "read-only-secret-canary";
    let database = seeded_store(&paths, canary).await;
    let credential_path = paths.state_dir.join("environment-jwt.json");
    std::fs::write(&credential_path, canary).expect("legacy credential fixture");
    let original_permissions = std::fs::metadata(&paths.state_dir)
        .expect("state metadata")
        .permissions();
    let mut read_only = original_permissions.clone();
    read_only.set_mode(0o500);
    std::fs::set_permissions(&paths.state_dir, read_only).expect("read-only state directory");

    let result = complete_legacy_connect_cleanup(&paths, &database).await;

    std::fs::set_permissions(&paths.state_dir, original_permissions)
        .expect("restore state permissions");
    let error = result.expect_err("read-only state must stop cleanup");
    assert!(!error.to_string().contains(canary));
    assert!(!paths.state_dir.join("legacy-connect-cleanup.json").exists());
}
