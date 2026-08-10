use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::git::{GitWorktreeInventory, GitWorktreeRecord};

use super::service::{
    CatalogFileSystem, CatalogFuture, CatalogProject, CatalogProjectionSource,
    CatalogServiceOptions, CatalogShallowSignature, CatalogThread, DirectoryProbeState,
    InventorySource, ScanFailure,
};
use super::{CatalogRefreshTrigger, WorktreeCatalogService};

#[tokio::test]
async fn anchor_preference_is_primary_then_present_adopted_then_lifetime_common_directory() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [thread("thread-1", "/repo/adopted")],
    )]));
    let inventory = Arc::new(FakeInventorySource::new([
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/adopted", false)],
        ),
    ]));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/adopted", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        projections,
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );

    let subscription = service
        .subscribe("project-1")
        .await
        .expect("initial catalog subscription");
    filesystem.set("/repo/main", DirectoryProbeState::Missing);
    service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("adopted-anchor refresh");
    filesystem.set("/repo/adopted", DirectoryProbeState::Missing);
    service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("lifetime-anchor refresh");

    assert_eq!(
        inventory.calls(),
        [
            PathBuf::from("/repo/main"),
            PathBuf::from("/repo/adopted"),
            PathBuf::from("/repo/common"),
        ]
    );
    drop(subscription);
}

#[tokio::test]
async fn concurrent_first_subscribers_share_one_bootstrap_scan() {
    let inventory = Arc::new(BlockingInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([(
            "/repo/main",
            DirectoryProbeState::Present,
        )])),
        CatalogServiceOptions::default(),
    );

    let first_service = service.clone();
    let first = tokio::spawn(async move { first_service.subscribe("project-1").await });
    wait_for_count(&inventory.calls, 1).await;
    let second_service = service.clone();
    let second = tokio::spawn(async move { second_service.subscribe("project-1").await });
    tokio::task::yield_now().await;
    inventory.release.add_permits(1);

    let first = first
        .await
        .expect("first subscriber task")
        .expect("first subscriber");
    let second = second
        .await
        .expect("second subscriber task")
        .expect("second subscriber");
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.latest().generation, second.latest().generation);
}

#[tokio::test]
async fn initial_latest_marks_a_first_subscriber_refresh_as_seen_exactly_once() {
    let options = CatalogServiceOptions {
        result_ttl: Duration::ZERO,
        ..CatalogServiceOptions::default()
    };
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        }))),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        options,
    );

    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    let initial = subscription.initial_latest();

    assert_eq!(initial.generation, 2);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), subscription.changed())
            .await
            .is_err(),
        "the snapshot atomically returned by latest must already be marked seen"
    );
}

#[tokio::test]
async fn projects_sharing_one_repository_receive_only_their_own_joined_threads() {
    let inventory = Arc::new(FakeInventorySource::new((0..2).map(|_| {
        inventory(
            "/repo/common",
            [
                record("/repo/main", true),
                record("/repo/a", false),
                record("/repo/b", false),
            ],
        )
    })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/main", [thread("thread-a", "/repo/a")]),
            project("project-b", "/repo/main", [thread("thread-b", "/repo/b")]),
        ])),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/a", DirectoryProbeState::Present),
            ("/repo/b", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );

    let project_a = service.subscribe("project-a").await.expect("project A");
    let project_b = service.subscribe("project-b").await.expect("project B");

    assert_eq!(
        project_a
            .latest()
            .adopted_workspaces
            .iter()
            .map(|workspace| workspace.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["thread-a"]
    );
    assert_eq!(
        project_b
            .latest()
            .adopted_workspaces
            .iter()
            .map(|workspace| workspace.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["thread-b"]
    );
    assert_eq!(
        project_a.latest().repository_key,
        project_b.latest().repository_key
    );
}

#[tokio::test]
async fn concurrent_same_repository_refreshes_share_observation_without_crossing_streams() {
    let inventory = Arc::new(PausingAfterTwoInventorySource::new(inventory(
        "/repo/common",
        [
            record("/repo/main", true),
            record("/repo/a", false),
            record("/repo/b", false),
        ],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/main", [thread("thread-a", "/repo/a")]),
            project("project-b", "/repo/main", [thread("thread-b", "/repo/b")]),
        ])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/a", DirectoryProbeState::Present),
            ("/repo/b", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let project_a = service.subscribe("project-a").await.expect("project A");
    let project_b = service.subscribe("project-b").await.expect("project B");
    let refresh_a = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-a", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    let refresh_b = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-b", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 3).await;
    inventory.release.add_permits(1);

    let refreshed_a = refresh_a.await.expect("A task").expect("A refresh");
    let refreshed_b = refresh_b.await.expect("B task").expect("B refresh");
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
    assert_eq!(refreshed_a.adopted_workspaces[0].thread_id, "thread-a");
    assert_eq!(refreshed_b.adopted_workspaces[0].thread_id, "thread-b");
    assert_eq!(
        project_a.latest().adopted_workspaces[0].thread_id,
        "thread-a"
    );
    assert_eq!(
        project_b.latest().adopted_workspaces[0].thread_id,
        "thread-b"
    );
}

#[tokio::test]
async fn shared_observation_never_substitutes_for_validating_a_different_anchor() {
    let inventory = Arc::new(PausingThirdAnchorInventorySource::new());
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/a-main", []),
            project("project-b", "/repo/b-main", []),
        ])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/a-main", DirectoryProbeState::Present),
            ("/repo/b-main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let project_a = service.subscribe("project-a").await.expect("project A");
    let _project_b = service.subscribe("project-b").await.expect("project B");
    let authoritative_a = project_a.latest();
    inventory.replacement_enabled.store(true, Ordering::SeqCst);

    let valid_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-b", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 3).await;
    let replacement_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-a", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    tokio::task::yield_now().await;
    inventory.release.add_permits(1);

    valid_refresh
        .await
        .expect("valid refresh task")
        .expect("valid anchor remains authoritative");
    let error = replacement_refresh
        .await
        .expect("replacement refresh task")
        .expect_err("different replacement anchor must be validated and rejected");
    let degraded_a = service
        .latest("project-a")
        .await
        .expect("project A catalog");
    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 4);
    assert!(!degraded_a.authoritative);
    assert_eq!(degraded_a.worktrees, authoritative_a.worktrees);
}

#[tokio::test]
async fn detached_project_stops_waiting_while_an_aliased_project_keeps_shared_observation_alive() {
    let inventory = Arc::new(PausingAfterTwoInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/main", []),
            project("project-b", "/repo/main", []),
        ])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let project_a = service.subscribe("project-a").await.expect("project A");
    let _project_b = service.subscribe("project-b").await.expect("project B");
    let refresh_b = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-b", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 3).await;
    let refresh_a = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-a", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    tokio::task::yield_now().await;

    drop(project_a);
    for _ in 0..100 {
        if refresh_a.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        refresh_a.is_finished(),
        "detached view must stop waiting for the shared observation"
    );
    let error = refresh_a
        .await
        .expect("A refresh task")
        .expect_err("detached A refresh is cancelled");
    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
    assert!(!refresh_b.is_finished());

    inventory.release.add_permits(1);
    refresh_b.await.expect("B task").expect("B refresh");
}

