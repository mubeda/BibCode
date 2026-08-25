use std::{ffi::c_void, io, os::windows::io::AsRawHandle, ptr};

use thiserror::Error;
use tokio::{
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        CheckTokenMembership, CreateWellKnownSid, GetTokenInformation, PSID, RevertToSelf,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid,
    },
    System::{
        Pipes::ImpersonateNamedPipeClient,
        Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
    },
};

use crate::persistence::EnvironmentId;

use super::{
    CONNECTION_DRAIN_TIMEOUT, ControlDispatcher, LocalControlError, MAX_CONTROL_CONNECTIONS,
    serve_stream,
};

#[derive(Debug, Error)]
pub enum WindowsControlError {
    #[error("the protected named pipe could not be prepared")]
    Io(#[source] io::Error),
}

pub(crate) struct WindowsControlEndpoint {
    name: String,
    pending: NamedPipeServer,
    service_user_sid: String,
}

impl WindowsControlEndpoint {
    pub(crate) fn bind(environment_id: EnvironmentId) -> Result<Self, WindowsControlError> {
        let name = pipe_name(environment_id);
        let service_user_sid = current_process_user_sid().map_err(WindowsControlError::Io)?;
        let pending =
            create_pipe(&name, &service_user_sid, true).map_err(WindowsControlError::Io)?;
        Ok(Self {
            name,
            pending,
            service_user_sid,
        })
    }

    pub(crate) async fn serve(
        mut self,
        dispatcher: ControlDispatcher,
        local_shutdown: CancellationToken,
        main_shutdown: CancellationToken,
    ) -> Result<(), LocalControlError> {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                () = local_shutdown.cancelled() => break,
                () = main_shutdown.cancelled() => break,
                connected = self.pending.connect() => {
                    connected.map_err(|error| LocalControlError::Serve(error.to_string()))?;
                    let connected = self.pending;
                    self.pending = create_pipe(&self.name, &self.service_user_sid, false)
                        .map_err(|error| LocalControlError::Serve(error.to_string()))?;
                    if connections.len() >= MAX_CONTROL_CONNECTIONS {
                        continue;
                    }
                    if !verify_connected_client(&connected, &self.service_user_sid)
                        .map_err(|error| LocalControlError::Serve(error.to_string()))?
                    {
                        continue;
                    }
                    let connection_dispatcher = dispatcher.clone();
                    let connection_local_shutdown = local_shutdown.clone();
                    let connection_main_shutdown = main_shutdown.clone();
                    connections.spawn(async move {
                        serve_stream(
                            connected,
                            connection_dispatcher,
                            connection_local_shutdown,
                            connection_main_shutdown,
                        )
                        .await;
                    });
                }
            }
            while connections.try_join_next().is_some() {}
        }

        let _ = tokio::time::timeout(CONNECTION_DRAIN_TIMEOUT, async {
            while connections.join_next().await.is_some() {}
        })
        .await;
        Ok(())
    }
}

#[doc(hidden)]
#[must_use]
pub fn pipe_name(environment_id: EnvironmentId) -> String {
    format!(r"\\.\pipe\bibcode-{environment_id}")
}

#[doc(hidden)]
#[must_use]
pub const fn client_is_authorized(
    same_service_user: bool,
    builtin_administrator: bool,
    remote_client: bool,
) -> bool {
    !remote_client && (same_service_user || builtin_administrator)
}

