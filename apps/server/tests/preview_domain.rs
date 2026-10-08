use bibcode_server::preview;

use preview::{PreviewManager, PreviewNavStatus, PreviewViewportSetting};

#[tokio::test]
async fn opens_a_preview_session_with_normalized_localhost_url_and_emits_opened() {
    let manager = PreviewManager::new();
    let mut events = manager.subscribe_events();

    let snapshot = manager
        .open("thread-1", Some("localhost:5173"))
        .await
        .expect("open");

    assert_eq!(snapshot.thread_id, "thread-1");
    assert!(snapshot.tab_id.starts_with("tab_"));
    assert_eq!(
        snapshot.nav_status,
        PreviewNavStatus::Loading {
            url: "http://localhost:5173/".to_owned(),
            title: String::new()
        }
    );

    let event = events.recv().await.expect("opened event");
    assert_eq!(event.event_type(), "opened");
    assert_eq!(event.tab_id(), Some(snapshot.tab_id.as_str()));
}

#[tokio::test]
async fn resize_persists_across_navigation_and_status_reports() {
    let manager = PreviewManager::new();
    let opened = manager
        .open("thread-1", Some("http://localhost:5173"))
        .await
        .expect("open");

    let resized = manager
        .resize(
            "thread-1",
            &opened.tab_id,
            PreviewViewportSetting::Freeform {
                width: 1024,
                height: 768,
            },
        )
        .await
        .expect("resize");
    assert_eq!(
        resized.viewport,
        PreviewViewportSetting::Freeform {
            width: 1024,
            height: 768
        }
    );

    let navigated = manager
        .navigate(
            "thread-1",
            &opened.tab_id,
            "http://localhost:5173/about",
            Some("About"),
        )
        .await
        .expect("navigate");
    assert_eq!(navigated.viewport, resized.viewport);

    manager
        .report_status(
            "thread-1",
            &opened.tab_id,
            PreviewNavStatus::Success {
                url: "http://localhost:5173/about".to_owned(),
                title: "About".to_owned(),
            },
            true,
            false,
        )
        .await
        .expect("report status");

    let listed = manager.list("thread-1").await;
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].viewport, resized.viewport);
}

#[tokio::test]
async fn close_is_idempotent_for_unknown_threads() {
    let manager = PreviewManager::new();
    manager.close("thread-missing", None).await.expect("close");
    assert!(manager.list("thread-missing").await.sessions.is_empty());
}

#[tokio::test]
async fn request_open_emits_event_and_first_claim_wins() {
    let manager = PreviewManager::new();
    let mut events = manager.subscribe_events();

    let request_id = manager
        .request_open("thread-1", "localhost:5173/docs")
        .await
        .expect("request open");

    let event = events.recv().await.expect("openRequested event");
    assert_eq!(event.event_type(), "openRequested");
    assert_eq!(event.tab_id(), None);
    let wire = serde_json::to_value(&event).expect("event encodes");
    assert_eq!(wire["type"], "openRequested");
    assert_eq!(wire["threadId"], "thread-1");
    assert_eq!(wire["requestId"], request_id.as_str());
    assert_eq!(wire["url"], "http://localhost:5173/docs");
    assert!(
        wire["createdAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );

    assert!(manager.claim_open_request(&request_id).await);
    assert!(!manager.claim_open_request(&request_id).await);
    assert!(!manager.claim_open_request("open_unknown").await);
}

#[tokio::test]
async fn existing_events_use_camel_case_keys_on_the_wire() {
    let manager = PreviewManager::new();
    let mut events = manager.subscribe_events();
    let snapshot = manager.open("thread-1", None).await.expect("open");
    manager
        .close("thread-1", Some(&snapshot.tab_id))
        .await
        .expect("close");

    for _ in 0..2 {
        let wire = serde_json::to_value(events.recv().await.expect("event")).expect("encodes");
        assert_eq!(wire["threadId"], "thread-1");
        assert_eq!(wire["tabId"], snapshot.tab_id.as_str());
        assert!(wire.get("createdAt").is_some());
        assert!(wire.get("thread_id").is_none());
    }
}

#[tokio::test]
async fn request_open_rejects_non_http_and_oversized_urls() {
    let manager = PreviewManager::new();
    assert!(
        manager
            .request_open("thread-1", "file:///etc/passwd")
            .await
            .is_err()
    );
    let long = format!("http://localhost:5173/{}", "a".repeat(2048));
    assert!(manager.request_open("thread-1", &long).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn open_requests_expire_after_sixty_seconds() {
    let manager = PreviewManager::new();
    let fresh = manager
        .request_open("thread-1", "http://localhost:5173")
        .await
        .expect("request open");
    let stale = manager
        .request_open("thread-1", "http://localhost:5173")
        .await
        .expect("request open");

    tokio::time::advance(std::time::Duration::from_secs(59)).await;
    assert!(manager.claim_open_request(&fresh).await);

    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(!manager.claim_open_request(&stale).await);
}