#[tokio::test]
async fn active_mutation_worker_releases_its_view_while_an_alias_owns_the_shared_observation() {
    let inventory = Arc::new(PausingAfterTwoInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/main", []),
            project("project-b", "/repo/main", []),
        ])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let project_a = service.subscribe("project-a").await.expect("project A");
    let project_b = service.subscribe("project-b").await.expect("project B");
    let observation_requests = service.repository_observation_request_count_for_test();

    service.invalidate_after_mutation("project-a").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    wait_for_repository_observation_requests(&service, observation_requests + 1).await;
    wait_for_count(&inventory.calls, 3).await;
    let refresh_b = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-b", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_repository_observation_requests(&service, observation_requests + 2).await;

    drop(project_a);
    wait_for_active_mutation_refresh_workers(&service, 0).await;
    let detached_snapshot = service
        .latest("project-a")
        .await
        .expect("detached project A catalog");
    let reattach_a = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-a").await })
    };
    wait_for_repository_observation_requests(&service, observation_requests + 3).await;
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
    let awaiting_shared_observation = service
        .latest("project-a")
        .await
        .expect("project A remains retained");
    assert_eq!(awaiting_shared_observation.generation, 1);
    assert!(!awaiting_shared_observation.authoritative);
    assert_eq!(
        awaiting_shared_observation.worktrees,
        detached_snapshot.worktrees
    );
    assert_eq!(
        awaiting_shared_observation.adopted_workspaces,
        detached_snapshot.adopted_workspaces
    );

    inventory.release.add_permits(1);
    let refreshed_b = refresh_b
        .await
        .expect("B refresh task")
        .expect("B consumes the shared observation");
    let reattached = reattach_a
        .await
        .expect("A reattach task")
        .expect("fresh A lifecycle");

    assert_eq!(refreshed_b.generation, 2);
    assert_eq!(project_b.latest().generation, 2);
    assert_eq!(reattached.latest().generation, 2);
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
}

#[tokio::test]
async fn four_repository_scans_run_concurrently_while_a_fifth_waits() {
    let projects =
        (0..5).map(|index| project(&format!("project-{index}"), &format!("/repo-{index}"), []));
    let states = (0..5)
        .map(|index| (format!("/repo-{index}"), DirectoryProbeState::Present))
        .collect::<Vec<_>>();
    let filesystem = Arc::new(FakeFileSystem::from_owned(states));
    let inventory = Arc::new(ConcurrentInventorySource::default());
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new(projects)),
        inventory.clone(),
        filesystem,
        CatalogServiceOptions::default(),
    );
    let tasks = (0..5)
        .map(|index| {
            let service = service.clone();
            tokio::spawn(async move { service.subscribe(&format!("project-{index}")).await })
        })
        .collect::<Vec<_>>();

    wait_for_count(&inventory.active, 4).await;
    tokio::task::yield_now().await;
    assert_eq!(inventory.active.load(Ordering::SeqCst), 4);
    assert_eq!(inventory.max_active.load(Ordering::SeqCst), 4);
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 4);
    inventory.release.add_permits(5);
    for task in tasks {
        task.await
            .expect("catalog task")
            .expect("catalog subscription");
    }
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 5);
    assert_eq!(inventory.max_active.load(Ordering::SeqCst), 4);
}

#[tokio::test(start_paused = true)]
async fn directory_probes_are_capped_at_eight_and_time_out_to_unknown() {
    let filesystem = Arc::new(BlockingProbeFileSystem::default());
    let records = std::iter::once(record("/repo/main", true))
        .chain((0..20).map(|index| record(&format!("/repo/worktree-{index}"), false)));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            records,
        )])),
        filesystem.clone(),
        Arc::new(CatalogServiceOptions::default()).as_ref().clone(),
    );
    let service_task = service.clone();
    let subscription = tokio::spawn(async move { service_task.subscribe("project-1").await });

    wait_for_count(&filesystem.active, 8).await;
    assert_eq!(filesystem.max_active.load(Ordering::SeqCst), 8);
    for _ in 0..4 {
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    let subscription = subscription
        .await
        .expect("subscription task")
        .expect("catalog subscription");
    assert!(
        subscription
            .latest()
            .worktrees
            .iter()
            .skip(1)
            .all(|worktree| worktree.directory_state == super::WorktreeDirectoryState::Unknown)
    );
}

#[tokio::test]
async fn watch_subscription_delivers_only_the_latest_snapshot_after_lag() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..21).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    for _ in 0..20 {
        service
            .refresh("project-1", CatalogRefreshTrigger::Explicit)
            .await
            .expect("refresh");
    }

    let latest = subscription.changed().await.expect("latest catalog value");
    assert_eq!(latest.generation, 21);
    assert_eq!(subscription.latest().generation, 21);
}

#[tokio::test]
async fn failed_scan_retains_the_last_authoritative_arrays_and_only_degrades_health() {
    let first = inventory(
        "/repo/common",
        [record("/repo/main", true), record("/repo/external", false)],
    );
    let inventory = Arc::new(FakeInventorySource::new_results([
        Ok(first),
        Err(ScanFailure {
            reason: super::CatalogDegradedReason::GitFailed,
            message: "git worktree list failed".to_owned(),
        }),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [thread("thread-1", "/repo/external")],
        )])),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/external", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let authoritative = subscription.latest();

    let degraded = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("failed observation still returns retained catalog");

    assert!(!degraded.authoritative);
    assert_eq!(degraded.generation, authoritative.generation);
    assert_eq!(degraded.worktrees, authoritative.worktrees);
    assert_eq!(
        degraded.adopted_workspaces,
        authoritative.adopted_workspaces
    );
    assert!(matches!(
        degraded.scan_status,
        super::CatalogScanStatus::Degraded {
            reason: super::CatalogDegradedReason::GitFailed,
            ..
        }
    ));
}

#[tokio::test]
async fn warm_repository_identity_mismatch_retains_arrays_and_publishes_degraded_health() {
    let inventory = Arc::new(FakeInventorySource::new([
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/external", false)],
        ),
        inventory(
            "/replacement/common",
            [
                record("/repo/main", true),
                record("/repo/replacement", false),
            ],
        ),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [thread("thread-1", "/repo/external")],
        )])),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/external", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let authoritative = subscription.latest();

    let error = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect_err("replacement repository is rejected");
    let degraded = service.latest("project-1").await.expect("retained catalog");

    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert!(!degraded.authoritative);
    assert_eq!(degraded.generation, authoritative.generation);
    assert_eq!(degraded.worktrees, authoritative.worktrees);
    assert_eq!(
        degraded.adopted_workspaces,
        authoritative.adopted_workspaces
    );
    assert!(matches!(
        degraded.scan_status,
        super::CatalogScanStatus::Degraded {
            reason: super::CatalogDegradedReason::AnchorUnavailable,
            ..
        }
    ));
}

#[tokio::test]
async fn mutation_epoch_rejects_a_stale_in_flight_result() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    drop(subscription);
    let refresh_service = service.clone();
    let refresh = tokio::spawn(async move {
        refresh_service
            .refresh("project-1", CatalogRefreshTrigger::Explicit)
            .await
    });
    wait_for_count(&inventory.calls, 2).await;
    service.invalidate_after_mutation("project-1").await;
    inventory.release.add_permits(1);

    let error = refresh
        .await
        .expect("refresh task")
        .expect_err("pre-mutation result must be rejected");
    assert_eq!(error.reason, super::CatalogErrorReason::StaleGeneration);
    let latest = service.latest("project-1").await.expect("latest");
    assert_eq!(latest.generation, 1);
    assert!(latest.authoritative);
    assert!(matches!(
        latest.scan_status,
        super::CatalogScanStatus::Ready
    ));
}

