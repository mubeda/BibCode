use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use bibcode_server::{
    ServerConfig,
    package_lifecycle::{
        PACKAGE_LIFECYCLE_SCHEMA_VERSION, PackageLifecycleError, PackageLifecyclePhase,
        PackageLifecycleReceiptStore, PackagePrepareInput, PackageRuntimeVerification, PurgePlan,
        PurgePlanSnapshot, PurgePlanStore, execute_authorized_purge,
    },
    persistence::{EnvironmentId, StatePaths, StorageInstanceId, prepare_store},
    resolve_data_root,
    service::ServiceMode,
};
use tempfile::TempDir;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

fn prepare_input(root: &TempDir, nonce: &str) -> PackagePrepareInput {
    PackagePrepareInput {
        nonce: nonce.to_owned(),
        operation_id: Uuid::new_v4(),
        source_version: "0.4.1".to_owned(),
        target_version: "0.5.0".to_owned(),
        environment_id: EnvironmentId::from_uuid(
            Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
        ),
        storage_instance_id: StorageInstanceId::from_uuid(
            Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        ),
        data_root: root.path().canonicalize().unwrap(),
        prior_binary_path: root.path().join("old/bin/bibcode"),
        prior_binary_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_owned(),
        service_mode: ServiceMode::Workstation,
        service_owner: "alice".to_owned(),
        backup_id: Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
        backup_schema_version: 49,
    }
}

#[tokio::test]
async fn receipt_is_versioned_nonce_redacted_and_resumable_at_every_durable_boundary() {
    let root = TempDir::new().unwrap();
    let store = PackageLifecycleReceiptStore::new(root.path());
    let input = prepare_input(&root, "installer-nonce-1");

    let prepared = store.prepare(input.clone()).await.unwrap();
    assert_eq!(prepared.schema_version, PACKAGE_LIFECYCLE_SCHEMA_VERSION);
    assert_eq!(prepared.phase, PackageLifecyclePhase::Prepared);
    assert_ne!(prepared.nonce_sha256, input.nonce);
    prepared
        .verify_restored_binary(&input.prior_binary_path, &input.prior_binary_sha256)
        .unwrap();
    assert!(matches!(
        prepared.verify_restored_binary(
            &input.prior_binary_path,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ),
        Err(PackageLifecycleError::RestoredPackageMismatch)
    ));

    let bytes = tokio::fs::read(store.path()).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("installer-nonce-1"));

    let resumed = store.prepare(input.clone()).await.unwrap();
    assert_eq!(resumed, prepared, "preparation retry must be idempotent");

    for phase in [
        PackageLifecyclePhase::ServiceStopped,
        PackageLifecyclePhase::FilesCommitted,
        PackageLifecyclePhase::ServiceStarted,
        PackageLifecyclePhase::Verified,
    ] {
        let advanced = store
            .advance(&input.nonce, &input.target_version, phase)
            .await
            .unwrap();
        assert_eq!(advanced.phase, phase);
        let retried = store
            .advance(&input.nonce, &input.target_version, phase)
            .await
            .unwrap();
        assert_eq!(retried, advanced, "phase retry must be idempotent");
    }
}

#[tokio::test]
async fn receipt_rejects_concurrent_or_skipping_package_operations() {
    let root = TempDir::new().unwrap();
    let store = PackageLifecycleReceiptStore::new(root.path());
    let input = prepare_input(&root, "installer-nonce-1");
    store.prepare(input.clone()).await.unwrap();

    let conflict = store
        .prepare(prepare_input(&root, "installer-nonce-2"))
        .await
        .expect_err("a second package operation must not replace an active receipt");
    assert!(matches!(conflict, PackageLifecycleError::OperationConflict));

    let skip = store
        .advance(
            &input.nonce,
            &input.target_version,
            PackageLifecyclePhase::FilesCommitted,
        )
        .await
        .expect_err("durable phases cannot be skipped");
    assert!(matches!(
        skip,
        PackageLifecycleError::InvalidTransition { .. }
    ));

    let wrong_nonce = store
        .advance(
            "other-nonce",
            &input.target_version,
            PackageLifecyclePhase::ServiceStopped,
        )
        .await
        .expect_err("installer nonce must bind every retry");
    assert!(matches!(
        wrong_nonce,
        PackageLifecycleError::ReceiptMismatch
    ));
}

