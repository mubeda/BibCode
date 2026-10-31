//! Workspace file operations bound to a directory handle (#139, slice X5).
//!
//! A workspace path is checked by canonicalizing it and confirming it stays under the
//! canonical root, and then it is used. Another process working in the same folder (the
//! provider's own agent, say) can move or swap folders in between, and an operation by path
//! would follow.
//!
//! On Unix:
//!
//! - [`Root::new`] records the canonical root's identity (device and inode) when it is
//!   validated. [`Dir::open`] opens the root with `O_DIRECTORY | O_NOFOLLOW` and refuses it
//!   unless it is still that directory, then walks the *canonical* folder one component at a
//!   time with `O_DIRECTORY | O_NOFOLLOW`. The canonical path has no symlink in it, so meeting
//!   one means the tree changed since the check, and the walk refuses with [`is_escape`].
//! - The entry is reached by name through the held handle (`openat`, `unlinkat`, `renameat`),
//!   so a later swap of the path cannot redirect it.
//! - A held folder can still be moved somewhere else after it was opened. Right before each
//!   mutating call, [`Dir::contained`] walks `..` from the handle back to the root's identity
//!   and refuses a folder that left it; a rename is checked again afterwards and undone if
//!   either folder left.
//! - A rename that must not replace anything uses the kernel's no-replace rename, and a file
//!   this code created is removed only while it is still the same file ([`Dir::remove_own`]).
//!
//! Elsewhere, and for the two operations that take a path rather than a handle (the system
//! trash and a folder's recursive removal), the folder is canonicalized again just before the
//! call and must not have moved. The window left there is the call resolving the path. A
//! recursive removal first renames the folder, through the handle, to a fresh random name, so
//! a swap after that rename sends the removal to a name that does not exist. On Windows every
//! operation re-checks its folder and works by path, so the outside-agent tools that change
//! files are refused there (`mcp::tools::files`).

use std::ffi::{OsStr, OsString};
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
    /// Read and write an existing file, neither creating nor truncating it.
    Existing,
}

/// Whether a rename may replace what is at its target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Replace {
    Allowed,
    /// Refused with `AlreadyExists` when anything is at the target.
    Never,
}

/// A file's identity: its device and inode. Platforms that report none (Windows, through
/// `std`) give `None`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Identity {
    dev: u64,
    ino: u64,
}

impl Identity {
    /// The identity of an open file.
    pub(crate) fn of(file: &File) -> io::Result<Option<Self>> {
        file.metadata().map(|metadata| Self::of_metadata(&metadata))
    }

    #[cfg(unix)]
    fn of_metadata(metadata: &std::fs::Metadata) -> Option<Self> {
        use std::os::unix::fs::MetadataExt as _;
        Some(Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        })
    }

    #[cfg(not(unix))]
    fn of_metadata(_: &std::fs::Metadata) -> Option<Self> {
        None
    }
}

/// What [`Dir::entry`] found at a name.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Entry {
    pub(crate) kind: Kind,
    pub(crate) len: u64,
    pub(crate) id: Option<Identity>,
}

impl Entry {
    const MISSING: Self = Self {
        kind: Kind::Missing,
        len: 0,
        id: None,
    };
}

const ESCAPE_MESSAGE: &str = "a folder on the path changed into a symlink while BiBCode used it";

fn escape() -> io::Error {
    io::Error::other(ESCAPE_MESSAGE)
}

/// Whether `error` is a walk or re-check that found the tree changed under it.
pub(crate) fn is_escape(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Other && error.to_string() == ESCAPE_MESSAGE
}

/// A canonical workspace root and the identity it had when it was validated.
#[derive(Clone, Debug)]
pub(crate) struct Root {
    path: PathBuf,
    id: Option<Identity>,
}

