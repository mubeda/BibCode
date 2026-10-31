//! Workspace file operations bound to a directory handle (#139, slice X5).
//!
//! A workspace path is checked by canonicalizing it and confirming it stays under the
//! canonical root, and then it is used. Between the two, a folder on the path can be swapped
//! for a symlink that leads outside, and an operation by path would follow it.
//!
//! On Unix, [`Dir::open`] walks the *canonical* folder from the canonical root one component
//! at a time with `O_DIRECTORY | O_NOFOLLOW`. The canonical path has no symlink in it, so
//! meeting one means the tree changed since the check, and the walk refuses with
//! [`is_escape`]. The entry itself is then reached by name through the held handle (`openat`,
//! `mkdirat`, `unlinkat`, `renameat`), so a later swap of the path cannot redirect it.
//!
//! Elsewhere, and for the two operations that take a path rather than a handle (the system
//! trash and a folder's recursive removal), the folder is canonicalized again just before the
//! call and must not have moved. The window left there is the call resolving the path. A
//! recursive removal first renames the folder, through the handle, to a fresh random name, so
//! a swap after that rename sends the removal to a name that does not exist.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

/// What is at a name in a folder, without following a symlink.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Kind {
    Missing,
    File,
    Directory,
    Symlink,
    Other,
}

/// How [`Dir::open_file`] opens an entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Open {
    Read,
    /// Create or truncate.
    Write,
    /// Create; refused when anything is at the name.
    CreateNew,
}

const ESCAPE_MESSAGE: &str = "a folder on the path changed into a symlink while BiBCode used it";

fn escape() -> io::Error {
    io::Error::other(ESCAPE_MESSAGE)
}

/// Whether `error` is a walk or re-check that found the tree changed under it.
pub(crate) fn is_escape(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Other && error.to_string() == ESCAPE_MESSAGE
}

/// A folder under a workspace root, held open.
pub(crate) struct Dir {
    path: PathBuf,
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
}

