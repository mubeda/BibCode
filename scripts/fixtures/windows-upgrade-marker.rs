// Copied only into disposable source rebuilds by the CI diagnostics harness.
fn seeded_upgrade_marker(boundary: &str) {
    if !cfg!(windows)
        || std::env::var_os("BIBCODE_SEEDED_WINDOWS_DIAGNOSTICS").as_deref()
            != Some(std::ffi::OsStr::new("1"))
    {
        return;
    }
    if let Some(path) = std::env::var_os("BIBCODE_SEEDED_WINDOWS_MARKERS") {
        seeded_upgrade_write_marker(std::path::Path::new(&path), boundary);
    }
}

fn seeded_upgrade_write_marker(path: &std::path::Path, boundary: &str) {
    use std::io::Write as _;
    if !matches!(
        boundary,
        "install-entered"
            | "install-admitted"
            | "backend-stop-entered"
            | "backend-stop-completed"
            | "plugin-install-entered"
            | "plugin-install-returned-ok"
            | "plugin-install-returned-error"
            | "quiesce-entered"
            | "quiesce-completed"
            | "store-lock-entered"
            | "store-lock-acquired"
            | "checkpoint-entered"
            | "checkpoint-completed"
            | "backup-entered"
            | "backup-completed"
    ) {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    if metadata.len() > 55 * 1024 {
        static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if metadata.len() < 56 * 1024 && !REPORTED.swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            let _ = writeln!(file, "{{\"kind\":\"native-marker-budget\"}}");
        }
        return;
    }
    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let _ = writeln!(
        file,
        "{{\"kind\":\"native-marker\",\"epochMs\":{epoch_ms},\"pid\":{},\"boundary\":\"{boundary}\"}}",
        std::process::id()
    );
}
