//! A `git-lfs` for `git_system_config.rs`, compiled by that test. It implements the two
//! one-shot filter commands, `clean` and `smudge`, so no real Git LFS is needed:
//! - `clean` stores its input under `<common dir>/lfs/objects` and prints a pointer;
//! - `smudge` prints the stored object for a pointer and passes anything else through.
//!
//! Each call appends its command to `calls` next to the executable. A `smudge-fails` file
//! there makes `smudge` exit 1.

use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, exit},
};

const VERSION: &str = "version https://git-lfs.github.com/spec/v1\n";

fn main() {
    let directory = env::current_exe()
        .expect("fake git-lfs path")
        .parent()
        .expect("fake git-lfs directory")
        .to_path_buf();
    let command = env::args().nth(1).unwrap_or_default();
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("calls"))
        .and_then(|mut calls| writeln!(calls, "{command}"))
        .expect("fake git-lfs call log");
    let mut input = Vec::new();
    std::io::stdin()
        .read_to_end(&mut input)
        .expect("fake git-lfs input");
    let output = match command.as_str() {
        "clean" if input.starts_with(VERSION.as_bytes()) => input,
        "clean" => {
            let oid = oid(&input);
            let store = objects();
            fs::create_dir_all(&store).expect("fake git-lfs store");
            fs::write(store.join(&oid), &input).expect("fake git-lfs object");
            format!("{VERSION}oid sha256:{oid}\nsize {}\n", input.len()).into_bytes()
        }
        "smudge" if directory.join("smudge-fails").exists() => exit(1),
        "smudge" => match pointer_oid(&input) {
            Some(oid) => fs::read(objects().join(oid)).unwrap_or_else(|_| exit(1)),
            None => input,
        },
        _ => exit(2),
    };
    std::io::stdout()
        .write_all(&output)
        .expect("fake git-lfs output");
}

fn objects() -> PathBuf {
    let output = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .expect("fake git-lfs finds the repository");
    assert!(output.status.success(), "fake git-lfs outside a repository");
    PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()).join("lfs/objects")
}

/// A pointer-shaped 64-digit name; any deterministic one serves the fake.
fn oid(content: &[u8]) -> String {
    (0..4u64)
        .map(|seed| {
            let hash = content.iter().fold(
                0xcbf2_9ce4_8422_2325 ^ seed,
                |hash: u64, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3),
            );
            format!("{hash:016x}")
        })
        .collect()
}

fn pointer_oid(input: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(input).ok()?.strip_prefix(VERSION)?;
    text.lines()
        .find_map(|line| line.strip_prefix("oid sha256:"))
        .map(str::to_owned)
}