impl Dir {
    /// Opens `folder`, which is `root` or below it (both canonical), without following any
    /// symlink below `root`. With `create`, missing folders are created on the way.
    pub(crate) fn open(root: &Path, folder: &Path, create: bool) -> io::Result<Self> {
        let relative = folder.strip_prefix(root).map_err(|_| escape())?;
        let mut names = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(name) => names.push(name),
                Component::CurDir => {}
                _ => return Err(escape()),
            }
        }
        imp::open(root, folder, &names, create)
    }

    /// What is at `name`, without following a symlink.
    pub(crate) fn kind(&self, name: &OsStr) -> io::Result<Kind> {
        imp::kind(self, name)
    }

    /// Opens `name` without following a symlink at it. A read or write of a named pipe does
    /// not block; the caller checks the file is a regular one.
    pub(crate) fn open_file(&self, name: &OsStr, open: Open) -> io::Result<File> {
        imp::open_file(self, name, open)
    }

    /// Removes the file or symlink at `name`.
    pub(crate) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        imp::remove_file(self, name)
    }

    /// Moves `name` to `to_name` in `to`, both through their handles.
    pub(crate) fn rename(&self, name: &OsStr, to: &Self, to_name: &OsStr) -> io::Result<()> {
        imp::rename(self, name, to, to_name)
    }

    /// Fails with [`is_escape`] unless the folder's path still resolves to itself.
    pub(crate) fn recheck(&self) -> io::Result<()> {
        match std::fs::canonicalize(&self.path) {
            Ok(path) if path == self.path => Ok(()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Err(escape()),
        }
    }

    /// The path of `name` in this folder, after [`Self::recheck`], for a call that takes a
    /// path (the system trash). Windows gets it without the `\\?\` prefix the Recycle Bin
    /// refuses.
    pub(crate) fn checked_path(&self, name: &OsStr) -> io::Result<PathBuf> {
        self.recheck()?;
        Ok(crate::git::without_verbatim_prefix(self.path.join(name)))
    }

    /// Removes the folder `name` and everything in it. It is first renamed through the handle
    /// to a fresh name, then removed by path after a re-check; a removal that fails part-way
    /// puts what is left back under its name.
    pub(crate) fn remove_dir_all(&self, name: &OsStr) -> io::Result<()> {
        let parked =
            std::ffi::OsString::from(format!(".bibcode-delete-{}", uuid::Uuid::new_v4().simple()));
        self.rename(name, self, &parked)?;
        let removed = self
            .recheck()
            .and_then(|()| std::fs::remove_dir_all(self.path.join(&parked)));
        if let Err(error) = removed {
            let _ = self.rename(&parked, self, name);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::{CString, OsStr};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use super::{Dir, Kind, Open, escape};

    fn c_name(name: &OsStr) -> io::Result<CString> {
        if name.is_empty() || name.as_bytes().contains(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a single path component",
            ));
        }
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a name holds NUL"))
    }

    fn check(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }

    const DIRECTORY_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    fn open_child(parent: &OwnedFd, name: &OsStr) -> io::Result<OwnedFd> {
        let c = c_name(name)?;
        // SAFETY: `c` is a NUL-terminated name and `parent` an open descriptor.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c.as_ptr(), DIRECTORY_FLAGS) };
        if fd >= 0 {
            // SAFETY: `openat` returned a new descriptor this call owns.
            return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
        }
        let error = io::Error::last_os_error();
        // A symlink where a folder was: `ELOOP`, or `ENOTDIR` on some systems.
        if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
            && kind_at(parent, name)? == Kind::Symlink
        {
            return Err(escape());
        }
        Err(error)
    }

    pub(super) fn open(
        root: &Path,
        folder: &Path,
        names: &[&OsStr],
        create: bool,
    ) -> io::Result<Dir> {
        let c_root = CString::new(root.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a path holds NUL"))?;
        // The root is canonical and is the boundary: a symlink in its own path is the
        // workspace's location, not an escape from it.
        // SAFETY: `c_root` is NUL-terminated.
        let fd = check(unsafe {
            libc::open(
                c_root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        // SAFETY: `open` returned a new descriptor this call owns.
        let mut fd = unsafe { OwnedFd::from_raw_fd(fd) };
        for name in names {
            fd = match open_child(&fd, name) {
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    match create_at(&fd, name) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(error),
                    }
                    open_child(&fd, name)?
                }
                other => other?,
            };
        }
        Ok(Dir {
            path: folder.to_path_buf(),
            fd,
        })
    }

    fn kind_at(parent: &OwnedFd, name: &OsStr) -> io::Result<Kind> {
        let c = c_name(name)?;
        // SAFETY: zeroed is a valid `stat` to be overwritten.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is NUL-terminated and `stat` a valid out pointer.
        let result = unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                c.as_ptr(),
                &raw mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::NotFound {
                Ok(Kind::Missing)
            } else {
                Err(error)
            };
        }
        Ok(match stat.st_mode & libc::S_IFMT {
            libc::S_IFREG => Kind::File,
            libc::S_IFDIR => Kind::Directory,
            libc::S_IFLNK => Kind::Symlink,
            _ => Kind::Other,
        })
    }

    pub(super) fn kind(dir: &Dir, name: &OsStr) -> io::Result<Kind> {
        kind_at(&dir.fd, name)
    }

    pub(super) fn open_file(dir: &Dir, name: &OsStr, open: Open) -> io::Result<File> {
        let c = c_name(name)?;
        let base = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        let flags = match open {
            Open::Read => libc::O_RDONLY | base,
            Open::Write => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | base,
            Open::CreateNew => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | base,
        };
        // SAFETY: `c` is NUL-terminated; the mode is passed as the variadic `mode_t`.
        let fd = unsafe {
            libc::openat(
                dir.fd.as_raw_fd(),
                c.as_ptr(),
                flags,
                libc::c_uint::from(0o666_u16),
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ELOOP) {
                return Err(escape());
            }
            return Err(error);
        }
        // SAFETY: `openat` returned a new descriptor this call owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        // Blocking again for regular files, which `O_NONBLOCK` never affected anyway.
        // SAFETY: `fd` is open.
        let status = check(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) })?;
        // SAFETY: `fd` is open.
        check(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, status & !libc::O_NONBLOCK) })?;
        Ok(File::from(fd))
    }

    fn create_at(parent: &OwnedFd, name: &OsStr) -> io::Result<()> {
        let c = c_name(name)?;
        // SAFETY: `c` is NUL-terminated.
        check(unsafe { libc::mkdirat(parent.as_raw_fd(), c.as_ptr(), 0o777) }).map(|_| ())
    }

    pub(super) fn remove_file(dir: &Dir, name: &OsStr) -> io::Result<()> {
        let c = c_name(name)?;
        // SAFETY: `c` is NUL-terminated.
        check(unsafe { libc::unlinkat(dir.fd.as_raw_fd(), c.as_ptr(), 0) }).map(|_| ())
    }

    pub(super) fn rename(dir: &Dir, name: &OsStr, to: &Dir, to_name: &OsStr) -> io::Result<()> {
        let (from, target) = (c_name(name)?, c_name(to_name)?);
        // SAFETY: both names are NUL-terminated and both descriptors open.
        check(unsafe {
            libc::renameat(
                dir.fd.as_raw_fd(),
                from.as_ptr(),
                to.fd.as_raw_fd(),
                target.as_ptr(),
            )
        })
        .map(|_| ())
    }
}

/// Without `*at` calls, every operation re-checks the folder and then works by path.
#[cfg(not(unix))]
mod imp {
    use std::ffi::OsStr;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::path::Path;

