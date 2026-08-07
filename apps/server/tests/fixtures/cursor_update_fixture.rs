use std::{env, fs, path::PathBuf, process, thread, time::Duration};

fn adjacent_file(name: &str) -> PathBuf {
    env::current_exe()
        .expect("Cursor fixture executable path")
        .parent()
        .expect("Cursor fixture release directory")
        .join(name)
}

fn read_trimmed(name: &str) -> String {
    fs::read_to_string(adjacent_file(name))
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn main() {
    match env::args().nth(1).as_deref() {
        Some("--version") => println!("cursor-agent {}", read_trimmed("version-state")),
        Some("about") => println!(
            r#"{{"cliVersion":"{}"}}"#,
            read_trimmed("version-state")
        ),
        Some("update") => {
            if let Ok(milliseconds) = read_trimmed("update-sleep-ms").parse::<u64>() {
                thread::sleep(Duration::from_millis(milliseconds));
            }
            if let Ok(exit_code) = read_trimmed("update-exit-code").parse::<i32>()
                && exit_code != 0
            {
                eprintln!("cursor update failed");
                process::exit(exit_code);
            }
            let next_version = read_trimmed("next-version");
            if !next_version.is_empty() {
                fs::write(adjacent_file("version-state"), next_version)
                    .expect("write updated Cursor version");
            }
            println!("cursor updated");
        }
        _ => process::exit(1),
    }
}
