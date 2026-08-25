use std::{
    fs, io,
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixStream as StdUnixStream,
    },
    path::{Path, PathBuf},
};

use thiserror::Error;
use tokio::{net::UnixListener, task::JoinSet};
use tokio_util::sync::CancellationToken;

use crate::persistence::StatePaths;

use super::{
    CONNECTION_DRAIN_TIMEOUT, ControlDispatcher, LocalControlError, MAX_CONTROL_CONNECTIONS,
    serve_stream,
};

#[derive(Debug, Error)]
pub enum UnixControlError {
    #[error("the control directory is not a secure directory owned by the service user")]
    InsecureDirectory,
    #[error("the existing control endpoint is not a socket owned by the service user")]
    UntrustedEndpoint,
    #[error("another BiBCode control endpoint is already active")]
    EndpointInUse,
    #[error("the local control endpoint could not be prepared")]
    Io(#[source] io::Error),
}

#[derive(Clone, Copy)]
struct SocketIdentity {
    device: u64,
    inode: u64,
    uid: u32,
}

pub(crate) struct UnixControlEndpoint {
    listener: UnixListener,
    socket_path: PathBuf,
    identity: SocketIdentity,
    service_uid: u32,
    allow_root_administration: bool,
}

impl UnixControlEndpoint {
    pub(crate) fn bind(
        paths: &StatePaths,
        allow_root_administration: bool,
    ) -> Result<Self, UnixControlError> {
        // SAFETY: `geteuid` has no preconditions and does not retain pointers.
        let service_uid = unsafe { libc::geteuid() };
        prepare_control_directory(&paths.run_dir, service_uid)?;
        remove_verified_stale_socket(&paths.control_socket, service_uid)?;

        let listener = UnixListener::bind(&paths.control_socket).map_err(UnixControlError::Io)?;
        if let Err(error) =
            fs::set_permissions(&paths.control_socket, fs::Permissions::from_mode(0o600))
        {
            drop(listener);
            let _ = fs::remove_file(&paths.control_socket);
            return Err(UnixControlError::Io(error));
        }
        let metadata = fs::symlink_metadata(&paths.control_socket).map_err(UnixControlError::Io)?;
        let identity = SocketIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
        };
        Ok(Self {
            listener,
            socket_path: paths.control_socket.clone(),
            identity,
            service_uid,
            allow_root_administration,
        })
    }

    pub(crate) async fn serve(
        self,
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
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted
                        .map_err(|error| LocalControlError::Serve(error.to_string()))?;
                    let credentials = match stream.peer_cred() {
                        Ok(credentials) => credentials,
                        Err(_) => continue,
                    };
                    if !peer_is_authorized(
                        self.service_uid,
                        credentials.uid(),
                        self.allow_root_administration,
                    ) {
                        continue;
                    }
                    if connections.len() >= MAX_CONTROL_CONNECTIONS {
                        continue;
                    }
                    let connection_dispatcher = dispatcher.clone();
                    let connection_local_shutdown = local_shutdown.clone();
                    let connection_main_shutdown = main_shutdown.clone();
                    connections.spawn(async move {
                        serve_stream(
                            stream,
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

impl Drop for UnixControlEndpoint {
    fn drop(&mut self) {
        remove_socket_if_owned(&self.socket_path, self.identity);
    }
}

#[doc(hidden)]
#[must_use]
pub const fn peer_is_authorized(
    service_uid: u32,
    peer_uid: u32,
    allow_root_administration: bool,
) -> bool {
    peer_uid == service_uid || (peer_uid == 0 && allow_root_administration)
}

fn prepare_control_directory(path: &Path, service_uid: u32) -> Result<(), UnixControlError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_control_directory(&metadata, service_uid),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(path) {
                Ok(()) => {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                        .map_err(UnixControlError::Io)?;
                    let metadata = fs::symlink_metadata(path).map_err(UnixControlError::Io)?;
                    validate_control_directory(&metadata, service_uid)
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(path).map_err(UnixControlError::Io)?;
                    validate_control_directory(&metadata, service_uid)
                }
                Err(error) => Err(UnixControlError::Io(error)),
            }
        }
        Err(error) => Err(UnixControlError::Io(error)),
    }
}

fn validate_control_directory(
    metadata: &fs::Metadata,
    service_uid: u32,
) -> Result<(), UnixControlError> {
    if !metadata.file_type().is_dir()
        || metadata.uid() != service_uid
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(UnixControlError::InsecureDirectory);
    }
    Ok(())
}

fn remove_verified_stale_socket(path: &Path, service_uid: u32) -> Result<(), UnixControlError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(UnixControlError::Io(error)),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != service_uid {
        return Err(UnixControlError::UntrustedEndpoint);
    }
    let expected = SocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
    };
    match StdUnixStream::connect(path) {
        Ok(_) => Err(UnixControlError::EndpointInUse),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            let current = fs::symlink_metadata(path).map_err(UnixControlError::Io)?;
            if !same_socket(&current, expected) {
                return Err(UnixControlError::UntrustedEndpoint);
            }
            fs::remove_file(path).map_err(UnixControlError::Io)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(UnixControlError::Io(error)),
    }
}

fn remove_socket_if_owned(path: &Path, expected: SocketIdentity) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if same_socket(&metadata, expected) {
        let _ = fs::remove_file(path);
    }
}

fn same_socket(metadata: &fs::Metadata, expected: SocketIdentity) -> bool {
    metadata.file_type().is_socket()
        && metadata.uid() == expected.uid
        && metadata.dev() == expected.device
        && metadata.ino() == expected.inode
}
