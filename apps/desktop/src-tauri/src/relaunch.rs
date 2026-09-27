//! Keeps an AppImage relaunch from inheriting the old runtime's keep-alive pipe.

/// Marks every descriptor above stderr close-on-exec before relaunch.
/// A no-op outside Linux; only exec'd children lose the descriptors.
pub(crate) fn prepare_descriptors_for_relaunch() {
    #[cfg(target_os = "linux")]
    linux::mark_inherited_descriptors_close_on_exec();
}

#[cfg(target_os = "linux")]
mod linux {
    const FIRST_INHERITED_DESCRIPTOR: libc::c_uint = 3;

    pub(super) fn mark_inherited_descriptors_close_on_exec() {
        // Use syscall so CLOSE_RANGE_CLOEXEC does not depend on the build host's glibc.
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                FIRST_INHERITED_DESCRIPTOR,
                libc::c_uint::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            )
        };
        if result == 0 {
            return;
        }

        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
            tracing::warn!(%error, "close_range could not mark descriptors close-on-exec");
        }
        mark_through_proc();
    }

    pub(super) fn mark_through_proc() {
        let entries = match std::fs::read_dir("/proc/self/fd") {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(%error, "could not list descriptors before relaunch");
                return;
            }
        };
        // Collect first: the directory handle is itself a descriptor.
        let descriptors = entries
            .filter_map(|entry| match entry {
                Ok(entry) => entry.file_name().to_str()?.parse::<libc::c_int>().ok(),
                Err(error) => {
                    tracing::warn!(%error, "could not read a descriptor entry before relaunch");
                    None
                }
            })
            .filter(|fd| *fd >= FIRST_INHERITED_DESCRIPTOR as libc::c_int)
            .collect::<Vec<_>>();
        for fd in descriptors {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags == -1 {
                let error = std::io::Error::last_os_error();
                // A descriptor can close since the listing, including the directory handle.
                if error.raw_os_error() != Some(libc::EBADF) {
                    tracing::warn!(fd, %error, "could not read descriptor flags before relaunch");
                }
                continue;
            }
            if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
                let error = std::io::Error::last_os_error();
                tracing::warn!(fd, %error, "could not mark a descriptor close-on-exec");
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::process::Command;

    fn inherited_pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        // A plain pipe(2) has no close-on-exec, like the runtime's keep-alive pipe.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe returned two new descriptors, each with a single owner.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn has_cloexec(fd: libc::c_int) -> bool {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_ne!(flags, -1, "F_GETFD failed");
        flags & libc::FD_CLOEXEC != 0
    }

    #[test]
    fn an_inherited_pipe_is_marked_close_on_exec_and_a_spawned_child_lacks_it() {
        let Some(isolated) = crate::test_support::isolated_scenario(
            "relaunch::tests::an_inherited_pipe_is_marked_close_on_exec_and_a_spawned_child_lacks_it",
        ) else {
            return;
        };

        let (read_end, write_end) = inherited_pipe();
        assert!(!has_cloexec(read_end.as_raw_fd()));
        assert!(!has_cloexec(write_end.as_raw_fd()));
        assert!(!has_cloexec(std::io::stdin().as_raw_fd()));

        super::prepare_descriptors_for_relaunch();

        assert!(
            has_cloexec(read_end.as_raw_fd()),
            "read end must be close-on-exec"
        );
        assert!(
            has_cloexec(write_end.as_raw_fd()),
            "write end must be close-on-exec"
        );
        assert!(
            !has_cloexec(std::io::stdin().as_raw_fd()),
            "stdio stays inheritable"
        );

        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("test -e /proc/self/fd/{}", write_end.as_raw_fd()))
            .status()
            .expect("sh should spawn");
        assert!(!status.success(), "the child must not inherit the pipe");
        isolated.complete();
    }

    #[test]
    fn proc_fallback_marks_both_pipe_ends_close_on_exec() {
        let Some(isolated) = crate::test_support::isolated_scenario(
            "relaunch::tests::proc_fallback_marks_both_pipe_ends_close_on_exec",
        ) else {
            return;
        };

        let (read_end, write_end) = inherited_pipe();
        assert!(!has_cloexec(read_end.as_raw_fd()));
        assert!(!has_cloexec(write_end.as_raw_fd()));

        super::linux::mark_through_proc();

        assert!(
            has_cloexec(read_end.as_raw_fd()),
            "read end must be close-on-exec"
        );
        assert!(
            has_cloexec(write_end.as_raw_fd()),
            "write end must be close-on-exec"
        );
        assert!(
            !has_cloexec(std::io::stdin().as_raw_fd()),
            "stdio stays inheritable"
        );
        isolated.complete();
    }
}
