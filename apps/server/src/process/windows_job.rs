use std::{fmt, io, time::Duration};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    },
    System::Threading::{
        GetProcessId, INFINITE, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        WaitForSingleObject,
    },
};

pub(crate) struct WindowsJob(HANDLE);

// SAFETY: a Windows job handle may be used from any thread, and ownership is
// represented by this type's single close-on-drop handle.
unsafe impl Send for WindowsJob {}
// SAFETY: the Win32 operations used here are thread-safe for job handles.
unsafe impl Sync for WindowsJob {}

impl WindowsJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security attributes and name request an unnamed job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(last_os_error());
        }

        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe `information` for the requested
        // `JobObjectExtendedLimitInformation` class.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&information).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = last_os_error();
            // SAFETY: `handle` was created above and is still owned here.
            unsafe { CloseHandle(handle) };
            return Err(error);
        }

        Ok(Self(handle))
    }

    pub(crate) fn raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0.cast()
    }

    pub(crate) fn assign_process(
        &self,
        process_handle: std::os::windows::io::RawHandle,
    ) -> io::Result<()> {
        // SAFETY: both handles are live for this call, and the process is still
        // suspended so it cannot create an unsupervised descendant first.
        if unsafe { AssignProcessToJobObject(self.0, process_handle.cast()) } == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }

    pub(crate) fn resume_process_threads(
        process_handle: std::os::windows::io::RawHandle,
    ) -> io::Result<()> {
        // SAFETY: the raw handle belongs to the live child process being prepared.
        let process_id = unsafe { GetProcessId(process_handle.cast()) };
        if process_id == 0 {
            return Err(last_os_error());
        }
        // SAFETY: the snapshot has no caller-owned buffers and is closed below.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(last_os_error());
        }

        let result = resume_process_threads_from_snapshot(snapshot, process_id);
        // SAFETY: this function owns the snapshot handle exactly once.
        unsafe { CloseHandle(snapshot) };
        result
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        // SAFETY: `self.0` remains a live job handle for this object's lifetime.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(last_os_error())
        } else {
            Ok(())
        }
    }

    pub(crate) fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: `self.0` remains a live job handle for this object's lifetime.
        match unsafe { WaitForSingleObject(self.0, timeout_ms) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(last_os_error()),
        }
    }

    pub(crate) fn wait_for_exit_unbounded(&self) -> io::Result<()> {
        // SAFETY: `self.0` remains a live job handle for this object's lifetime.
        match unsafe { WaitForSingleObject(self.0, INFINITE) } {
            WAIT_OBJECT_0 => Ok(()),
            _ => Err(last_os_error()),
        }
    }
}

impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: this type owns the handle and closes it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

impl fmt::Debug for WindowsJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("WindowsJob").field(&self.0).finish()
    }
}

fn last_os_error() -> io::Error {
    // SAFETY: GetLastError has no preconditions and reads thread-local state.
    io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

fn resume_process_threads_from_snapshot(snapshot: HANDLE, process_id: u32) -> io::Result<()> {
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(std::mem::size_of::<THREADENTRY32>())
            .expect("THREADENTRY32 size fits in u32"),
        ..THREADENTRY32::default()
    };
    // SAFETY: `entry` has the required size and `snapshot` is a live thread snapshot.
    let mut available = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while available {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: the thread identifier came from the live snapshot.
            let thread =
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false.into(), entry.th32ThreadID) };
            if thread.is_null() {
                return Err(last_os_error());
            }
            // SAFETY: `thread` was opened with resume permission and is closed below.
            let resume_result = unsafe { ResumeThread(thread) };
            // SAFETY: this scope owns the opened thread handle exactly once.
            unsafe { CloseHandle(thread) };
            if resume_result == u32::MAX {
                return Err(last_os_error());
            }
            return Ok(());
        }
        // SAFETY: the same initialized entry and live snapshot remain valid.
        available = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("suspended process {process_id} had no resumable thread"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_handle_creation_debug_and_termination_are_operational() {
        let job = WindowsJob::new().expect("job should be created");
        assert!(format!("{job:?}").starts_with("WindowsJob("));
        assert!(!job.raw_handle().is_null());
        job.terminate().expect("job should terminate");
        assert!(
            job.wait_for_exit(Duration::ZERO)
                .expect("empty job should be waitable")
        );

        let _ = last_os_error();
    }
}
