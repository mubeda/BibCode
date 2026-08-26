use std::path::Path;

use bibcode_server_packager::archive::{ArchiveFormat, archive_directory};
use tempfile::TempDir;

fn stage(root: &Path) {
    std::fs::create_dir_all(root.join("bibcode-server/bin")).unwrap();
    std::fs::create_dir_all(root.join("bibcode-server/share/bibcode/web/assets")).unwrap();
    std::fs::write(root.join("bibcode-server/bin/bibcode"), "binary").unwrap();
    std::fs::write(
        root.join("bibcode-server/share/bibcode/web/index.html"),
        "index",
    )
    .unwrap();
    std::fs::write(
        root.join("bibcode-server/share/bibcode/web/assets/app.js"),
        "app",
    )
    .unwrap();
}

#[test]
fn zip_and_tar_archives_are_reproducible_across_fresh_staging_roots() {
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    stage(first.path());
    stage(second.path());

    for (format, suffix) in [
        (ArchiveFormat::Zip, "zip"),
        (ArchiveFormat::TarGz, "tar.gz"),
    ] {
        let first_output = first.path().join(format!("first.{suffix}"));
        let second_output = second.path().join(format!("second.{suffix}"));
        archive_directory(
            &first.path().join("bibcode-server"),
            &first_output,
            format,
            1_800_000_000,
        )
        .unwrap();
        archive_directory(
            &second.path().join("bibcode-server"),
            &second_output,
            format,
            1_800_000_000,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(first_output).unwrap(),
            std::fs::read(second_output).unwrap()
        );
    }
}

#[cfg(unix)]
#[test]
fn archives_reject_symbolic_links() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    stage(temp.path());
    symlink(
        temp.path()
            .join("bibcode-server/share/bibcode/web/index.html"),
        temp.path().join("bibcode-server/share/bibcode/web/escaped"),
    )
    .unwrap();
    assert!(
        archive_directory(
            &temp.path().join("bibcode-server"),
            &temp.path().join("server.tar.gz"),
            ArchiveFormat::TarGz,
            1_800_000_000,
        )
        .is_err()
    );
}