#[tokio::test]
async fn concurrent_refresh_waiters_receive_the_same_stale_generation_result() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    drop(subscription);
    let first = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;
    let second = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    tokio::task::yield_now().await;

    service.invalidate_after_mutation("project-1").await;
    inventory.release.add_permits(2);

    let first = first
        .await
        .expect("first refresh task")
        .expect_err("first refresh is stale");
    let second = second
        .await
        .expect("second refresh task")
        .expect_err("coalesced refresh shares stale result");
    assert_eq!(first.reason, super::CatalogErrorReason::StaleGeneration);
    assert_eq!(second, first);
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn repeated_mutation_invalidations_recover_after_a_coalesced_stale_completion() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    let old_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;

    service.invalidate_after_mutation("project-1").await;
    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    inventory.release.add_permits(1);

    let stale = old_refresh
        .await
        .expect("old refresh task")
        .expect_err("pre-mutation refresh is stale");
    assert_eq!(stale.reason, super::CatalogErrorReason::StaleGeneration);
    wait_for_count(&inventory.calls, 3).await;
    inventory.release.add_permits(1);

    let published = loop {
        let snapshot = subscription.changed().await.expect("catalog publication");
        if snapshot.authoritative && snapshot.generation == 2 {
            break snapshot;
        }
    };
    assert_eq!(published.generation, 2);
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn delayed_mutation_invalidations_use_one_lifecycle_worker_and_one_recovery_scan() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    let old_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;
    let delayed_worker_release = service.pause_mutation_refresh_starts_after_for_test(1);

    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    service.invalidate_after_mutation("project-1").await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    inventory.release.add_permits(1);

    let stale = old_refresh
        .await
        .expect("old refresh task")
        .expect_err("pre-mutation refresh is stale");
    assert_eq!(stale.reason, super::CatalogErrorReason::StaleGeneration);
    wait_for_count(&inventory.calls, 3).await;
    inventory.release.add_permits(1);
    let published = loop {
        let snapshot = subscription.changed().await.expect("catalog publication");
        if snapshot.authoritative && snapshot.generation == 2 {
            break snapshot;
        }
    };
    assert_eq!(published.generation, 2);

    delayed_worker_release.add_permits(4);
    inventory.release.add_permits(4);
    wait_for_active_mutation_refresh_workers(&service, 0).await;

    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
    assert_eq!(
        service.max_active_mutation_refresh_worker_count_for_test(),
        1
    );
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn mutation_during_recovery_uses_one_worker_and_one_serialized_follow_up_scan() {
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");
    let old_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;

    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    inventory.release.add_permits(1);
    let stale = old_refresh
        .await
        .expect("old refresh task")
        .expect_err("pre-mutation refresh is stale");
    assert_eq!(stale.reason, super::CatalogErrorReason::StaleGeneration);
    wait_for_count(&inventory.calls, 3).await;

    service.invalidate_after_mutation("project-1").await;
    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
    inventory.release.add_permits(1);
    wait_for_count(&inventory.calls, 4).await;
    inventory.release.add_permits(1);

    let published = loop {
        let snapshot = subscription.changed().await.expect("catalog publication");
        if snapshot.authoritative && snapshot.generation == 2 {
            break snapshot;
        }
    };
    wait_for_active_mutation_refresh_workers(&service, 0).await;
    assert_eq!(published.generation, 2);
    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
    assert_eq!(
        service.max_active_mutation_refresh_worker_count_for_test(),
        1
    );
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn final_unsubscribe_clears_a_pending_mutation_worker_before_it_can_scan_or_publish() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let probe_calls = filesystem.probe_calls().len();
    let worker_release = service.pause_mutation_refresh_starts_after_for_test(0);

    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    drop(subscription);
    worker_release.add_permits(1);
    wait_for_active_mutation_refresh_workers(&service, 0).await;

    assert_eq!(inventory.calls().len(), 1);
    assert_eq!(filesystem.probe_calls().len(), probe_calls);
    let latest = service.latest("project-1").await.expect("retained catalog");
    assert!(latest.authoritative);
    assert_eq!(latest.generation, 1);
}

#[tokio::test]
async fn final_unsubscribe_aborts_a_mutation_worker_blocked_in_projection_before_reattach() {
    let projections = Arc::new(PausingSecondProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [],
    )]));
    let inventory =
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        projections.clone(),
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let probe_calls = filesystem.probe_calls().len();

    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    wait_for_count(&projections.calls, 2).await;
    drop(subscription);

    wait_for_active_mutation_refresh_workers(&service, 0).await;
    assert_eq!(inventory.calls().len(), 1);
    assert_eq!(filesystem.probe_calls().len(), probe_calls);

    let reattach = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    wait_for_count(&projections.calls, 3).await;
    let reattached = reattach
        .await
        .expect("reattach task")
        .expect("fresh lifecycle does not wait on old projection work");

    assert!(reattached.latest().authoritative);
    assert_eq!(reattached.latest().generation, 2);
    assert_eq!(inventory.calls().len(), 2);
    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
}

#[tokio::test]
async fn reattach_does_not_inherit_a_pending_mutation_worker_from_the_old_lifecycle() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..3).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let first = service
        .subscribe("project-1")
        .await
        .expect("first lifecycle");
    let old_worker_release = service.pause_mutation_refresh_starts_after_for_test(0);

    service.invalidate_after_mutation("project-1").await;
    wait_for_mutation_refresh_worker_starts(&service, 1).await;
    drop(first);
    let reattached = service.subscribe("project-1").await.expect("new lifecycle");
    assert_eq!(reattached.latest().generation, 2);
    assert_eq!(inventory.calls().len(), 2);

    old_worker_release.add_permits(1);
    wait_for_active_mutation_refresh_workers(&service, 0).await;

    assert_eq!(inventory.calls().len(), 2);
    assert_eq!(reattached.latest().generation, 2);
    assert_eq!(service.mutation_refresh_worker_start_count_for_test(), 1);
}