    use super::{Dir, Kind, Open};

    pub(super) fn open(
        root: &Path,
        folder: &Path,
        names: &[&OsStr],
        create: bool,
    ) -> io::Result<Dir> {
        let mut path = root.to_path_buf();
        for name in names {
            path.push(name);
            if create && !path.exists() {
                match std::fs::create_dir(&path) {
                    Err(error) if error.kind() != io::ErrorKind::AlreadyExists => {
                        return Err(error);
                    }
                    _ => {}
                }
            }
        }
        let dir = Dir {
            path: folder.to_path_buf(),
        };
        dir.recheck()?;
        Ok(dir)
    }

    pub(super) fn kind(dir: &Dir, name: &OsStr) -> io::Result<Kind> {
        dir.recheck()?;
        match std::fs::symlink_metadata(dir.path.join(name)) {
            Ok(metadata) if metadata.file_type().is_symlink() => Ok(Kind::Symlink),
            Ok(metadata) if metadata.is_dir() => Ok(Kind::Directory),
            Ok(metadata) if metadata.is_file() => Ok(Kind::File),
            Ok(_) => Ok(Kind::Other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Kind::Missing),
            Err(error) => Err(error),
        }
    }

    pub(super) fn open_file(dir: &Dir, name: &OsStr, open: Open) -> io::Result<File> {
        dir.recheck()?;
        let path = dir.path.join(name);
        match open {
            Open::Read => File::open(path),
            Open::Write => File::create(path),
            Open::CreateNew => OpenOptions::new().write(true).create_new(true).open(path),
        }
    }

    pub(super) fn remove_file(dir: &Dir, name: &OsStr) -> io::Result<()> {
        dir.recheck()?;
        std::fs::remove_file(dir.path.join(name))
    }

    pub(super) fn rename(dir: &Dir, name: &OsStr, to: &Dir, to_name: &OsStr) -> io::Result<()> {
        dir.recheck()?;
        to.recheck()?;
        std::fs::rename(dir.path.join(name), to.path.join(to_name))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_walk_refuses_a_symlinked_folder_and_works_by_name_through_the_handle() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root_path = std::fs::canonicalize(root.path()).unwrap();
        std::fs::create_dir(root_path.join("real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root_path.join("link")).unwrap();

        let error = Dir::open(&root_path, &root_path.join("link"), false)
            .err()
            .expect("a symlinked folder is refused");
        assert!(is_escape(&error), "{error}");
        let error = Dir::open(&root_path, &root_path.join("link/new"), true)
            .err()
            .expect("creating through a symlink is refused");
        assert!(is_escape(&error), "{error}");
        assert!(Dir::open(&root_path, outside.path(), false).is_err());

        let dir = Dir::open(&root_path, &root_path.join("real/new/deeper"), true).unwrap();
        std::io::Write::write_all(
            &mut dir.open_file(OsStr::new("a.txt"), Open::CreateNew).unwrap(),
            b"one",
        )
        .unwrap();
        assert!(dir.open_file(OsStr::new("a.txt"), Open::CreateNew).is_err());
        assert_eq!(dir.kind(OsStr::new("a.txt")).unwrap(), Kind::File);
        // Moving the folder away after it was opened does not redirect the handle.
        std::fs::rename(root_path.join("real"), root_path.join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root_path.join("real")).unwrap();
        dir.rename(OsStr::new("a.txt"), &dir, OsStr::new("b.txt"))
            .unwrap();
        assert!(root_path.join("moved/new/deeper/b.txt").exists());
        assert!(!outside.path().join("b.txt").exists());
        assert!(is_escape(&dir.recheck().unwrap_err()));
        dir.remove_file(OsStr::new("b.txt")).unwrap();
        assert_eq!(dir.kind(OsStr::new("b.txt")).unwrap(), Kind::Missing);
        // A symlink at the name is not followed.
        let top = Dir::open(&root_path, &root_path, false).unwrap();
        assert_eq!(top.kind(OsStr::new("link")).unwrap(), Kind::Symlink);
        assert!(is_escape(
            &top.open_file(OsStr::new("link"), Open::Read).unwrap_err()
        ));
    }

    #[test]
    fn a_folder_is_removed_whole_under_a_parked_name() {
        let root = tempfile::tempdir().unwrap();
        let root_path = std::fs::canonicalize(root.path()).unwrap();
        std::fs::create_dir_all(root_path.join("victim/inner")).unwrap();
        std::fs::write(root_path.join("victim/inner/file"), "x").unwrap();
        let dir = Dir::open(&root_path, &root_path, false).unwrap();
        dir.remove_dir_all(OsStr::new("victim")).unwrap();
        assert_eq!(std::fs::read_dir(&root_path).unwrap().count(), 0);
    }
}
