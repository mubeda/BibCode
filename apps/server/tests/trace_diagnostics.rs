use bibcode_server::diagnostics::TraceDiagnosticsStore;
use serde_json::json;

#[test]
fn actionable_failures_are_redacted_and_survive_restart() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("logs/server.trace.ndjson");

    {
        let store = TraceDiagnosticsStore::new(trace_path.clone());
        store
            .record_failure(
                "git.createWorktree",
                &json!({
                    "_tag": "GitCommandError",
                    "detail": "fatal: bad config line 3 in .gitmodules\nAuthorization: Bearer super-secret"
                }),
            )
            .expect("failure is persisted");
    }

    let restarted = TraceDiagnosticsStore::new(trace_path.clone());
    let diagnostics = restarted.read();

    assert_eq!(
        diagnostics["traceFilePath"],
        trace_path.to_string_lossy().as_ref()
    );
    assert_eq!(diagnostics["recordCount"], 1);
    assert_eq!(diagnostics["failureCount"], 1);
    assert_eq!(
        diagnostics["latestFailures"][0]["name"],
        "git.createWorktree"
    );
    let cause = diagnostics["latestFailures"][0]["cause"]
        .as_str()
        .expect("failure cause");
    assert!(cause.contains("bad config line 3 in .gitmodules"));
    assert!(!cause.contains("super-secret"));
    assert!(cause.contains("[REDACTED]"));
}

#[test]
fn structured_and_common_inline_credentials_are_redacted_before_persistence() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("logs/server.trace.ndjson");
    let store = TraceDiagnosticsStore::new(trace_path.clone());

    store
        .record_failure(
            "provider.probe",
            &json!({
                "context": {
                    "token": "nested-token-value",
                    "client_secret": "nested-client-secret",
                    "reason": "Bearer inline-bearer-value"
                }
            }),
        )
        .expect("failure is persisted");

    let persisted = std::fs::read_to_string(trace_path).expect("trace file is readable");
    assert!(!persisted.contains("nested-token-value"));
    assert!(!persisted.contains("nested-client-secret"));
    assert!(!persisted.contains("inline-bearer-value"));
    assert!(persisted.contains("[REDACTED]"));
}

#[test]
fn credentials_from_legacy_trace_files_are_redacted_when_read() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("logs/server.trace.ndjson");
    std::fs::create_dir_all(trace_path.parent().unwrap()).expect("trace directory");
    std::fs::write(
        &trace_path,
        serde_json::to_string(&json!({
            "type": "native-span",
            "name": "provider.legacyFailure",
            "traceId": "legacy-trace",
            "spanId": "legacy-span",
            "startTimeUnixNano": "1000000000",
            "endTimeUnixNano": "1000000000",
            "durationMs": 0.0,
            "events": [{
                "name": "Authorization: Bearer legacy-super-secret",
                "timeUnixNano": "1000000000",
                "attributes": { "effect.logLevel": "Error" }
            }],
            "exit": {
                "_tag": "Failure",
                "cause": "token=legacy-super-secret"
            }
        }))
        .unwrap()
            + "\n",
    )
    .expect("legacy trace fixture");

    let diagnostics = TraceDiagnosticsStore::new(trace_path).read();
    let encoded = diagnostics.to_string();
    assert!(!encoded.contains("legacy-super-secret"));
    assert!(encoded.contains("[REDACTED]"));
}

#[test]
fn malformed_persisted_lines_are_counted_without_hiding_valid_failures() {
    let directory = tempfile::tempdir().expect("temporary diagnostics directory");
    let trace_path = directory.path().join("server.trace.ndjson");
    std::fs::write(&trace_path, "not-json\n").expect("malformed fixture");
    let store = TraceDiagnosticsStore::new(trace_path);
    store
        .record_failure("vcs.createWorktree", &json!({ "message": "failed" }))
        .expect("valid failure");

    let diagnostics = store.read();
    assert_eq!(diagnostics["parseErrorCount"], 1);
    assert_eq!(diagnostics["recordCount"], 1);
    assert_eq!(diagnostics["failureCount"], 1);
}