#[tokio::test(start_paused = true)]
async fn focus_refresh_uses_the_one_second_result_ttl() {
    let inventory =
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    service
        .refresh("project-1", CatalogRefreshTrigger::Focus)
        .await
        .expect("coalesced focus refresh");
    assert_eq!(inventory.calls().len(), 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    service
        .refresh("project-1", CatalogRefreshTrigger::Focus)
        .await
        .expect("expired focus refresh");
    assert_eq!(inventory.calls().len(), 2);
    drop(subscription);
}

#[tokio::test(start_paused = true)]
async fn managed_creation_suppression_expires_after_thirty_seconds() {
    let inventory = Arc::new(FakeInventorySource::new((0..3).map(|_| {
        inventory(
            "/repo/common",
            [record("/repo/main", true), record("/repo/managed", false)],
        )
    })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/managed", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    service
        .note_managed_creation("project-1", Path::new("/repo/managed"))
        .await;
    let suppressed = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("suppressed refresh");
    assert!(!descriptor(&suppressed, "/repo/managed").eligible_for_adoption);

    tokio::time::advance(Duration::from_secs(30)).await;
    let expired = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect("post-suppression refresh");
    assert!(descriptor(&expired, "/repo/managed").eligible_for_adoption);
    drop(subscription);
}

#[tokio::test]
async fn joins_active_archived_panel_deleted_missing_and_conflicting_threads_on_the_server() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [
            thread("active", "/repo/active"),
            archived_thread("archived", "/repo/archived"),
            panel_thread("panel", "/repo/panel"),
            deleted_thread("deleted", "/repo/deleted"),
            thread("missing-registered", "/repo/missing"),
            thread("missing-unregistered", "/repo/absent"),
        ],
    )]));
    let inventory = Arc::new(FakeInventorySource::new((0..2).map(|_| {
        inventory(
            "/repo/common",
            [
                record("/repo/main", true),
                record("/repo/active", false),
                record("/repo/archived", false),
                record("/repo/panel", false),
                record("/repo/deleted", false),
                record("/repo/missing", false),
            ],
        )
    })));
    let service = WorktreeCatalogService::with_dependencies(
        projections.clone(),
        inventory,
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/active", DirectoryProbeState::Present),
            ("/repo/archived", DirectoryProbeState::Present),
            ("/repo/panel", DirectoryProbeState::Present),
            ("/repo/deleted", DirectoryProbeState::Present),
            ("/repo/missing", DirectoryProbeState::Missing),
            ("/repo/absent", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let snapshot = subscription.latest();
    assert_eq!(
        descriptor(&snapshot, "/repo/active")
            .adopted_thread_id
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        descriptor(&snapshot, "/repo/archived").adoption_state,
        super::WorktreeAdoptionState::Archived
    );
    assert!(descriptor(&snapshot, "/repo/panel").eligible_for_adoption);
    assert!(descriptor(&snapshot, "/repo/deleted").eligible_for_adoption);
    assert_eq!(
        adopted(&snapshot, "missing-registered").availability,
        super::AdoptedWorktreeAvailability::MissingRegistered
    );
    assert_eq!(
        adopted(&snapshot, "missing-unregistered").availability,
        super::AdoptedWorktreeAvailability::MissingUnregistered
    );

    projections.set_project(project(
        "project-1",
        "/repo/main",
        [
            thread("active", "/repo/active"),
            thread("conflict", "/repo/active"),
        ],
    ));
    let error = service
        .refresh("project-1", CatalogRefreshTrigger::Explicit)
        .await
        .expect_err("duplicate canonical ownership must be explicit");
    assert_eq!(error.reason, super::CatalogErrorReason::Internal);
    let retained = service.latest("project-1").await.expect("retained catalog");
    assert!(retained.authoritative);
    assert!(matches!(
        retained.scan_status,
        super::CatalogScanStatus::Ready
    ));
    assert_eq!(retained.worktrees, snapshot.worktrees);
}

#[tokio::test]
async fn concurrent_refresh_waiters_receive_the_same_ownership_conflict() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [thread("owner", "/repo/external")],
    )]));
    let inventory = Arc::new(PausingSecondInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true), record("/repo/external", false)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        projections.clone(),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/external", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let _subscription = service.subscribe("project-1").await.expect("subscription");
    projections.set_project(project(
        "project-1",
        "/repo/main",
        [
            thread("owner", "/repo/external"),
            thread("conflict", "/repo/external"),
        ],
    ));

    let first = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;
    let second = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    tokio::task::yield_now().await;
    inventory.release.add_permits(1);

    let first = first
        .await
        .expect("first refresh task")
        .expect_err("first refresh must report the ownership conflict");
    let second = second
        .await
        .expect("second refresh task")
        .expect_err("coalesced refresh must report the same ownership conflict");
    assert_eq!(second, first);
}

#[tokio::test]
async fn filesystem_probe_only_reports_directories_as_present() {
    let root = tempfile::tempdir().expect("probe fixture");
    let directory = root.path().join("directory");
    let file = root.path().join("file");
    std::fs::create_dir(&directory).expect("probe directory");
    std::fs::write(&file, "not a directory").expect("probe file");
    let filesystem = super::service::TokioCatalogFileSystem;

    assert_eq!(
        filesystem.probe(directory).await,
        DirectoryProbeState::Present
    );
    assert_eq!(filesystem.probe(file).await, DirectoryProbeState::Unknown);
    assert_eq!(
        filesystem.probe(root.path().join("missing")).await,
        DirectoryProbeState::Missing
    );
}

#[tokio::test(start_paused = true)]
async fn polling_reads_only_shallow_common_git_metadata_and_known_paths_then_stops_and_evicts() {
    let inventory = Arc::new(FakeInventorySource::new([inventory(
        "/repo/common",
        [record("/repo/main", true), record("/repo/external", false)],
    )]));
    let filesystem = Arc::new(FakeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/external", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    tokio::task::yield_now().await;
    assert_eq!(service.active_poller_count_for_test(), 1);
    let calls = filesystem.shallow_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PathBuf::from("/repo/common"));
    assert_eq!(
        calls[0].1.iter().cloned().collect::<HashSet<_>>(),
        [PathBuf::from("/repo/main"), PathBuf::from("/repo/external")]
            .into_iter()
            .collect()
    );

    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        inventory.calls().len(),
        1,
        "unchanged signatures must not run Git"
    );

    drop(subscription);
    let poll_calls = filesystem.shallow_calls().len();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.active_poller_count_for_test(), 0);
    assert_eq!(filesystem.shallow_calls().len(), poll_calls);
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.entry_count_for_test(), 0);
}

#[tokio::test(start_paused = true)]
async fn final_unsubscribe_interrupts_an_in_progress_shallow_signature() {
    let filesystem = Arc::new(BlockingAfterFirstShallowFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            [record("/repo/main", true)],
        )])),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");

    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(2)).await;
    wait_for_count(&filesystem.active, 1).await;
    drop(subscription);
    wait_for_count(&filesystem.interrupted, 1).await;

    assert_eq!(service.active_poller_count_for_test(), 0);
    assert_eq!(filesystem.active.load(Ordering::SeqCst), 0);
    assert_eq!(filesystem.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn final_unsubscribe_cancels_in_progress_git_without_publishing_a_result() {
    let inventory = Arc::new(CancellationAwareInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;

    drop(subscription);
    wait_for_count(&inventory.cancellations, 1).await;
    let error = refresh
        .await
        .expect("refresh task")
        .expect_err("cancelled refresh must not publish a result");

    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert_eq!(
        service
            .latest("project-1")
            .await
            .expect("latest")
            .generation,
        1
    );

    let recovered = service
        .subscribe("project-1")
        .await
        .expect("a later subscriber restarts cancelled work");
    assert!(recovered.latest().authoritative);
    assert_eq!(recovered.latest().generation, 2);
}

#[tokio::test]
async fn final_unsubscribe_interrupts_in_progress_directory_probes() {
    let filesystem = Arc::new(SwitchableBlockingProbeFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/external", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory(
                "/repo/common",
                [record("/repo/main", true), record("/repo/external", false)],
            )
        }))),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    filesystem.block.store(true, Ordering::SeqCst);
    let refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&filesystem.active, 1).await;

    drop(subscription);
    wait_for_count(&filesystem.interrupted, 1).await;
    let error = refresh
        .await
        .expect("refresh task")
        .expect_err("cancelled probes must not publish a result");

    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert_eq!(filesystem.active.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .latest("project-1")
            .await
            .expect("latest")
            .generation,
        1
    );
}