#[tokio::test]
async fn one_data_root_lock_serializes_competing_package_preparations() {
    let root = TempDir::new().unwrap();
    let store = PackageLifecycleReceiptStore::new(root.path());
    let first = prepare_input(&root, "installer-nonce-a");
    let second = prepare_input(&root, "installer-nonce-b");
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));
    let first_task = {
        let store = store.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            store.prepare(first).await
        })
    };
    let second_task = {
        let store = store.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            store.prepare(second).await
        })
    };
    barrier.wait().await;
    let results = [first_task.await.unwrap(), second_task.await.unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(PackageLifecycleError::OperationConflict)))
            .count(),
        1
    );
}

#[tokio::test]
async fn rollback_is_allowed_only_before_the_backup_schema_advances() {
    let safe_root = TempDir::new().unwrap();
    let safe_store = PackageLifecycleReceiptStore::new(safe_root.path());
    let safe = prepare_input(&safe_root, "safe-nonce");
    safe_store.prepare(safe.clone()).await.unwrap();
    safe_store
        .advance(
            &safe.nonce,
            &safe.target_version,
            PackageLifecyclePhase::ServiceStopped,
        )
        .await
        .unwrap();
    let rolled_back = safe_store
        .roll_back(&safe.nonce, &safe.target_version, 49)
        .await
        .unwrap();
    assert_eq!(rolled_back.phase, PackageLifecyclePhase::RolledBack);

    let migrated_root = TempDir::new().unwrap();
    let migrated_store = PackageLifecycleReceiptStore::new(migrated_root.path());
    let migrated = prepare_input(&migrated_root, "migrated-nonce");
    migrated_store.prepare(migrated.clone()).await.unwrap();
    migrated_store
        .advance(
            &migrated.nonce,
            &migrated.target_version,
            PackageLifecyclePhase::ServiceStopped,
        )
        .await
        .unwrap();
    let error = migrated_store
        .roll_back(&migrated.nonce, &migrated.target_version, 50)
        .await
        .expect_err("an older binary must never run against a migrated store");
    assert!(matches!(
        error,
        PackageLifecycleError::IrreversibleMigration {
            backup_schema_version: 49,
            current_schema_version: 50
        }
    ));
    assert_eq!(
        migrated_store.load().await.unwrap().unwrap().phase,
        PackageLifecyclePhase::ServiceStopped
    );
}

#[tokio::test]
async fn runtime_verification_binds_identity_version_protocol_assets_service_and_loopback() {
    let root = TempDir::new().unwrap();
    let store = PackageLifecycleReceiptStore::new(root.path());
    let input = prepare_input(&root, "verification-nonce");
    let receipt = store.prepare(input.clone()).await.unwrap();
    let valid = PackageRuntimeVerification {
        environment_id: input.environment_id,
        storage_instance_id: input.storage_instance_id,
        server_version: input.target_version.clone(),
        control_protocol_version: 1,
        expected_control_protocol_version: 1,
        bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3773),
        web_assets_verified: true,
        service_definition_matches: true,
    };
    receipt.verify_runtime(&valid).unwrap();

    let mut invalid = valid.clone();
    invalid.bind = "0.0.0.0:3773".parse().unwrap();
    assert!(matches!(
        receipt.verify_runtime(&invalid),
        Err(PackageLifecycleError::RuntimeVerification(_))
    ));

    invalid = valid;
    invalid.environment_id = EnvironmentId::from_uuid(Uuid::new_v4());
    assert!(matches!(
        receipt.verify_runtime(&invalid),
        Err(PackageLifecycleError::RuntimeVerification(_))
    ));
}

