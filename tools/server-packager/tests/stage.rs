use std::path::{Path, PathBuf};

use bibcode_server_packager::stage::{StageInputs, stage_server};
use tempfile::TempDir;

struct Fixture {
    _temporary: TempDir,
    source: PathBuf,
    binary: PathBuf,
    web: PathBuf,
    web_asset_manifest: PathBuf,
    install_layout: PathBuf,
    license: PathBuf,
    notices: PathBuf,
    output: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = TempDir::new().unwrap();
        let source = temporary.path().join("source");
        std::fs::create_dir_all(source.join("web/assets")).unwrap();
        for (path, contents) in [
            ("bibcode", "binary"),
            ("web/index.html", "index"),
            ("web/assets/app.js", "app"),
            ("web-assets.json", "{}"),
            ("install-layout.json", "{}"),
            ("LICENSE", "license"),
            ("THIRD-PARTY-NOTICES.md", "notices"),
        ] {
            std::fs::write(source.join(path), contents).unwrap();
        }
        let output = temporary.path().join("release/bibcode-server");
        let binary = source.join("bibcode");
        let web = source.join("web");
        let web_asset_manifest = source.join("web-assets.json");
        let install_layout = source.join("install-layout.json");
        let license = source.join("LICENSE");
        let notices = source.join("THIRD-PARTY-NOTICES.md");
        Self {
            _temporary: temporary,
            source,
            binary,
            web,
            web_asset_manifest,
            install_layout,
            license,
            notices,
            output,
        }
    }

    fn inputs(&self) -> StageInputs<'_> {
        StageInputs {
            binary: &self.binary,
            web_root: &self.web,
            web_asset_manifest: &self.web_asset_manifest,
            install_layout: &self.install_layout,
            license: &self.license,
            notices: &self.notices,
            output: &self.output,
        }
    }
}

fn relative_files(root: &Path) -> Vec<String> {
    fn visit(root: &Path, path: &Path, output: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), output);
            } else {
                output.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort();
    files
}

#[test]
fn stages_only_the_canonical_server_layout() {
    let fixture = Fixture::new();
    stage_server(fixture.inputs()).unwrap();

    assert_eq!(
        relative_files(&fixture.output),
        [
            "bin/bibcode",
            "share/bibcode/LICENSE",
            "share/bibcode/THIRD-PARTY-NOTICES.md",
            "share/bibcode/install-layout.json",
            "share/bibcode/web-assets.json",
            "share/bibcode/web/assets/app.js",
            "share/bibcode/web/index.html",
        ]
    );
}

#[test]
fn refuses_to_overwrite_an_existing_output() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.output).unwrap();
    std::fs::write(fixture.output.join("user-file"), "preserve").unwrap();

    assert!(stage_server(fixture.inputs()).is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.output.join("user-file")).unwrap(),
        "preserve"
    );
}

#[cfg(unix)]
#[test]
fn rejects_nested_links_and_cleans_the_unpublished_layout() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    symlink(
        fixture.source.join("LICENSE"),
        fixture.source.join("web/assets/escaped"),
    )
    .unwrap();

    assert!(stage_server(fixture.inputs()).is_err());
    assert!(!fixture.output.exists());
    let release = fixture.output.parent().unwrap();
    assert!(std::fs::read_dir(release).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".staging-")
    }));
}