impl Root {
    /// Records `path` (canonical) as validated now.
    pub(crate) fn new(path: &Path) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_dir() {
            return Err(escape());
        }
        Ok(Self {
            path: path.to_path_buf(),
            id: Identity::of_metadata(&metadata),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// Why [`Dir::remove_dir_all`] did not finish.
#[derive(Debug)]
pub(crate) enum Removal {
    /// Nothing was removed.
    Untouched(io::Error),
    /// The removal stopped part-way; what is left is at `left_at` in the folder (the entry's
    /// own name when it could be put back, else its parked name).
    Partial { error: io::Error, left_at: OsString },
}

/// A folder under a workspace root, held open.
pub(crate) struct Dir {
    path: PathBuf,
    root: Root,
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
}

impl Dir {
    /// Opens `folder`, which is `root` or below it (both canonical), without following any
    /// symlink below `root`. With `create`, missing folders are created on the way.
    pub(crate) fn open(root: &Root, folder: &Path, create: bool) -> io::Result<Self> {
        let relative = folder.strip_prefix(&root.path).map_err(|_| escape())?;
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

    /// The folder `name` in this one, without following a symlink at it.
    pub(crate) fn open_dir(&self, name: &OsStr) -> io::Result<Self> {
        imp::open_dir(self, name)
    }

    /// The names in this folder, without `.` and `..`.
    pub(crate) fn names(&self) -> io::Result<Vec<OsString>> {
        imp::names(self)
    }

    /// What is at `name`, without following a symlink.
    pub(crate) fn kind(&self, name: &OsStr) -> io::Result<Kind> {
        self.entry(name).map(|entry| entry.kind)
    }

    /// What is at `name`, its length and identity, without following a symlink.
    pub(crate) fn entry(&self, name: &OsStr) -> io::Result<Entry> {
        imp::entry(self, name)
    }

    /// Opens `name` without following a symlink at it. A read or write of a named pipe does
    /// not block; the caller checks the file is a regular one. Opening to write first checks
    /// the folder is still under the root.
    pub(crate) fn open_file(&self, name: &OsStr, open: Open) -> io::Result<File> {
        if open != Open::Read {
            self.contained()?;
        }
        imp::open_file(self, name, open)
    }

    /// Removes the file or symlink at `name`, while the folder is still under the root.
    pub(crate) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        self.contained()?;
        imp::remove_file(self, name)
    }

    /// Removes `name` only while it is still the file `id` (and, with `empty`, still empty):
    /// a file this code created and nobody has written or replaced since. Answers whether it
    /// was removed. The check and the unlink are two calls; nothing atomic exists for this.
    /// Where the platform reports no identity (Windows), only the kind and emptiness are
    /// checked.
    pub(crate) fn remove_own(&self, name: &OsStr, id: Option<Identity>, empty: bool) -> bool {
        let Ok(entry) = self.entry(name) else {
            return false;
        };
        let ours = entry.kind == Kind::File && entry.id == id && (!empty || entry.len == 0);
        ours && self.remove_file(name).is_ok()
    }

    /// Moves `name` to `to_name` in `to`, both through their handles. Both folders must be
    /// under the root just before, and still after; a rename that left the root is undone.
    pub(crate) fn rename(
        &self,
        name: &OsStr,
        to: &Self,
        to_name: &OsStr,
        replace: Replace,
    ) -> io::Result<()> {
        self.contained()?;
        to.contained()?;
        imp::rename(self, name, to, to_name, replace)?;
        if self.contained().is_err() || to.contained().is_err() {
            // Put it back where it was taken from; if even that fails it stays inside the
            // moved folder, never written somewhere new.
            let _ = imp::rename(to, to_name, self, name, Replace::Never);
            return Err(escape());
        }
        Ok(())
    }

    /// Fails with [`is_escape`] unless this folder is still under the root: on Unix by its
    /// handle, walking `..` back to the root's identity; elsewhere by its path.
    pub(crate) fn contained(&self) -> io::Result<()> {
        imp::contained(self)
    }

    /// Fails with [`is_escape`] unless the folder's path still resolves to itself and the
    /// folder is still under the root.
    pub(crate) fn recheck(&self) -> io::Result<()> {
        match std::fs::canonicalize(&self.path) {
            Ok(path) if path == self.path => self.contained(),
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
    /// to a fresh name, then removed by path after a re-check. A removal that fails part-way
    /// puts what is left back under its name only if nothing has taken that name since, and
    /// otherwise leaves it at the parked name; either way the caller learns where.
    pub(crate) fn remove_dir_all(&self, name: &OsStr) -> Result<(), Removal> {
        imp::remove_dir_all(self, name)
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    use super::{Dir, Entry, Identity, Kind, Open, Removal, Replace, Root, escape, hooks};

    /// The deepest a folder can sit below the root before [`contained`] gives up.
    const MOST_DEPTH: usize = 4_096;

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

    fn owned(fd: libc::c_int) -> io::Result<OwnedFd> {
        check(fd)?;
        // SAFETY: `fd` is a new descriptor the caller's call just returned.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn identity(fd: &OwnedFd) -> io::Result<Identity> {
        // SAFETY: zeroed is a valid `stat` to be overwritten.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `fd` is open and `stat` a valid out pointer.
        check(unsafe { libc::fstat(fd.as_raw_fd(), &raw mut stat) })?;
        Ok(stat_identity(&stat))
    }

    #[allow(
        clippy::cast_sign_loss,
        clippy::useless_conversion,
        clippy::unnecessary_cast,
        reason = "st_dev is signed on some platforms; std's MetadataExt casts it the same way"
    )]
    fn stat_identity(stat: &libc::stat) -> Identity {
        Identity {
            dev: stat.st_dev as u64,
            ino: stat.st_ino as u64,
        }
    }

    fn open_child(parent: &OwnedFd, name: &OsStr) -> io::Result<OwnedFd> {
        let c = c_name(name)?;
        // SAFETY: `c` is a NUL-terminated name and `parent` an open descriptor.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c.as_ptr(), DIRECTORY_FLAGS) };
        if fd >= 0 {
            return owned(fd);
        }
        let error = io::Error::last_os_error();
        // A symlink where a folder was: `ELOOP`, or `ENOTDIR` on some systems.
        if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
            && entry_at(parent, name)?.kind == Kind::Symlink
        {
            return Err(escape());
        }
        Err(error)
    }

    pub(super) fn open(
        root: &Root,
        folder: &Path,
        names: &[&OsStr],
        create: bool,
    ) -> io::Result<Dir> {
        let c_root = CString::new(root.path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a path holds NUL"))?;
        // The root's own path is the workspace's location; its last component must still be
        // a folder (not a symlink put in its place), and the very folder validated.
        // SAFETY: `c_root` is NUL-terminated.
        let opened = unsafe { libc::open(c_root.as_ptr(), DIRECTORY_FLAGS) };
        let mut fd = match owned(opened) {
            Ok(fd) => fd,
            // A symlink where the root was: `ELOOP`, or `ENOTDIR` with `O_DIRECTORY` on macOS.
            Err(error) if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => {
                return Err(escape());
            }
            Err(error) => return Err(error),
        };
        if Some(identity(&fd)?) != root.id {
            return Err(escape());
        }
        for name in names {
            fd = match open_child(&fd, name) {
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    create_contained(&fd, name, root.id)?;
                    open_child(&fd, name)?
                }
                other => other?,
            };
        }
        Ok(Dir {
            path: folder.to_path_buf(),
            root: root.clone(),
            fd,
        })
    }

    pub(super) fn open_dir(dir: &Dir, name: &OsStr) -> io::Result<Dir> {
        Ok(Dir {
            path: dir.path.join(name),
            root: dir.root.clone(),
            fd: open_child(&dir.fd, name)?,
        })
    }

    pub(super) fn names(dir: &Dir) -> io::Result<Vec<OsString>> {
        names_of(&dir.fd)
    }

    fn names_of(folder: &OwnedFd) -> io::Result<Vec<OsString>> {
        // `fdopendir` takes ownership of its descriptor, so it gets a copy.
        // SAFETY: `folder` is open.
        let copy = owned(unsafe { libc::fcntl(folder.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) })?;
        // SAFETY: `copy` is an open directory descriptor; on success the stream owns it.
        let stream = unsafe { libc::fdopendir(copy.as_raw_fd()) };
        if stream.is_null() {
            return Err(io::Error::last_os_error());
        }
        std::mem::forget(copy);
        // SAFETY: `stream` is a valid open directory stream.
        unsafe { libc::rewinddir(stream) };
        let mut names = Vec::new();
        loop {
            // SAFETY: `stream` is valid until `closedir` below.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            // SAFETY: `readdir` returned a valid entry whose name is NUL-terminated.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let bytes = name.to_bytes();
            if bytes != b"." && bytes != b".." {
                names.push(OsString::from_vec(bytes.to_vec()));
            }
        }
        // SAFETY: `stream` is valid and closed once.
        unsafe { libc::closedir(stream) };
        Ok(names)
    }

    fn entry_at(parent: &OwnedFd, name: &OsStr) -> io::Result<Entry> {
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
                Ok(Entry::MISSING)
            } else {
                Err(error)
            };
        }
        let kind = match stat.st_mode & libc::S_IFMT {
            libc::S_IFREG => Kind::File,
            libc::S_IFDIR => Kind::Directory,
            libc::S_IFLNK => Kind::Symlink,
            _ => Kind::Other,
        };
        Ok(Entry {
            kind,
            len: u64::try_from(stat.st_size).unwrap_or(0),
            id: Some(stat_identity(&stat)),
        })
    }

    pub(super) fn entry(dir: &Dir, name: &OsStr) -> io::Result<Entry> {
        entry_at(&dir.fd, name)
    }

    pub(super) fn contained(dir: &Dir) -> io::Result<()> {
        contained_fd(&dir.fd, dir.root.id)
    }

    /// Whether the folder `held` is still under the root whose identity is `root`: `..` is
    /// walked by handle until the root's identity is met, or the file system's own root.
    fn contained_fd(held: &OwnedFd, root: Option<Identity>) -> io::Result<()> {
        let root = root.ok_or_else(escape)?;
        let mut current = identity(held)?;
        // SAFETY: `held` is open; "." names it.
        let mut fd =
            owned(unsafe { libc::openat(held.as_raw_fd(), c".".as_ptr(), DIRECTORY_FLAGS) })?;
        for _ in 0..MOST_DEPTH {
            if current == root {
                return Ok(());
            }
            // SAFETY: `fd` is open; ".." names its parent.
            let parent = owned(unsafe {
                libc::openat(
                    fd.as_raw_fd(),
                    c"..".as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            })?;
            let above = identity(&parent)?;
            if above == current {
                // The file system's own root, without meeting the workspace root.
                return Err(escape());
            }
            (fd, current) = (parent, above);
        }
        Err(escape())
    }

    pub(super) fn open_file(dir: &Dir, name: &OsStr, open: Open) -> io::Result<File> {
        let c = c_name(name)?;
        let base = libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        let flags = match open {
            Open::Read => libc::O_RDONLY | base,
            Open::Write => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | base,
            Open::CreateNew => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | base,
            Open::Existing => libc::O_RDWR | base,
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
        let fd = owned(fd)?;
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

    /// Creates folder `name` in held folder `parent` only while `parent` is under the root,
    /// checked just before and just after; a folder created in a parent that moved out is
    /// removed again through the parent's handle, and the call refused.
    fn create_contained(parent: &OwnedFd, name: &OsStr, root: Option<Identity>) -> io::Result<()> {
        contained_fd(parent, root)?;
        let created = match create_at(parent, name) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(error),
        };
        #[cfg(test)]
        hooks::after_create(name);
        if contained_fd(parent, root).is_err() {
            if created {
                let c = c_name(name)?;
                // SAFETY: `c` is NUL-terminated and `parent` open.
                unsafe { libc::unlinkat(parent.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) };
            }
            return Err(escape());
        }
        Ok(())
    }

    pub(super) fn remove_file(dir: &Dir, name: &OsStr) -> io::Result<()> {
        let c = c_name(name)?;
        // SAFETY: `c` is NUL-terminated.
        check(unsafe { libc::unlinkat(dir.fd.as_raw_fd(), c.as_ptr(), 0) }).map(|_| ())
    }

    pub(super) fn rename(
        dir: &Dir,
        name: &OsStr,
        to: &Dir,
        to_name: &OsStr,
        replace: Replace,
    ) -> io::Result<()> {
        let (from, target) = (c_name(name)?, c_name(to_name)?);
        let (from_fd, to_fd) = (dir.fd.as_raw_fd(), to.fd.as_raw_fd());
        if replace == Replace::Allowed {
            // SAFETY: both names are NUL-terminated and both descriptors open.
            return check(unsafe {
                libc::renameat(from_fd, from.as_ptr(), to_fd, target.as_ptr())
            })
            .map(|_| ());
        }
        rename_no_replace(dir.fd.as_fd(), &from, to.fd.as_fd(), &target)
    }

    /// Renames `from_name` in `from` to `to_name` in `to`, never over an existing entry, for
    /// every BiBCode caller (the workspace service, uploads, discard staging). The kernel's
    /// no-replace rename is tried first; a file system that does not support it (`EINVAL`,
    /// `ENOSYS`, `ENOTSUP`) gets a hard link, which refuses an existing target by construction,
    /// then the source name removed. A folder cannot be linked, so there it is refused with
    /// [`NO_REPLACE_UNSUPPORTED`].
    pub(crate) fn rename_no_replace(
        from: BorrowedFd<'_>,
        from_name: &CStr,
        to: BorrowedFd<'_>,
        to_name: &CStr,
    ) -> io::Result<()> {
        let native = if hooks::link_fallback_forced() {
            Err(io::Error::from_raw_os_error(libc::EINVAL))
        } else {
            native_no_replace(from.as_raw_fd(), from_name, to.as_raw_fd(), to_name)
        };
        match native {
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EINVAL | libc::ENOSYS | libc::ENOTSUP | libc::EOPNOTSUPP)
                ) =>
            {
                link_no_replace(from, from_name, to, to_name)
            }
            other => other,
        }
    }

    /// The refusal of a no-replace rename of a folder on a file system without the kernel's
    /// no-replace rename.
    pub(crate) const NO_REPLACE_UNSUPPORTED: &str =
        "this file system cannot rename a folder without the risk of replacing another";

    fn link_no_replace(
        from: BorrowedFd<'_>,
        from_name: &CStr,
        to: BorrowedFd<'_>,
        to_name: &CStr,
    ) -> io::Result<()> {
        // SAFETY: zeroed is a valid `stat` to be overwritten.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `from_name` is NUL-terminated and `stat` a valid out pointer.
        check(unsafe {
            libc::fstatat(
                from.as_raw_fd(),
                from_name.as_ptr(),
                &raw mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        })?;
        if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                NO_REPLACE_UNSUPPORTED,
            ));
        }
        // SAFETY: both names are NUL-terminated and both descriptors open; flag 0 links a
        // symlink itself, never its target.
        check(unsafe {
            libc::linkat(
                from.as_raw_fd(),
                from_name.as_ptr(),
                to.as_raw_fd(),
                to_name.as_ptr(),
                0,
            )
        })?;
        // SAFETY: `from_name` is NUL-terminated and `from` open.
        check(unsafe { libc::unlinkat(from.as_raw_fd(), from_name.as_ptr(), 0) }).map(|_| ())
    }

