use std::fs;

use bibcode_server::identity_paths::resolve_bibcode_directory;

#[test]
fn canonical_directory_wins_without_touching_legacy_data() {
    let root = tempfile::tempdir().expect("root");
    let canonical = root.path().join(".bibcode");
    let legacy = root.path().join(".t4code");
    fs::create_dir(&canonical).expect("canonical");
    fs::write(&legacy, "legacy blocker").expect("legacy blocker");

    assert_eq!(
        resolve_bibcode_directory(&canonical, &legacy).expect("canonical path"),
        canonical
    );
    assert_eq!(fs::read_to_string(legacy).expect("legacy remains"), "legacy blocker");
}

#[test]
fn legacy_directory_is_copied_and_preserved() {
    let root = tempfile::tempdir().expect("root");
    let canonical = root.path().join(".bibcode");
    let legacy = root.path().join(".t4code");
    fs::create_dir_all(legacy.join("nested")).expect("legacy tree");
    fs::write(legacy.join("nested/settings.json"), "legacy settings").expect("legacy data");

    assert_eq!(
        resolve_bibcode_directory(&canonical, &legacy).expect("migrated path"),
        canonical
    );
    assert_eq!(
        fs::read_to_string(canonical.join("nested/settings.json")).expect("canonical data"),
        "legacy settings"
    );
    assert_eq!(
        fs::read_to_string(legacy.join("nested/settings.json")).expect("legacy remains"),
        "legacy settings"
    );
}

#[test]
fn absent_directories_resolve_to_canonical_without_creating_it() {
    let root = tempfile::tempdir().expect("root");
    let canonical = root.path().join(".bibcode");
    let legacy = root.path().join(".t4code");

    assert_eq!(
        resolve_bibcode_directory(&canonical, &legacy).expect("canonical path"),
        canonical
    );
    assert!(!canonical.exists());
    assert!(!legacy.exists());
}

#[test]
fn copy_failure_keeps_legacy_and_cleans_owned_staging_paths() {
    let root = tempfile::tempdir().expect("root");
    let canonical = root.path().join(".bibcode");
    let legacy = root.path().join(".t4code");
    fs::write(&legacy, "not a directory").expect("legacy blocker");

    assert!(resolve_bibcode_directory(&canonical, &legacy).is_err());
    assert_eq!(fs::read_to_string(&legacy).expect("legacy remains"), "not a directory");
    assert!(!canonical.exists());
    assert!(
        fs::read_dir(root.path())
            .expect("root entries")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".bibcode-migration-"))
    );
}
