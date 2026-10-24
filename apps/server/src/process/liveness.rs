//! Whether processes BiBCode did not start are still running on this host.

use std::collections::HashSet;

use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};

/// The `pids` that name a running process, in one process-table refresh. A zombie has exited, so
/// it does not count. A PID the system reused for another process does.
pub(crate) fn running_processes(pids: impl IntoIterator<Item = u32>) -> HashSet<u32> {
    let pids = pids.into_iter().collect::<HashSet<_>>();
    if pids.is_empty() {
        return HashSet::new();
    }
    let system_pids = pids.iter().copied().map(Pid::from_u32).collect::<Vec<_>>();
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&system_pids), true);
    pids.into_iter()
        .filter(|pid| {
            system
                .process(Pid::from_u32(*pid))
                .is_some_and(|process| process.status() != ProcessStatus::Zombie)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::running_processes;

    #[test]
    fn a_running_process_is_found_and_an_exited_one_is_not() {
        // Reaped, and its handle closed, before the lookup.
        let exited = {
            let mut child =
                std::process::Command::new(std::env::current_exe().expect("test binary"))
                    .arg("--list")
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .expect("child");
            child.wait().expect("child exits");
            child.id()
        };
        let current = std::process::id();
        let running = running_processes([current, exited]);
        assert!(running.contains(&current));
        assert!(!running.contains(&exited));
        assert!(running_processes([]).is_empty());
    }
}