#[tokio::test(start_paused = true)]
async fn aborting_subscription_during_poller_initialization_releases_its_reservation() {
    let filesystem = Arc::new(BlockingShallowFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            [record("/repo/main", true)],
        )])),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscribing = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    wait_for_count(&filesystem.shallow_calls, 1).await;

    subscribing.abort();
    match subscribing.await {
        Err(error) => assert!(error.is_cancelled()),
        Ok(_) => panic!("subscription task must be aborted"),
    }
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;

    assert_eq!(service.active_poller_count_for_test(), 0);
    assert_eq!(service.entry_count_for_test(), 0);
}

#[tokio::test(start_paused = true)]
async fn second_subscriber_keeps_initialization_and_polling_alive_when_the_first_aborts() {
    let filesystem = Arc::new(BlockingFirstShallowFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let inventory =
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        })));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let first = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    wait_for_count(&filesystem.calls, 1).await;
    let second = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    tokio::task::yield_now().await;

    first.abort();
    match first.await {
        Err(error) => assert!(error.is_cancelled()),
        Ok(_) => panic!("first subscription must be aborted"),
    }
    filesystem.release.add_permits(1);
    let mut second = second
        .await
        .expect("second subscription task")
        .expect("second subscriber completes shared initialization");
    assert_eq!(service.active_poller_count_for_test(), 1);

    tokio::time::advance(Duration::from_secs(2)).await;
    for _ in 0..100 {
        if inventory.calls().len() >= 2 {
            break;
        }
        tokio::task::yield_now().await;
    }
    let observed = loop {
        let snapshot = second.changed().await.expect("ongoing poll publication");
        if snapshot.authoritative && snapshot.generation == 2 {
            break snapshot;
        }
    };
    assert!(observed.authoritative);
    assert_eq!(observed.generation, 2);
    assert_eq!(inventory.calls().len(), 2);
}

#[tokio::test]
async fn immediate_reattach_ignores_a_cancelled_refresh_from_the_prior_lifecycle() {
    let inventory = Arc::new(DelayedCancellationInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let first = service
        .subscribe("project-1")
        .await
        .expect("first lifecycle");
    let stale_refresh = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .refresh("project-1", CatalogRefreshTrigger::Explicit)
                .await
        })
    };
    wait_for_count(&inventory.calls, 2).await;
    drop(first);
    wait_for_count(&inventory.cancelled, 1).await;

    let reattach = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    tokio::task::yield_now().await;
    assert!(!reattach.is_finished(), "old refresh is still unwinding");
    inventory.release.add_permits(1);

    let stale_error = stale_refresh
        .await
        .expect("stale refresh task")
        .expect_err("prior lifecycle is cancelled");
    assert_eq!(
        stale_error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    let current = reattach
        .await
        .expect("reattach task")
        .expect("new lifecycle restarts work");
    assert!(current.latest().authoritative);
    assert_eq!(current.latest().generation, 2);
    assert_eq!(inventory.calls.load(Ordering::SeqCst), 3);
    assert_eq!(service.active_poller_count_for_test(), 1);
}

#[tokio::test(start_paused = true)]
async fn subscriber_attachment_at_the_idle_deadline_cannot_join_an_evicted_entry() {
    let filesystem = Arc::new(BlockingAfterFirstShallowFileSystem::new([
        ("/repo/main", DirectoryProbeState::Present),
        ("/repo/common", DirectoryProbeState::Present),
    ]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            [record("/repo/main", true)],
        )])),
        filesystem.clone(),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    drop(subscription);
    tokio::time::advance(Duration::from_secs(59)).await;

    let attaching = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    wait_for_count(&filesystem.active, 1).await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.entry_count_for_test(), 1);

    attaching.abort();
    match attaching.await {
        Err(error) => assert!(error.is_cancelled()),
        Ok(_) => panic!("attachment task must be aborted"),
    }
    wait_for_count(&filesystem.interrupted, 1).await;
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.entry_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn immediate_reattach_cannot_observe_partially_released_repository_ownership() {
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        }))),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let subscription = service.subscribe("project-1").await.expect("subscription");
    let (entered, resume) = service.pause_next_final_release_for_test();
    let dropping = tokio::spawn(async move { drop(subscription) });
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .expect("release reaches deterministic pause");

    let reattach = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let attached_before_repository_release = reattach.is_finished();
    resume.wait();
    dropping.await.expect("release task");

    assert!(
        !attached_before_repository_release,
        "reattach must wait until view and repository ownership release atomically"
    );
    let reattached = reattach
        .await
        .expect("reattach task")
        .expect("reattach after atomic release");
    assert!(reattached.latest().authoritative);
    assert_eq!(reattached.latest().generation, 2);
}

#[tokio::test(start_paused = true)]
async fn mutation_lock_survives_view_eviction_and_serializes_same_repository_projects() {
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([
            project("project-a", "/repo/main", []),
            project("project-b", "/repo/main", []),
        ])),
        Arc::new(FakeInventorySource::new((0..2).map(|_| {
            inventory("/repo/common", [record("/repo/main", true)])
        }))),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let project_a = service.subscribe("project-a").await.expect("project A");
    let project_b = service.subscribe("project-b").await.expect("project B");
    drop(project_a);
    drop(project_b);

    let first_entered = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());
    let first = {
        let service = service.clone();
        let first_entered = Arc::clone(&first_entered);
        let release_first = Arc::clone(&release_first);
        tokio::spawn(async move {
            service
                .with_project_mutation_lock("project-a", || async move {
                    first_entered.notify_one();
                    release_first.notified().await;
                })
                .await;
        })
    };
    first_entered.notified().await;
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(service.entry_count_for_test(), 0);

    let second_entered = Arc::new(AtomicUsize::new(0));
    let second = {
        let service = service.clone();
        let second_entered = Arc::clone(&second_entered);
        tokio::spawn(async move {
            service
                .with_project_mutation_lock("project-b", || async move {
                    second_entered.fetch_add(1, Ordering::SeqCst);
                })
                .await;
        })
    };
    tokio::task::yield_now().await;
    assert_eq!(second_entered.load(Ordering::SeqCst), 0);

    release_first.notify_one();
    first.await.expect("first mutation task");
    second.await.expect("second mutation task");
    assert_eq!(second_entered.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn project_mutation_lock_remains_stable_while_bootstrap_establishes_the_repository_pin() {
    let projections = Arc::new(FakeProjectionSource::new([project(
        "project-1",
        "/repo/main",
        [],
    )]));
    let service = WorktreeCatalogService::with_dependencies(
        projections.clone(),
        Arc::new(FakeInventorySource::new([inventory(
            "/repo/common",
            [record("/repo/main", true)],
        )])),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let first_entered = Arc::new(Notify::new());
    let release_first = Arc::new(Notify::new());
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let first = {
        let service = service.clone();
        let first_entered = Arc::clone(&first_entered);
        let release_first = Arc::clone(&release_first);
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        tokio::spawn(async move {
            service
                .with_project_mutation_lock("project-1", || async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    first_entered.notify_one();
                    release_first.notified().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                })
                .await;
        })
    };
    first_entered.notified().await;

    let subscription = service
        .subscribe("project-1")
        .await
        .expect("bootstrap establishes pin");
    assert!(
        projections
            .projects
            .lock()
            .expect("projects")
            .get("project-1")
            .and_then(|project| project.repository_key.as_ref())
            .is_some(),
        "bootstrap must establish the repository pin before request B"
    );
    let second_entered = Arc::new(Notify::new());
    let second = {
        let service = service.clone();
        let second_entered = Arc::clone(&second_entered);
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        tokio::spawn(async move {
            service
                .with_project_mutation_lock("project-1", || async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    active.fetch_sub(1, Ordering::SeqCst);
                    second_entered.notify_one();
                })
                .await;
        })
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(25), second_entered.notified())
            .await
            .is_err(),
        "request B must wait on the same stable project lock"
    );

    release_first.notify_one();
    first.await.expect("first request");
    second.await.expect("second request");
    assert_eq!(max_active.load(Ordering::SeqCst), 1);
    drop(subscription);
}