    #[cfg(target_os = "linux")]
    fn native_no_replace(
        from_fd: libc::c_int,
        from: &CStr,
        to_fd: libc::c_int,
        to: &CStr,
    ) -> io::Result<()> {
        // SAFETY: both names are NUL-terminated and both descriptors open.
        check(unsafe {
            libc::renameat2(
                from_fd,
                from.as_ptr(),
                to_fd,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        })
        .map(|_| ())
    }

    #[cfg(target_vendor = "apple")]
    fn native_no_replace(
        from_fd: libc::c_int,
        from: &CStr,
        to_fd: libc::c_int,
        to: &CStr,
    ) -> io::Result<()> {
        // SAFETY: both names are NUL-terminated and both descriptors open.
        check(unsafe {
            libc::renameatx_np(
                from_fd,
                from.as_ptr(),
                to_fd,
                to.as_ptr(),
                libc::RENAME_EXCL,
            )
        })
        .map(|_| ())
    }

    /// No native no-replace rename here: every rename takes the link fallback.
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    fn native_no_replace(
        _from_fd: libc::c_int,
        _from: &CStr,
        _to_fd: libc::c_int,
        _to: &CStr,
    ) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(libc::ENOSYS))
    }

    /// Removes the folder `name` in `dir` and everything in it, never by path: it is renamed
    /// through the handle to a fresh name, opened by that name without following a symlink,
    /// emptied through descriptors (`openat`, `unlinkat`), and its now-empty name removed only
    /// while that name is still the folder that was opened. A folder put at the parked name
    /// meanwhile is never touched.
    pub(super) fn remove_dir_all(dir: &Dir, name: &OsStr) -> Result<(), Removal> {
        let parked = OsString::from(format!(".bibcode-delete-{}", uuid::Uuid::new_v4().simple()));
        dir.rename(name, dir, &parked, Replace::Never)
            .map_err(Removal::Untouched)?;
        let opened = open_child(&dir.fd, &parked).and_then(|fd| Ok((identity(&fd)?, fd)));
        let (id, fd) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                return Err(Removal::Partial {
                    error,
                    left_at: parked,
                });
            }
        };
        #[cfg(test)]
        hooks::after_park(&parked);
        let still_ours = || entry_at(&dir.fd, &parked).is_ok_and(|entry| entry.id == Some(id));
        let emptied = dir.contained().and_then(|()| empty_tree(&fd, 0));
        drop(fd);
        match emptied {
            Ok(()) if still_ours() => match remove_empty(&dir.fd, &parked) {
                Ok(()) => Ok(()),
                Err(error) => Err(Removal::Partial {
                    error,
                    left_at: parked,
                }),
            },
            Ok(()) => Err(Removal::Partial {
                error: io::Error::other("the folder moved while it was deleted"),
                left_at: parked,
            }),
            Err(error) => {
                // What is left goes back under its name, if that name is free and the parked
                // name is still that folder.
                let restored =
                    still_ours() && dir.rename(&parked, dir, name, Replace::Never).is_ok();
                Err(Removal::Partial {
                    error,
                    left_at: if restored {
                        name.to_os_string()
                    } else {
                        parked
                    },
                })
            }
        }
    }

    /// Removes everything in held folder `folder`, depth first, through descriptors only.
    fn empty_tree(folder: &OwnedFd, depth: usize) -> io::Result<()> {
        if depth > MOST_DEPTH {
            return Err(io::Error::other(
                "the folder is nested too deeply to delete",
            ));
        }
        for child in names_of(folder)? {
            if entry_at(folder, &child)?.kind == Kind::Directory {
                let inner = open_child(folder, &child)?;
                empty_tree(&inner, depth + 1)?;
                drop(inner);
                remove_empty(folder, &child)?;
            } else {
                let c = c_name(&child)?;
                // SAFETY: `c` is NUL-terminated and `folder` open.
                check(unsafe { libc::unlinkat(folder.as_raw_fd(), c.as_ptr(), 0) })?;
            }
        }
        Ok(())
    }

    fn remove_empty(folder: &OwnedFd, name: &OsStr) -> io::Result<()> {
        let c = c_name(name)?;
        // SAFETY: `c` is NUL-terminated and `folder` open.
        check(unsafe { libc::unlinkat(folder.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) })
            .map(|_| ())
    }
}

