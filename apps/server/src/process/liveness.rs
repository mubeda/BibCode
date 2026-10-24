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
    running_among(
        pids,
        |pid| {
            system
                .process(Pid::from_u32(pid))
                .map(|process| process.status() != ProcessStatus::Zombie)
        },
        exists_uninspected,
    )
}

/// `inspect` answers from the process table, `None` when the table has no entry. The table
/// leaves out a process this user may not inspect (a root process, or any other user's under a
/// restricted `/proc`), so such a PID is asked about directly before it counts as exited.
fn running_among(
    pids: HashSet<u32>,
    inspect: impl Fn(u32) -> Option<bool>,
    exists: impl Fn(u32) -> bool,
) -> HashSet<u32> {
    pids.into_iter()
        .filter(|&pid| inspect(pid).unwrap_or_else(|| exists(pid)))
        .collect()
}

/// Whether a process the table did not list exists: signal zero checks it without delivering a
/// signal, and a refusal means it exists under another user.
#[cfg(unix)]
fn exists_uninspected(pid: u32) -> bool {
    // Zero and negative PIDs name process groups.
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal zero performs only the existence and permission checks.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows' process table lists every process, whatever its owner.
#[cfg(not(unix))]
fn exists_uninspected(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{running_among, running_processes};

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

    #[test]
    fn a_pid_the_process_table_leaves_out_runs_while_it_exists() {
        let pids = HashSet::from([7, 8, 9]);
        // 7 is a zombie, 8 is listed and running, 9 is unlisted but exists.
        let inspect = |pid| match pid {
            7 => Some(false),
            8 => Some(true),
            _ => None,
        };
        assert_eq!(
            running_among(pids.clone(), inspect, |_| true),
            HashSet::from([8, 9])
        );
        assert_eq!(running_among(pids, inspect, |_| false), HashSet::from([8]));
    }

    /// The process table omits a process this user may not inspect, such as a root process
    /// (PID 1 here) or one hidden by a restricted `/proc`; it is still running.
    #[cfg(unix)]
    #[test]
    fn a_process_this_user_cannot_inspect_still_runs() {
        assert!(running_processes([1]).contains(&1));
    }
}