#[tokio::test]
async fn shutdown_cancels_inflight_bootstrap_and_prevents_late_entry_insertion() {
    let inventory = Arc::new(ShutdownAwareInventorySource::new(inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([(
            "/repo/main",
            DirectoryProbeState::Present,
        )])),
        CatalogServiceOptions::default(),
    );
    let subscribing = {
        let service = service.clone();
        tokio::spawn(async move { service.subscribe("project-1").await })
    };
    wait_for_count(&inventory.calls, 1).await;

    service.shutdown().await;

    let error = match subscribing.await.expect("subscription task") {
        Ok(_) => panic!("shutdown must cancel bootstrap"),
        Err(error) => error,
    };
    assert_eq!(
        error.reason,
        super::CatalogErrorReason::RepositoryUnavailable
    );
    assert_eq!(inventory.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(service.entry_count_for_test(), 0);
}

#[tokio::test]
async fn shutdown_closes_live_subscriptions_is_idempotent_and_rejects_new_work() {
    let inventory = Arc::new(FakeInventorySource::new([inventory(
        "/repo/common",
        [record("/repo/main", true)],
    )]));
    let service = WorktreeCatalogService::with_dependencies(
        Arc::new(FakeProjectionSource::new([project(
            "project-1",
            "/repo/main",
            [],
        )])),
        inventory.clone(),
        Arc::new(FakeFileSystem::new([
            ("/repo/main", DirectoryProbeState::Present),
            ("/repo/common", DirectoryProbeState::Present),
        ])),
        CatalogServiceOptions::default(),
    );
    let mut subscription = service.subscribe("project-1").await.expect("subscription");

    service.shutdown().await;
    service.shutdown().await;

    assert_eq!(subscription.changed().await, None);
    drop(subscription);
    assert_eq!(service.active_background_task_count_for_test(), 0);
    assert!(service.subscribe("project-1").await.is_err());
    assert!(
        service
            .refresh("project-1", CatalogRefreshTrigger::Explicit)
            .await
            .is_err()
    );
    service.invalidate_after_mutation("project-1").await;
    service
        .note_managed_creation("project-1", Path::new("/repo/new"))
        .await;
    assert_eq!(inventory.calls().len(), 1, "shutdown must be terminal");
    assert_eq!(service.entry_count_for_test(), 0);
}

#[derive(Clone)]
struct FakeProjectionSource {
    projects: Arc<Mutex<HashMap<String, CatalogProject>>>,
}

impl FakeProjectionSource {
    fn new(projects: impl IntoIterator<Item = (String, CatalogProject)>) -> Self {
        Self {
            projects: Arc::new(Mutex::new(projects.into_iter().collect())),
        }
    }

    fn set_project(&self, project: (String, CatalogProject)) {
        self.projects
            .lock()
            .expect("fake projects")
            .insert(project.0, project.1);
    }
}

impl CatalogProjectionSource for FakeProjectionSource {
    fn load(
        &self,
        project_id: String,
    ) -> CatalogFuture<Result<Option<CatalogProject>, super::CatalogError>> {
        let project = self
            .projects
            .lock()
            .expect("fake projects")
            .get(&project_id)
            .cloned();
        Box::pin(async move { Ok(project) })
    }

    fn pin_repository_key(
        &self,
        project_id: String,
        repository_key: String,
    ) -> CatalogFuture<Result<Option<super::service::CatalogPinOutcome>, super::CatalogError>> {
        let projects = Arc::clone(&self.projects);
        Box::pin(async move {
            let mut projects = projects.lock().expect("fake projects");
            let Some(project) = projects.get_mut(&project_id) else {
                return Ok(None);
            };
            let outcome = match project.repository_key.as_deref() {
                None => {
                    project.repository_key = Some(repository_key);
                    super::service::CatalogPinOutcome::Established
                }
                Some(pinned) if pinned == repository_key => {
                    super::service::CatalogPinOutcome::Matched
                }
                Some(pinned) => super::service::CatalogPinOutcome::Mismatch {
                    pinned_repository_key: pinned.to_owned(),
                },
            };
            Ok(Some(outcome))
        })
    }
}

#[derive(Clone)]
struct PausingSecondProjectionSource {
    inner: FakeProjectionSource,
    calls: Arc<AtomicUsize>,
}

impl PausingSecondProjectionSource {
    fn new(projects: impl IntoIterator<Item = (String, CatalogProject)>) -> Self {
        Self {
            inner: FakeProjectionSource::new(projects),
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl CatalogProjectionSource for PausingSecondProjectionSource {
    fn load(
        &self,
        project_id: String,
    ) -> CatalogFuture<Result<Option<CatalogProject>, super::CatalogError>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let load = self.inner.load(project_id);
        Box::pin(async move {
            if call == 2 {
                std::future::pending::<()>().await;
            }
            load.await
        })
    }

    fn pin_repository_key(
        &self,
        project_id: String,
        repository_key: String,
    ) -> CatalogFuture<Result<Option<super::service::CatalogPinOutcome>, super::CatalogError>> {
        self.inner.pin_repository_key(project_id, repository_key)
    }
}

struct FakeInventorySource {
    inventories: Mutex<VecDeque<Result<GitWorktreeInventory, ScanFailure>>>,
    calls: Mutex<Vec<PathBuf>>,
}

impl FakeInventorySource {
    fn new(inventories: impl IntoIterator<Item = GitWorktreeInventory>) -> Self {
        Self {
            inventories: Mutex::new(inventories.into_iter().map(Ok).collect()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<PathBuf> {
        self.calls.lock().expect("inventory calls").clone()
    }

    fn new_results(
        inventories: impl IntoIterator<Item = Result<GitWorktreeInventory, ScanFailure>>,
    ) -> Self {
        Self {
            inventories: Mutex::new(inventories.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

impl InventorySource for FakeInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        self.calls.lock().expect("inventory calls").push(anchor);
        let inventory = self
            .inventories
            .lock()
            .expect("fake inventories")
            .pop_front()
            .expect("configured fake inventory");
        Box::pin(async move { inventory })
    }
}

#[derive(Clone)]
struct FakeFileSystem {
    states: Arc<Mutex<HashMap<PathBuf, DirectoryProbeState>>>,
    probe_calls: Arc<Mutex<Vec<PathBuf>>>,
    shallow_calls: Arc<Mutex<Vec<ShallowCall>>>,
}

type ShallowCall = (PathBuf, Vec<PathBuf>);

impl FakeFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: Arc::new(Mutex::new(
                states
                    .into_iter()
                    .map(|(path, state)| (PathBuf::from(path), state))
                    .collect(),
            )),
            probe_calls: Arc::new(Mutex::new(Vec::new())),
            shallow_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn from_owned(states: impl IntoIterator<Item = (String, DirectoryProbeState)>) -> Self {
        Self {
            states: Arc::new(Mutex::new(
                states
                    .into_iter()
                    .map(|(path, state)| (PathBuf::from(path), state))
                    .collect(),
            )),
            probe_calls: Arc::new(Mutex::new(Vec::new())),
            shallow_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn set(&self, path: impl AsRef<Path>, state: DirectoryProbeState) {
        self.states
            .lock()
            .expect("probe states")
            .insert(path.as_ref().to_path_buf(), state);
    }

    fn shallow_calls(&self) -> Vec<(PathBuf, Vec<PathBuf>)> {
        self.shallow_calls
            .lock()
            .expect("shallow signature calls")
            .clone()
    }

    fn probe_calls(&self) -> Vec<PathBuf> {
        self.probe_calls.lock().expect("probe calls").clone()
    }
}

struct BlockingInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

struct ShutdownAwareInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
}

impl ShutdownAwareInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            cancelled: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl InventorySource for ShutdownAwareInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let response = self.response.clone();
        let cancelled = Arc::clone(&self.cancelled);
        Box::pin(async move {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    cancelled.fetch_add(1, Ordering::SeqCst);
                    Err(ScanFailure {
                        reason: super::CatalogDegradedReason::GitFailed,
                        message: "shutdown cancelled inventory".to_owned(),
                    })
                }
                () = std::future::pending() => Ok(response),
            }
        })
    }
}

struct CancellationAwareInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    cancellations: Arc<AtomicUsize>,
}

impl CancellationAwareInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            cancellations: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl InventorySource for CancellationAwareInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let response = self.response.clone();
        let cancellations = Arc::clone(&self.cancellations);
        Box::pin(async move {
            if call != 2 {
                return Ok(response);
            }
            cancellation.cancelled().await;
            cancellations.fetch_add(1, Ordering::SeqCst);
            Err(ScanFailure {
                reason: super::CatalogDegradedReason::GitFailed,
                message: "inventory cancelled".to_owned(),
            })
        })
    }
}

impl BlockingInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for BlockingInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let response = self.response.clone();
        let calls = Arc::clone(&self.calls);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            release.acquire().await.expect("inventory release").forget();
            Ok(response)
        })
    }
}