#[test]
fn purge_plan_requires_exact_name_root_identity_expiry_and_existing_removal_guards() {
    let root = TempDir::new().unwrap();
    let now = OffsetDateTime::now_utc();
    let plan = PurgePlan::new(PurgePlanSnapshot {
        environment_id: EnvironmentId::from_uuid(Uuid::new_v4()),
        storage_instance_id: StorageInstanceId::from_uuid(Uuid::new_v4()),
        environment_name: "Build Mac".to_owned(),
        data_root: root.path().canonicalize().unwrap(),
        project_count: 0,
        worktree_count: 0,
        process_count: 0,
        other_paired_client_count: 2,
        now,
        lifetime: Duration::minutes(5),
    })
    .unwrap();

    plan.authorize(
        plan.plan_id,
        "Build Mac",
        &root.path().canonicalize().unwrap(),
        now + Duration::minutes(1),
    )
    .unwrap();
    assert!(
        plan.other_paired_client_count > 0,
        "the UI must warn about other clients"
    );

    for (typed_name, selected_root, at) in [
        (
            "build mac",
            root.path().canonicalize().unwrap(),
            now + Duration::minutes(1),
        ),
        (
            "Build Mac",
            root.path().join("other"),
            now + Duration::minutes(1),
        ),
        (
            "Build Mac",
            root.path().canonicalize().unwrap(),
            now + Duration::minutes(6),
        ),
    ] {
        assert!(
            plan.authorize(plan.plan_id, typed_name, &selected_root, at)
                .is_err()
        );
    }

    let guarded = PurgePlan::new(PurgePlanSnapshot {
        environment_id: plan.environment_id,
        storage_instance_id: plan.storage_instance_id,
        environment_name: "Build Mac".to_owned(),
        data_root: root.path().canonicalize().unwrap(),
        project_count: 1,
        worktree_count: 1,
        process_count: 0,
        other_paired_client_count: 0,
        now,
        lifetime: Duration::minutes(5),
    })
    .unwrap();
    let error = guarded
        .authorize(
            guarded.plan_id,
            "Build Mac",
            &root.path().canonicalize().unwrap(),
            now,
        )
        .expect_err("purge must not bypass project/worktree removal guards");
    assert!(matches!(
        error,
        PackageLifecycleError::RemovalGuardsActive { .. }
    ));

    let encoded = serde_json::to_string(&plan).unwrap();
    assert!(encoded.contains(&plan.expires_at.format(&Rfc3339).unwrap()));
}

#[tokio::test]
async fn authorized_purge_revalidates_offline_identity_and_removes_only_the_exact_root() {
    let root = TempDir::new().unwrap();
    let sibling = root
        .path()
        .parent()
        .unwrap()
        .join(format!("bibcode-purge-sibling-{}", Uuid::new_v4()));
    tokio::fs::write(&sibling, b"preserve").await.unwrap();
    let mut config = ServerConfig::new(root.path());
    let resolved = resolve_data_root(config.data_root_request.clone()).unwrap();
    config.base_dir.clone_from(&resolved.effective);
    config.resolved_data_root = Some(resolved.clone());
    let paths = StatePaths::from_config(&config);
    paths
        .ensure_directories_without_database_side_effects()
        .await
        .unwrap();
    let prepared = prepare_store(&config).await.unwrap();
    let environment_id = prepared.environment_id;
    let storage_instance_id = prepared.storage_instance_id;
    drop(prepared.database);

    let now = OffsetDateTime::now_utc();
    let plan = PurgePlan::new(PurgePlanSnapshot {
        environment_id,
        storage_instance_id,
        environment_name: "Disposable host".to_owned(),
        data_root: resolved.effective.clone(),
        project_count: 0,
        worktree_count: 0,
        process_count: 0,
        other_paired_client_count: 0,
        now,
        lifetime: Duration::minutes(5),
    })
    .unwrap();
    let store = PurgePlanStore::new(&resolved.effective);
    store.persist_plan(&plan).await.unwrap();
    store
        .authorize(plan.plan_id, "Disposable host", now)
        .await
        .unwrap();
    let retry = store
        .validate_authorized_retry(plan.plan_id, "Disposable host")
        .await
        .expect("a durable authorization can resume after the server stops");
    assert_eq!(retry.plan_id, plan.plan_id);
    assert!(matches!(
        store
            .validate_authorized_retry(plan.plan_id, "disposable host")
            .await,
        Err(PackageLifecycleError::EnvironmentNameMismatch)
    ));

    let result = execute_authorized_purge(&resolved.effective, plan.plan_id)
        .await
        .unwrap();
    assert!(result.removed);
    assert_eq!(result.environment_id, environment_id);
    assert!(!resolved.effective.exists());
    assert_eq!(tokio::fs::read(&sibling).await.unwrap(), b"preserve");
    tokio::fs::remove_file(&sibling).await.unwrap();
}
