//! A `git` for `git_system_config.rs`, compiled by that test. The `mode` file next to the
//! executable picks its behaviour:
//! - `old` reports Git 2.31 and hands every other command to the real Git;
//! - `record` appends the prompt and system-configuration variables of each `fetch` to
//!   `recorded`, then hands every command to the real Git;
//! - `stall` never answers, and appends to `ticks` until it is killed or 30 s pass.
//!
//! The real Git is the first `git` on `PATH` outside this executable's directory.

use std::{
    env, fs,
    io::Write,
    path::Path,
    process::Command,
    thread,
    time::{Duration, Instant},
};

const RECORDED: [&str; 4] = [
    "GCM_INTERACTIVE",
    "GIT_TERMINAL_PROMPT",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
];

fn main() {
    let directory = env::current_exe()
        .expect("fake Git path")
        .parent()
        .expect("fake Git directory")
        .to_path_buf();
    let mode = fs::read_to_string(directory.join("mode")).unwrap_or_default();
    let command = env::args().nth(1);
    match mode.trim() {
        "old" if command.as_deref() == Some("--version") => {
            println!("git version 2.31.0");
        }
        "old" => delegate(&directory),
        "record" => {
            if command.as_deref() == Some("fetch") {
                let mut recorded = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(directory.join("recorded"))
                    .expect("fake Git record");
                for name in RECORDED {
                    let value = env::var_os(name)
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "<unset>".to_owned());
                    writeln!(recorded, "{name}={value}").expect("fake Git record");
                }
            }
            delegate(&directory)
        }
        "stall" => {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(30) {
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(directory.join("ticks"))
                    .and_then(|mut ticks| ticks.write_all(b"."))
                    .expect("fake Git tick");
                thread::sleep(Duration::from_millis(50));
            }
        }
        _ => std::process::exit(2),
    }
}

fn delegate(directory: &Path) -> ! {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let own = fs::canonicalize(directory).ok();
    let real = env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|entry| entry.is_absolute() && fs::canonicalize(entry).ok() != own)
        .map(|entry| entry.join(name))
        .find(|candidate| candidate.is_file())
        .expect("a real Git on PATH after the fake");
    let status = Command::new(real)
        .args(env::args_os().skip(1))
        .status()
        .expect("run the real Git");
    std::process::exit(status.code().unwrap_or(1));
}