struct ConcurrentInventorySource {
    calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl Default for ConcurrentInventorySource {
    fn default() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for ConcurrentInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let calls = Arc::clone(&self.calls);
        let active = Arc::clone(&self.active);
        let max_active = Arc::clone(&self.max_active);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now_active, Ordering::SeqCst);
            release.acquire().await.expect("inventory release").forget();
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(inventory(
                &format!("{}/.git", anchor.display()),
                [GitWorktreeRecord {
                    path: anchor,
                    head: Some("abc123".to_owned()),
                    branch: Some("main".to_owned()),
                    is_primary: true,
                    is_bare: false,
                    locked: false,
                    lock_reason: None,
                    is_prunable: false,
                    prunable_reason: None,
                }],
            ))
        })
    }
}

#[derive(Default)]
struct BlockingProbeFileSystem {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

struct BlockingShallowFileSystem {
    states: HashMap<PathBuf, DirectoryProbeState>,
    shallow_calls: Arc<AtomicUsize>,
}

struct BlockingAfterFirstShallowFileSystem {
    states: HashMap<PathBuf, DirectoryProbeState>,
    calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    interrupted: Arc<AtomicUsize>,
}

struct BlockingFirstShallowFileSystem {
    states: HashMap<PathBuf, DirectoryProbeState>,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl BlockingFirstShallowFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: states
                .into_iter()
                .map(|(path, state)| (PathBuf::from(path), state))
                .collect(),
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl BlockingAfterFirstShallowFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: states
                .into_iter()
                .map(|(path, state)| (PathBuf::from(path), state))
                .collect(),
            calls: Arc::new(AtomicUsize::new(0)),
            active: Arc::new(AtomicUsize::new(0)),
            interrupted: Arc::new(AtomicUsize::new(0)),
        }
    }
}

struct PendingOperationGuard {
    active: Arc<AtomicUsize>,
    interrupted: Arc<AtomicUsize>,
}

impl PendingOperationGuard {
    fn new(active: Arc<AtomicUsize>, interrupted: Arc<AtomicUsize>) -> Self {
        active.fetch_add(1, Ordering::SeqCst);
        Self {
            active,
            interrupted,
        }
    }
}

impl Drop for PendingOperationGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
        self.interrupted.fetch_add(1, Ordering::SeqCst);
    }
}

impl BlockingShallowFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: states
                .into_iter()
                .map(|(path, state)| (PathBuf::from(path), state))
                .collect(),
            shallow_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl CatalogFileSystem for BlockingShallowFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let state = self
            .states
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        Box::pin(async move { state })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        self.shallow_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::pending())
    }
}

impl CatalogFileSystem for BlockingAfterFirstShallowFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let state = self
            .states
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        Box::pin(async move { state })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == 1 {
            return Box::pin(async { CatalogShallowSignature::default() });
        }
        let active = Arc::clone(&self.active);
        let interrupted = Arc::clone(&self.interrupted);
        Box::pin(async move {
            let _guard = PendingOperationGuard::new(active, interrupted);
            std::future::pending().await
        })
    }
}

impl CatalogFileSystem for BlockingFirstShallowFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let state = self
            .states
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        Box::pin(async move { state })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if call == 1 {
                release.acquire().await.expect("shallow release").forget();
            }
            CatalogShallowSignature {
                metadata: u64::try_from(call).expect("test call count fits u64"),
                availability: 0,
            }
        })
    }
}

struct SwitchableBlockingProbeFileSystem {
    states: HashMap<PathBuf, DirectoryProbeState>,
    block: AtomicBool,
    active: Arc<AtomicUsize>,
    interrupted: Arc<AtomicUsize>,
}

impl SwitchableBlockingProbeFileSystem {
    fn new(states: impl IntoIterator<Item = (&'static str, DirectoryProbeState)>) -> Self {
        Self {
            states: states
                .into_iter()
                .map(|(path, state)| (PathBuf::from(path), state))
                .collect(),
            block: AtomicBool::new(false),
            active: Arc::new(AtomicUsize::new(0)),
            interrupted: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl CatalogFileSystem for SwitchableBlockingProbeFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let state = self
            .states
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        if !self.block.load(Ordering::SeqCst) || path == Path::new("/repo/main") {
            return Box::pin(async move { state });
        }
        let active = Arc::clone(&self.active);
        let interrupted = Arc::clone(&self.interrupted);
        Box::pin(async move {
            let _guard = PendingOperationGuard::new(active, interrupted);
            std::future::pending().await
        })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        Box::pin(async { CatalogShallowSignature::default() })
    }
}

impl CatalogFileSystem for BlockingProbeFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        let active = Arc::clone(&self.active);
        let max_active = Arc::clone(&self.max_active);
        Box::pin(async move {
            if path == Path::new("/repo/main") {
                return DirectoryProbeState::Present;
            }
            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now_active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(60)).await;
            active.fetch_sub(1, Ordering::SeqCst);
            DirectoryProbeState::Present
        })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        _common_dir: PathBuf,
        _known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        Box::pin(async { CatalogShallowSignature::default() })
    }
}