fn create_pipe(name: &str, service_user_sid: &str, first: bool) -> io::Result<NamedPipeServer> {
    let mut descriptor = PipeSecurityDescriptor::new(service_user_sid)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(std::mem::size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| io::Error::other("Windows security attributes size overflow"))?,
        lpSecurityDescriptor: descriptor.as_mut_ptr(),
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .in_buffer_size(u32::try_from(super::protocol::MAX_CONTROL_FRAME_BYTES).unwrap_or(u32::MAX))
        .out_buffer_size(
            u32::try_from(super::protocol::MAX_CONTROL_FRAME_BYTES).unwrap_or(u32::MAX),
        );
    // SAFETY: `attributes` and its descriptor remain valid for the complete creation call. Tokio
    // passes the pointer directly to CreateNamedPipeW and does not retain it.
    unsafe {
        options.create_with_security_attributes_raw(
            name,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
}

fn verify_connected_client(pipe: &NamedPipeServer, service_user_sid: &str) -> io::Result<bool> {
    let handle = pipe.as_raw_handle().cast::<c_void>();
    // SAFETY: The handle belongs to the connected server end of this named pipe.
    if unsafe { ImpersonateNamedPipeClient(handle) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let result = (|| {
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: The current thread is impersonating the connected client and `token` is a valid
        // output pointer. `open_as_self` uses the service identity for the handle access check but
        // still returns the client's impersonation token.
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        let client_sid = token_user_sid_string(token.0)?;
        let administrator_sid = well_known_sid(WinBuiltinAdministratorsSid)?;
        let mut is_administrator = 0;
        // SAFETY: The token and SID are valid for the duration of the membership check.
        if unsafe {
            CheckTokenMembership(token.0, administrator_sid.as_psid(), &mut is_administrator)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(client_is_authorized(
            client_sid == service_user_sid,
            is_administrator != 0,
            false,
        ))
    })();

    // SAFETY: This call is paired with the successful impersonation above and occurs before any
    // await point. Continuing with an impersonated Tokio worker would cross a security boundary,
    // so a failure is fail-stop.
    if unsafe { RevertToSelf() } == 0 {
        std::process::abort();
    }
    result
}

fn current_process_user_sid() -> io::Result<String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: The current process pseudo-handle is valid and `token` is a valid output pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    token_user_sid_string(token.0)
}

fn token_user_sid_string(token: HANDLE) -> io::Result<String> {
    let mut required_bytes = 0_u32;
    // SAFETY: This is the documented sizing call with no destination buffer.
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required_bytes);
    }
    if required_bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = AlignedBuffer::new(required_bytes)?;
    // SAFETY: The aligned buffer contains at least `required_bytes` writable bytes.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr(),
            required_bytes,
            &mut required_bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: A successful TokenUser query initializes TOKEN_USER at the buffer start.
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    sid_to_string(sid)
}

fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut wide = ptr::null_mut();
    // SAFETY: `sid` points into a live token buffer and `wide` is a valid output pointer.
    if unsafe { ConvertSidToStringSidW(sid, &mut wide) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let value = (|| {
        let mut length = 0_usize;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated LocalAlloc string.
        while unsafe { *wide.add(length) } != 0 {
            length = length
                .checked_add(1)
                .ok_or_else(|| io::Error::other("Windows SID string is too long"))?;
        }
        // SAFETY: The scan above established the initialized UTF-16 range.
        String::from_utf16(unsafe { std::slice::from_raw_parts(wide, length) })
            .map_err(|_| io::Error::other("Windows SID string is invalid"))
    })();
    // SAFETY: ConvertSidToStringSidW allocated this pointer with LocalAlloc.
    unsafe {
        LocalFree(wide.cast());
    }
    value
}

fn well_known_sid(kind: i32) -> io::Result<AlignedBuffer> {
    let mut required_bytes = 0_u32;
    // SAFETY: This is the documented sizing call with a null SID destination.
    unsafe {
        CreateWellKnownSid(kind, ptr::null_mut(), ptr::null_mut(), &mut required_bytes);
    }
    if required_bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = AlignedBuffer::new(required_bytes)?;
    // SAFETY: The aligned buffer contains at least `required_bytes` writable bytes.
    if unsafe {
        CreateWellKnownSid(
            kind,
            ptr::null_mut(),
            buffer.as_mut_ptr(),
            &mut required_bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

struct PipeSecurityDescriptor(*mut c_void);

impl PipeSecurityDescriptor {
    fn new(service_user_sid: &str) -> io::Result<Self> {
        let sddl = format!("D:P(D;;GA;;;NU)(A;;GA;;;{service_user_sid})(A;;GA;;;BA)");
        let wide = sddl
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut descriptor = ptr::null_mut();
        // SAFETY: The SDDL is NUL-terminated and `descriptor` is a valid output pointer.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(descriptor.cast()))
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.0
    }
}

impl Drop for PipeSecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: The conversion function allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: This wrapper only stores owned handles returned by Open*Token.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct AlignedBuffer(Vec<usize>);

impl AlignedBuffer {
    fn new(byte_length: u32) -> io::Result<Self> {
        let word_bytes = std::mem::size_of::<usize>();
        let word_count = usize::try_from(byte_length)
            .ok()
            .and_then(|bytes| bytes.checked_add(word_bytes - 1))
            .map(|bytes| bytes / word_bytes)
            .ok_or_else(|| io::Error::other("Windows security buffer is too large"))?;
        Ok(Self(vec![0_usize; word_count]))
    }

    fn as_ptr(&self) -> *const c_void {
        self.0.as_ptr().cast()
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.0.as_mut_ptr().cast()
    }

    fn as_psid(&self) -> PSID {
        self.as_ptr().cast_mut()
    }
}
