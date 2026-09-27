//! Linux refuses to exec a file held open for writing by any process (`ETXTBSY`).
//! A fork on another test thread inherits every open descriptor until exec, so
//! writing here can leave a script busy when the test runs it. A short-lived
//! child writes the file; this process only sets its mode. A temporary name
//! followed by rename cannot help: inherited descriptors refer to the same inode.
#![allow(dead_code)]

use std::path::Path;
#[cfg(unix)]
use std::{
    io::Write,
    process::{Command, Stdio},
};

// Fixtures may deliberately replace PATH; only writer children need these tools.
#[cfg(unix)]
const FIXTURE_TOOL_PATH: &str = "/usr/bin:/bin";

#[cfg(unix)]
pub(crate) fn write_executable(path: &Path, contents: impl AsRef<[u8]>) {
    use std::os::unix::fs::PermissionsExt;

    let mut child = Command::new("/bin/sh")
        .args(["-c", "exec cat > \"$1\"", "sh"])
        .arg(path)
        .env("PATH", FIXTURE_TOOL_PATH)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| {
            panic!("spawn test fixture writer for {}: {error}", path.display())
        });
    let mut stdin = child.stdin.take().expect("test fixture writer stdin");
    let write_result = stdin.write_all(contents.as_ref());
    drop(stdin);
    let output = child.wait_with_output().unwrap_or_else(|error| {
        panic!(
            "wait for test fixture writer for {}: {error}",
            path.display()
        )
    });
    assert!(
        output.status.success() && write_result.is_ok(),
        "write test fixture script {} failed: status {}; stdin: {write_result:?}; stderr:\n{}",
        path.display(),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .expect("set test fixture script permissions");
}

#[cfg(unix)]
pub(crate) fn copy_executable(from: &Path, to: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let output = Command::new("cp")
        .env("PATH", FIXTURE_TOOL_PATH)
        .arg("--")
        .arg(from)
        .arg(to)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "copy test fixture executable from {} to {}: {error}",
                from.display(),
                to.display()
            )
        });
    assert!(
        output.status.success(),
        "copy test fixture executable from {} to {} failed: status {}; stderr:\n{}",
        from.display(),
        to.display(),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o700))
        .expect("set test fixture executable permissions");
}

#[cfg(windows)]
pub(crate) fn write_executable(path: &Path, contents: impl AsRef<[u8]>) {
    std::fs::write(path, contents).unwrap_or_else(|error| {
        panic!("write test fixture executable {}: {error}", path.display())
    });
}

#[cfg(windows)]
pub(crate) fn copy_executable(from: &Path, to: &Path) {
    std::fs::copy(from, to).unwrap_or_else(|error| {
        panic!(
            "copy test fixture executable from {} to {}: {error}",
            from.display(),
            to.display()
        )
    });
}