struct PausingSecondInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

struct DelayedCancellationInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

impl DelayedCancellationInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            cancelled: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for DelayedCancellationInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let response = self.response.clone();
        let cancelled = Arc::clone(&self.cancelled);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if call == 2 {
                cancellation.cancelled().await;
                cancelled.fetch_add(1, Ordering::SeqCst);
                release
                    .acquire()
                    .await
                    .expect("cancel unwind release")
                    .forget();
                return Err(ScanFailure {
                    reason: super::CatalogDegradedReason::GitFailed,
                    message: "cancelled prior lifecycle".to_owned(),
                });
            }
            Ok(response)
        })
    }
}

struct PausingAfterTwoInventorySource {
    response: GitWorktreeInventory,
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
}

struct PausingThirdAnchorInventorySource {
    calls: Arc<AtomicUsize>,
    release: Arc<Semaphore>,
    replacement_enabled: AtomicBool,
}

impl PausingThirdAnchorInventorySource {
    fn new() -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
            replacement_enabled: AtomicBool::new(false),
        }
    }
}

impl InventorySource for PausingThirdAnchorInventorySource {
    fn inventory(
        &self,
        anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let release = Arc::clone(&self.release);
        let replacement =
            self.replacement_enabled.load(Ordering::SeqCst) && anchor == Path::new("/repo/a-main");
        Box::pin(async move {
            if call == 3 {
                release
                    .acquire()
                    .await
                    .expect("valid anchor release")
                    .forget();
            }
            let common_dir = if replacement {
                "/replacement/common"
            } else {
                "/repo/common"
            };
            Ok(inventory(
                common_dir,
                [record(&anchor.to_string_lossy(), true)],
            ))
        })
    }
}

impl PausingAfterTwoInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for PausingAfterTwoInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let response = self.response.clone();
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if call > 2 {
                release
                    .acquire()
                    .await
                    .expect("shared scan release")
                    .forget();
            }
            Ok(response)
        })
    }
}

impl PausingSecondInventorySource {
    fn new(response: GitWorktreeInventory) -> Self {
        Self {
            response,
            calls: Arc::new(AtomicUsize::new(0)),
            release: Arc::new(Semaphore::new(0)),
        }
    }
}

impl InventorySource for PausingSecondInventorySource {
    fn inventory(
        &self,
        _anchor: PathBuf,
        _cancellation: CancellationToken,
    ) -> CatalogFuture<Result<GitWorktreeInventory, ScanFailure>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let response = self.response.clone();
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if call > 1 {
                release
                    .acquire()
                    .await
                    .expect("second scan release")
                    .forget();
            }
            Ok(response)
        })
    }
}

async fn wait_for_count(value: &AtomicUsize, expected: usize) {
    for _ in 0..10_000 {
        if value.load(Ordering::SeqCst) >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("counter did not reach {expected}");
}

async fn wait_for_mutation_refresh_worker_starts(
    service: &WorktreeCatalogService,
    expected: usize,
) {
    for _ in 0..10_000 {
        if service.mutation_refresh_worker_start_count_for_test() >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("mutation refresh worker start count did not reach {expected}");
}

async fn wait_for_active_mutation_refresh_workers(
    service: &WorktreeCatalogService,
    expected: usize,
) {
    for _ in 0..10_000 {
        if service.active_mutation_refresh_worker_count_for_test() == expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("active mutation refresh worker count did not reach {expected}");
}

async fn wait_for_repository_observation_requests(
    service: &WorktreeCatalogService,
    expected: usize,
) {
    for _ in 0..10_000 {
        if service.repository_observation_request_count_for_test() >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("repository observation request count did not reach {expected}");
}

impl CatalogFileSystem for FakeFileSystem {
    fn probe(&self, path: PathBuf) -> CatalogFuture<DirectoryProbeState> {
        self.probe_calls
            .lock()
            .expect("probe calls")
            .push(path.clone());
        let state = self
            .states
            .lock()
            .expect("probe states")
            .get(&path)
            .copied()
            .unwrap_or(DirectoryProbeState::Missing);
        Box::pin(async move { state })
    }

    fn canonicalize(&self, path: PathBuf) -> CatalogFuture<Result<PathBuf, std::io::Error>> {
        Box::pin(async move { Ok(path) })
    }

    fn shallow_signature(
        &self,
        common_dir: PathBuf,
        known_paths: Vec<PathBuf>,
    ) -> CatalogFuture<CatalogShallowSignature> {
        self.shallow_calls
            .lock()
            .expect("shallow signature calls")
            .push((common_dir, known_paths));
        Box::pin(async { CatalogShallowSignature::default() })
    }
}

fn project(
    project_id: &str,
    workspace_root: &str,
    threads: impl IntoIterator<Item = CatalogThread>,
) -> (String, CatalogProject) {
    (
        project_id.to_owned(),
        CatalogProject {
            workspace_root: PathBuf::from(workspace_root),
            baseline_paths: Vec::new(),
            threads: threads.into_iter().collect(),
            repository_key: None,
        },
    )
}

fn thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        thread_id: thread_id.to_owned(),
        kind: "workspace".to_owned(),
        worktree_path: Some(PathBuf::from(worktree_path)),
        branch: Some("feature".to_owned()),
        archived: false,
        deleted: false,
    }
}

fn archived_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        archived: true,
        ..thread(thread_id, worktree_path)
    }
}

fn panel_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        kind: "panel".to_owned(),
        ..thread(thread_id, worktree_path)
    }
}

fn deleted_thread(thread_id: &str, worktree_path: &str) -> CatalogThread {
    CatalogThread {
        deleted: true,
        ..thread(thread_id, worktree_path)
    }
}

fn descriptor<'a>(
    snapshot: &'a super::WorktreeCatalogSnapshot,
    path: &str,
) -> &'a super::WorktreeDescriptor {
    snapshot
        .worktrees
        .iter()
        .find(|worktree| worktree.path == path)
        .expect("worktree descriptor")
}

fn adopted<'a>(
    snapshot: &'a super::WorktreeCatalogSnapshot,
    thread_id: &str,
) -> &'a super::AdoptedWorktreeStatus {
    snapshot
        .adopted_workspaces
        .iter()
        .find(|workspace| workspace.thread_id == thread_id)
        .expect("adopted workspace status")
}

fn inventory(
    common_dir: &str,
    records: impl IntoIterator<Item = GitWorktreeRecord>,
) -> GitWorktreeInventory {
    GitWorktreeInventory {
        common_dir: PathBuf::from(common_dir),
        records: records.into_iter().collect(),
        nul_delimited: true,
    }
}

fn record(path: &str, is_primary: bool) -> GitWorktreeRecord {
    GitWorktreeRecord {
        path: PathBuf::from(path),
        head: Some("abc123".to_owned()),
        branch: Some(if is_primary { "main" } else { "feature" }.to_owned()),
        is_primary,
        is_bare: false,
        locked: false,
        lock_reason: None,
        is_prunable: false,
        prunable_reason: None,
    }
}
