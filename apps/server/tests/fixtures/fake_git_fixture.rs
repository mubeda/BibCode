//! A `git` for `git_system_line_endings.rs`, compiled by that test. The `mode` file next to
//! the executable picks its behaviour:
//! - `old` reports Git 2.31 and answers every other command with a system `core.autocrlf`;
//! - `stall` never answers, and appends to `ticks` until it is killed or 30 s pass.

use std::{
    env, fs,
    io::Write,
    thread,
    time::{Duration, Instant},
};

fn main() {
    let directory = env::current_exe()
        .expect("fake Git path")
        .parent()
        .expect("fake Git directory")
        .to_path_buf();
    let mode = fs::read_to_string(directory.join("mode")).unwrap_or_default();
    match mode.trim() {
        "old" if env::args().nth(1).as_deref() == Some("--version") => {
            println!("git version 2.31.0");
        }
        "old" => print!("core.autocrlf\ntrue\0"),
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