/// Test switches inside the Unix operations: points where a test acts as the other process,
/// and the forced link fallback of the no-replace rename. Thread-local, so tests running in
/// parallel never see each other's.
#[cfg(all(unix, test))]
mod hooks {
    use std::cell::{Cell, RefCell};
    use std::ffi::OsStr;

    type Hook = Box<dyn FnMut(&OsStr)>;

    thread_local! {
        static AFTER_CREATE: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static AFTER_PARK: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static LINK_FALLBACK: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn after_create(name: &OsStr) {
        AFTER_CREATE.with_borrow_mut(|hook| hook.as_mut().map(|hook| hook(name)));
    }

    pub(super) fn after_park(name: &OsStr) {
        AFTER_PARK.with_borrow_mut(|hook| hook.as_mut().map(|hook| hook(name)));
    }

    pub(super) fn link_fallback_forced() -> bool {
        LINK_FALLBACK.get()
    }

    pub(crate) fn on_create(hook: impl FnMut(&OsStr) + 'static) {
        AFTER_CREATE.set(Some(Box::new(hook)));
    }

    pub(crate) fn on_park(hook: impl FnMut(&OsStr) + 'static) {
        AFTER_PARK.set(Some(Box::new(hook)));
    }

    pub(crate) fn force_link_fallback(forced: bool) {
        LINK_FALLBACK.set(forced);
    }

    pub(crate) fn clear() {
        AFTER_CREATE.set(None);
        AFTER_PARK.set(None);
        LINK_FALLBACK.set(false);
    }
}

/// Outside tests nothing forces the link fallback.
#[cfg(all(unix, not(test)))]
mod hooks {
    pub(super) const fn link_fallback_forced() -> bool {
        false
    }
}

#[cfg(all(test, unix))]
pub(crate) use hooks::{clear as clear_test_hooks, force_link_fallback, on_create, on_park};
#[cfg(unix)]
pub(crate) use imp::rename_no_replace;

/// Without `*at` calls, every operation re-checks the folder and then works by path. The
/// outside-agent tools that change files are refused on these platforms.
#[cfg(not(unix))]
mod imp {
    use std::ffi::{OsStr, OsString};
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::path::Path;

    use super::{Dir, Entry, Identity, Kind, Open, Removal, Replace, Root, escape};

    pub(super) fn open(
        root: &Root,
        folder: &Path,
        names: &[&OsStr],
        create: bool,
    ) -> io::Result<Dir> {
        let mut path = root.path.clone();
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
            root: root.clone(),
        };
        dir.recheck()?;
        Ok(dir)
    }

    pub(super) fn open_dir(dir: &Dir, name: &OsStr) -> io::Result<Dir> {
        if entry(dir, name)?.kind != Kind::Directory {
            return Err(escape());
        }
        let child = Dir {
            path: dir.path.join(name),
            root: dir.root.clone(),
        };
        child.recheck()?;
        Ok(child)
    }

    pub(super) fn names(dir: &Dir) -> io::Result<Vec<OsString>> {
        dir.recheck()?;
        std::fs::read_dir(&dir.path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect()
    }

    pub(super) fn entry(dir: &Dir, name: &OsStr) -> io::Result<Entry> {
        dir.recheck()?;
        let metadata = match std::fs::symlink_metadata(dir.path.join(name)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Entry {
                    kind: Kind::Missing,
                    len: 0,
                    id: None,
                });
            }
            Err(error) => return Err(error),
        };
        let kind = if metadata.file_type().is_symlink() {
            Kind::Symlink
        } else if metadata.is_dir() {
            Kind::Directory
        } else if metadata.is_file() {
            Kind::File
        } else {
            Kind::Other
        };
        Ok(Entry {
            kind,
            len: metadata.len(),
            id: Identity::of_metadata(&metadata),
        })
    }

    pub(super) fn contained(dir: &Dir) -> io::Result<()> {
        if dir.path.starts_with(&dir.root.path) {
            Ok(())
        } else {
            Err(escape())
        }
    }

    pub(super) fn open_file(dir: &Dir, name: &OsStr, open: Open) -> io::Result<File> {
        dir.recheck()?;
        let path = dir.path.join(name);
        match open {
            Open::Read => File::open(path),
            Open::Write => File::create(path),
            Open::CreateNew => OpenOptions::new().write(true).create_new(true).open(path),
            Open::Existing => OpenOptions::new().read(true).write(true).open(path),
        }
    }

    pub(super) fn remove_file(dir: &Dir, name: &OsStr) -> io::Result<()> {
        dir.recheck()?;
        std::fs::remove_file(dir.path.join(name))
    }

    pub(super) fn rename(
        dir: &Dir,
        name: &OsStr,
        to: &Dir,
        to_name: &OsStr,
        replace: Replace,
    ) -> io::Result<()> {
        dir.recheck()?;
        to.recheck()?;
        let target = to.path.join(to_name);
        if replace == Replace::Never && std::fs::symlink_metadata(&target).is_ok() {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        std::fs::rename(dir.path.join(name), target)
    }

    /// By path after a re-check, as the Files panel did before; the MCP tools that change
    /// files are refused on these platforms.
    pub(super) fn remove_dir_all(dir: &Dir, name: &OsStr) -> Result<(), Removal> {
        let parked = OsString::from(format!(".bibcode-delete-{}", uuid::Uuid::new_v4().simple()));
        dir.rename(name, dir, &parked, Replace::Never)
            .map_err(Removal::Untouched)?;
        let removed = dir
            .recheck()
            .and_then(|()| std::fs::remove_dir_all(dir.path.join(&parked)));
        let Err(error) = removed else {
            return Ok(());
        };
        let left_at = match dir.rename(&parked, dir, name, Replace::Never) {
            Ok(()) => name.to_os_string(),
            Err(_) => parked,
        };
        Err(Removal::Partial { error, left_at })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn canonical_root() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(root.path()).unwrap();
        (root, path)
    }

    #[test]
    fn a_walk_refuses_a_symlinked_folder_and_works_by_name_through_the_handle() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root_path.join("real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root_path.join("link")).unwrap();

        let error = Dir::open(&root, &root_path.join("link"), false)
            .err()
            .expect("a symlinked folder is refused");
        assert!(is_escape(&error), "{error}");
        let error = Dir::open(&root, &root_path.join("link/new"), true)
            .err()
            .expect("creating through a symlink is refused");
        assert!(is_escape(&error), "{error}");
        assert!(Dir::open(&root, outside.path(), false).is_err());

        let dir = Dir::open(&root, &root_path.join("real/new/deeper"), true).unwrap();
        std::io::Write::write_all(
            &mut dir.open_file(OsStr::new("a.txt"), Open::CreateNew).unwrap(),
            b"one",
        )
        .unwrap();
        assert!(dir.open_file(OsStr::new("a.txt"), Open::CreateNew).is_err());
        assert_eq!(dir.kind(OsStr::new("a.txt")).unwrap(), Kind::File);
        // Moving the folder elsewhere inside the root keeps the handle working there.
        std::fs::rename(root_path.join("real"), root_path.join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root_path.join("real")).unwrap();
        dir.rename(
            OsStr::new("a.txt"),
            &dir,
            OsStr::new("b.txt"),
            Replace::Never,
        )
        .unwrap();
        assert!(root_path.join("moved/new/deeper/b.txt").exists());
        assert!(!outside.path().join("b.txt").exists());
        assert!(is_escape(&dir.recheck().unwrap_err()));
        dir.remove_file(OsStr::new("b.txt")).unwrap();
        assert_eq!(dir.kind(OsStr::new("b.txt")).unwrap(), Kind::Missing);
        // A symlink at the name is not followed.
        let top = Dir::open(&root, &root_path, false).unwrap();
        assert_eq!(top.kind(OsStr::new("link")).unwrap(), Kind::Symlink);
        assert!(is_escape(
            &top.open_file(OsStr::new("link"), Open::Read).unwrap_err()
        ));
    }

    #[test]
    fn a_held_folder_moved_out_of_the_root_receives_nothing() {
        let (_root, root_path) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir(root_path.join("sub")).unwrap();
        std::fs::write(root_path.join("a.txt"), "a").unwrap();
        std::fs::write(root_path.join("sub/victim.txt"), "v").unwrap();
        let top = Dir::open(&root, &root_path, false).unwrap();
        let sub = Dir::open(&root, &root_path.join("sub"), false).unwrap();
        // Another process moves the folder out after BiBCode opened it.
        std::fs::rename(root_path.join("sub"), outside.join("sub")).unwrap();

        let moved = top.rename(
            OsStr::new("a.txt"),
            &sub,
            OsStr::new("a.txt"),
            Replace::Never,
        );
        assert!(is_escape(&moved.unwrap_err()));
        assert!(root_path.join("a.txt").exists());
        assert!(!outside.join("sub/a.txt").exists());
        assert!(is_escape(
            &sub.open_file(OsStr::new("new.txt"), Open::CreateNew)
                .unwrap_err()
        ));
        assert!(is_escape(
            &sub.remove_file(OsStr::new("victim.txt")).unwrap_err()
        ));
        assert!(outside.join("sub/victim.txt").exists());
        assert!(!outside.join("sub/new.txt").exists());
        assert!(sub.remove_dir_all(OsStr::new("victim.txt")).is_err());
    }

    #[test]
    fn a_root_replaced_after_its_check_is_refused() {
        let (_parent, parent) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root_path = parent.join("root");
        std::fs::create_dir(&root_path).unwrap();
        let root = Root::new(&root_path).unwrap();
        // A symlink put where the root was.
        std::fs::rename(&root_path, parent.join("root.moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &root_path).unwrap();
        assert!(is_escape(
            &Dir::open(&root, &root_path, false).err().expect("refused")
        ));
        // Another folder put where the root was.
        std::fs::remove_file(&root_path).unwrap();
        std::fs::create_dir(&root_path).unwrap();
        assert!(is_escape(
            &Dir::open(&root, &root_path, false).err().expect("refused")
        ));
    }

    #[test]
    fn a_no_replace_rename_and_an_own_removal_leave_other_files_alone() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        std::fs::write(root_path.join("a"), "a").unwrap();
        std::fs::write(root_path.join("b"), "b").unwrap();
        let refused = dir.rename(OsStr::new("a"), &dir, OsStr::new("b"), Replace::Never);
        assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(root_path.join("b")).unwrap(), "b");

        let mine = dir.open_file(OsStr::new("mine"), Open::CreateNew).unwrap();
        let id = Identity::of(&mine).unwrap();
        drop(mine);
        // Replaced by someone else's file: not ours, kept.
        std::fs::remove_file(root_path.join("mine")).unwrap();
        std::fs::write(root_path.join("mine"), "theirs").unwrap();
        assert!(!dir.remove_own(OsStr::new("mine"), id, true));
        assert!(root_path.join("mine").exists());
    }

    #[test]
    fn a_folder_is_removed_whole_under_a_parked_name_and_a_partial_removal_says_where() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir_all(root_path.join("victim/inner")).unwrap();
        std::fs::write(root_path.join("victim/inner/file"), "x").unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        dir.remove_dir_all(OsStr::new("victim")).unwrap();
        assert_eq!(std::fs::read_dir(&root_path).unwrap().count(), 0);

        // A folder it cannot empty: what is left comes back under its name, and says so.
        std::fs::create_dir_all(root_path.join("stuck/locked")).unwrap();
        std::fs::write(root_path.join("stuck/locked/file"), "x").unwrap();
        let locked = root_path.join("stuck/locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = dir.remove_dir_all(OsStr::new("stuck"));
        let parked = std::fs::read_dir(&root_path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        for name in &parked {
            let path = root_path.join(name);
            let _ = std::fs::set_permissions(
                path.join("locked"),
                std::fs::Permissions::from_mode(0o700),
            );
        }
        match result {
            Err(Removal::Partial { left_at, .. }) => assert_eq!(left_at, "stuck"),
            other => panic!("expected a partial removal, got {other:?}"),
        }
        assert_eq!(parked, [OsString::from("stuck")]);
    }

    #[test]
    fn a_parent_moved_out_while_folders_are_created_keeps_nothing_there() {
        let (_root, root_path) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir(root_path.join("a")).unwrap();
        let (from, to) = (root_path.join("a"), outside.join("a"));
        // The other process moves `a` out right after `b` is made in it.
        on_create(move |name| {
            if name == "b" {
                std::fs::rename(&from, &to).unwrap();
            }
        });
        let result = Dir::open(&root, &root_path.join("a/b/c"), true);
        clear_test_hooks();
        assert!(is_escape(&result.err().expect("refused")));
        assert!(outside.join("a").exists());
        assert!(
            !outside.join("a/b").exists(),
            "the folder made there was removed"
        );
    }

    #[test]
    fn a_folder_put_at_the_parked_name_survives_a_permanent_delete() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir_all(root_path.join("victim/inner")).unwrap();
        std::fs::write(root_path.join("victim/inner/file"), "x").unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        let base = root_path.clone();
        // Once the folder is parked, another process moves it and puts its own folder there.
        on_park(move |parked| {
            std::fs::rename(base.join(parked), base.join("moved")).unwrap();
            std::fs::create_dir(base.join(parked)).unwrap();
            std::fs::write(base.join(parked).join("keep"), "theirs").unwrap();
        });
        let result = dir.remove_dir_all(OsStr::new("victim"));
        clear_test_hooks();
        let Err(Removal::Partial { left_at, .. }) = result else {
            panic!("expected a partial removal, got {result:?}");
        };
        assert_eq!(
            std::fs::read_to_string(root_path.join(&left_at).join("keep")).unwrap(),
            "theirs"
        );
        // The folder that was deleted was emptied through its handle, wherever it went.
        assert_eq!(
            std::fs::read_dir(root_path.join("moved")).unwrap().count(),
            0
        );
    }

    #[test]
    fn the_no_replace_rename_falls_back_to_a_link_where_the_flag_is_unsupported() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        std::fs::write(root_path.join("a"), "a").unwrap();
        std::fs::write(root_path.join("taken"), "taken").unwrap();
        std::fs::create_dir(root_path.join("folder")).unwrap();
        force_link_fallback(true);
        let moved = dir.rename(OsStr::new("a"), &dir, OsStr::new("b"), Replace::Never);
        let refused = dir.rename(OsStr::new("b"), &dir, OsStr::new("taken"), Replace::Never);
        let folder = dir.rename(
            OsStr::new("folder"),
            &dir,
            OsStr::new("elsewhere"),
            Replace::Never,
        );
        clear_test_hooks();
        moved.unwrap();
        assert!(!root_path.join("a").exists());
        assert_eq!(std::fs::read_to_string(root_path.join("b")).unwrap(), "a");
        assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read_to_string(root_path.join("taken")).unwrap(),
            "taken"
        );
        let folder = folder.unwrap_err();
        assert_eq!(folder.kind(), io::ErrorKind::Unsupported);
        assert_eq!(folder.to_string(), imp::NO_REPLACE_UNSUPPORTED);
        assert!(root_path.join("folder").exists());
    }

    #[test]
    fn names_lists_a_folder_through_its_handle() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::write(root_path.join("one"), "").unwrap();
        std::fs::create_dir(root_path.join("two")).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        let mut names = dir.names().unwrap();
        names.sort();
        assert_eq!(names, [OsString::from("one"), OsString::from("two")]);
        assert_eq!(
            dir.open_dir(OsStr::new("two"))
                .unwrap()
                .names()
                .unwrap()
                .len(),
            0
        );
    }
}
