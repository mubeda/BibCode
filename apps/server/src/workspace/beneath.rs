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
//! On Windows the same design runs on native handles: every folder is opened with
//! `FILE_OPEN_REPARSE_POINT` and refused when it is a reparse point that names another entry
//! (a symlink, junction or mount point); entries are opened by name relative to the held
//! folder (`NtCreateFile` with `RootDirectory`), must carry the very name asked for (an 8.3
//! short name or an alternate data stream is refused), and are renamed and deleted through
//! their own handle (`NtSetInformationFile`, `SetFileInformationByHandle`). [`Dir::contained`] compares the final
//! paths of the held folder and the held root, which follow every rename.
//!
//! The system trash takes a path. On Unix the entry is staged by handle first
//! (`git::trash_by_staging`); on Windows the entry's folder is pinned ([`Dir::pin`]) for the
//! call, so no folder on the path can be renamed or replaced meanwhile.

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

/// A file's identity: its device and inode on Unix, its volume serial number and 128-bit file
/// ID on Windows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Identity {
    dev: u64,
    ino: u128,
}

impl Identity {
    /// The identity of an open file.
    #[cfg(unix)]
    pub(crate) fn of(file: &File) -> io::Result<Option<Self>> {
        file.metadata()
            .map(|metadata| Some(Self::of_metadata(&metadata)))
    }

    #[cfg(windows)]
    pub(crate) fn of(file: &File) -> io::Result<Option<Self>> {
        imp::identity(file).map(Some)
    }

    #[cfg(unix)]
    fn of_metadata(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt as _;
        Self {
            dev: metadata.dev(),
            ino: u128::from(metadata.ino()),
        }
    }
}

/// How many names (hard links) the open file has.
pub(crate) fn link_count(file: &File) -> io::Result<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        file.metadata().map(|metadata| metadata.nlink())
    }
    #[cfg(windows)]
    {
        imp::link_count(file)
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
            #[cfg(unix)]
            id: Some(Identity::of_metadata(&metadata)),
            #[cfg(windows)]
            id: Some(imp::root_identity(path)?),
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
    #[cfg(windows)]
    handle: File,
    /// The root, held: a folder is under it while the folder's final path is under the root's.
    #[cfg(windows)]
    root_handle: std::sync::Arc<File>,
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
    /// handle, walking `..` back to the root's identity; on Windows by the final paths of its
    /// handle and the root's.
    pub(crate) fn contained(&self) -> io::Result<()> {
        imp::contained(self)
    }

    /// Fails with [`is_escape`] unless the folder's path still resolves to itself and the
    /// folder is still under the root.
    #[cfg_attr(
        all(unix, not(test)),
        allow(dead_code, reason = "Unix checks by handle")
    )]
    pub(crate) fn recheck(&self) -> io::Result<()> {
        match std::fs::canonicalize(&self.path) {
            Ok(path) if path == self.path => self.contained(),
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Err(escape()),
        }
    }

    /// The path of `name` in this folder, after [`Self::recheck`], for a call that takes a
    /// path (the system trash). Windows gets it without the `\\?\` prefix the Recycle Bin
    /// refuses. Hold [`Self::pin`] across the call so the path keeps naming this folder.
    #[cfg(windows)]
    pub(crate) fn checked_path(&self, name: &OsStr) -> io::Result<PathBuf> {
        self.recheck()?;
        Ok(crate::git::without_verbatim_prefix(self.path.join(name)))
    }

    /// This folder held so that nothing can rename or delete it, nor (NTFS and ReFS refuse it
    /// for any folder above an open one) a folder above it, until the handle is dropped. The
    /// pinned folder must be this one and still be at this folder's path. Other file systems
    /// are refused (`ErrorKind::Unsupported`).
    #[cfg(windows)]
    pub(crate) fn pin(&self) -> io::Result<File> {
        imp::pin(self)
    }

    /// The full name of the entry `name`, checked through its handle: an 8.3 short name
    /// (`GIT~1` for `.git`) is refused, so a path built from it names what the check saw.
    #[cfg(windows)]
    pub(crate) fn long_name(&self, name: &OsStr) -> io::Result<OsString> {
        imp::long_name(self, name)
    }

    /// Removes the folder `name` and everything in it. It is first renamed through the handle
    /// to a fresh name, then emptied and removed through handles. A removal that fails part-way
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

    use super::{
        Dir, ESCAPE_MESSAGE, Entry, Identity, Kind, Open, Removal, Replace, Root, escape, hooks,
    };

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
            ino: u128::from(stat.st_ino as u64),
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
    /// Whether the folder `held` is still under the folder whose device and inode are `root`
    /// (Source Control's discard staging checks the entry's folder with it before moving it).
    pub(crate) fn folder_beneath(held: BorrowedFd<'_>, root: (u64, u64)) -> io::Result<()> {
        // SAFETY: `held` is open.
        let copy = owned(unsafe { libc::fcntl(held.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) })?;
        contained_fd(
            &copy,
            Some(Identity {
                dev: root.0,
                ino: u128::from(root.1),
            }),
        )
    }

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
                let removed =
                    unsafe { libc::unlinkat(parent.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) };
                if removed != 0 {
                    // Something was put in it already: it stays where the moved parent went.
                    return Err(io::Error::other(format!(
                        "{ESCAPE_MESSAGE}; the folder BiBCode had just made there could not be removed: {}",
                        io::Error::last_os_error()
                    )));
                }
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
    /// every BiBCode caller (the workspace service, uploads, discard staging), with the
    /// kernel's no-replace rename. A file system without it (`EINVAL`, `ENOSYS`, `ENOTSUP`) is
    /// refused with [`NO_REPLACE_UNSUPPORTED`] (`ErrorKind::Unsupported`), for files and folders
    /// alike: a link-and-unlink stand-in is not one atomic step.
    pub(crate) fn rename_no_replace(
        from: BorrowedFd<'_>,
        from_name: &CStr,
        to: BorrowedFd<'_>,
        to_name: &CStr,
    ) -> io::Result<()> {
        let native = if hooks::no_replace_unsupported() {
            Err(io::Error::from_raw_os_error(libc::EINVAL))
        } else {
            native_no_replace(from.as_raw_fd(), from_name, to.as_raw_fd(), to_name)
        };
        match native {
            Err(error)
                // ENOTSUP and EOPNOTSUPP are the same number on Linux, so compare by value.
                if error.raw_os_error().is_some_and(|code| {
                    [libc::EINVAL, libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP].contains(&code)
                }) =>
            {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    NO_REPLACE_UNSUPPORTED,
                ))
            }
            other => other,
        }
    }

    /// The refusal of a no-replace rename on a file system without the kernel's no-replace
    /// rename.
    pub(crate) const NO_REPLACE_UNSUPPORTED: &str =
        "this file system cannot rename without the risk of replacing another entry";

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
        let emptied = empty_tree(&fd, dir.root.id, 0);
        drop(fd);
        match emptied {
            // The held parent must still be under the root right before the parked name goes.
            Ok(()) if still_ours() => {
                #[cfg(test)]
                hooks::before_unlink(&parked);
                dir.contained()
                    .and_then(|()| remove_empty(&dir.fd, &parked))
                    .map_err(|error| Removal::Partial {
                        error,
                        left_at: parked,
                    })
            }
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

    /// Removes everything in held folder `folder`, depth first, through descriptors only. The
    /// folder must still be under the root (identity `root`) right before each removal; the
    /// first check that fails stops the removal and leaves the rest, so a folder another process
    /// moves out mid-way loses at most the one entry whose removal was already under way.
    fn empty_tree(folder: &OwnedFd, root: Option<Identity>, depth: usize) -> io::Result<()> {
        if depth > MOST_DEPTH {
            return Err(io::Error::other(
                "the folder is nested too deeply to delete",
            ));
        }
        for child in names_of(folder)? {
            if entry_at(folder, &child)?.kind == Kind::Directory {
                let inner = open_child(folder, &child)?;
                empty_tree(&inner, root, depth + 1)?;
                drop(inner);
                contained_fd(folder, root)?;
                remove_empty(folder, &child)?;
            } else {
                #[cfg(test)]
                hooks::before_unlink(&child);
                contained_fd(folder, root)?;
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

/// Test switches inside the operations: points where a test acts as the other process, and
/// (Unix) the forced link fallback of the no-replace rename. Thread-local, so tests running in
/// parallel never see each other's.
#[cfg(test)]
mod hooks {
    #[cfg(unix)]
    use std::cell::Cell;
    use std::cell::RefCell;
    use std::ffi::OsStr;

    type Hook = Box<dyn FnMut(&OsStr)>;

    thread_local! {
        static AFTER_CREATE: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static AFTER_PARK: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static BEFORE_UNLINK: RefCell<Option<Hook>> = const { RefCell::new(None) };
        #[cfg(unix)]
        static NO_REPLACE_OFF: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn after_create(name: &OsStr) {
        AFTER_CREATE.with_borrow_mut(|hook| hook.as_mut().map(|hook| hook(name)));
    }

    pub(super) fn before_unlink(name: &OsStr) {
        BEFORE_UNLINK.with_borrow_mut(|hook| hook.as_mut().map(|hook| hook(name)));
    }

    pub(crate) fn on_unlink(hook: impl FnMut(&OsStr) + 'static) {
        BEFORE_UNLINK.set(Some(Box::new(hook)));
    }

    pub(super) fn after_park(name: &OsStr) {
        AFTER_PARK.with_borrow_mut(|hook| hook.as_mut().map(|hook| hook(name)));
    }

    #[cfg(unix)]
    pub(super) fn no_replace_unsupported() -> bool {
        NO_REPLACE_OFF.get()
    }

    pub(crate) fn on_create(hook: impl FnMut(&OsStr) + 'static) {
        AFTER_CREATE.set(Some(Box::new(hook)));
    }

    pub(crate) fn on_park(hook: impl FnMut(&OsStr) + 'static) {
        AFTER_PARK.set(Some(Box::new(hook)));
    }

    #[cfg(unix)]
    pub(crate) fn force_no_replace_unsupported(forced: bool) {
        NO_REPLACE_OFF.set(forced);
    }

    pub(crate) fn clear() {
        AFTER_CREATE.set(None);
        AFTER_PARK.set(None);
        BEFORE_UNLINK.set(None);
        #[cfg(unix)]
        NO_REPLACE_OFF.set(false);
    }
}

/// Outside tests nothing switches the no-replace rename off.
#[cfg(all(unix, not(test)))]
mod hooks {
    pub(super) const fn no_replace_unsupported() -> bool {
        false
    }
}

#[cfg(all(test, unix))]
pub(crate) use hooks::force_no_replace_unsupported;
#[cfg(test)]
pub(crate) use hooks::{clear as clear_test_hooks, on_create, on_park, on_unlink};
#[cfg(unix)]
pub(crate) use imp::{folder_beneath, rename_no_replace};

/// Windows: every folder is held by a handle opened without following a reparse point
/// (`FILE_OPEN_REPARSE_POINT`), each entry is opened by name relative to its folder's handle
/// (`NtCreateFile` with `RootDirectory`), and a rename or delete goes through the entry's own
/// handle (`NtSetInformationFile`, `SetFileInformationByHandle`), so a folder swapped for a junction or symlink after
/// the check cannot redirect it.
#[cfg(windows)]
mod imp {
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io;
    use std::mem::{offset_of, size_of};
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
        FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
        FileRenameInformation, NtCreateFile, NtSetInformationFile,
    };
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, ERROR_NOT_SUPPORTED,
        HANDLE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
    };
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FULL_DIR_INFO,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS,
        FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_STANDARD_INFO, FILE_TRAVERSE, FileAttributeTagInfo,
        FileDispositionInfo, FileDispositionInfoEx, FileFullDirectoryInfo,
        FileFullDirectoryRestartInfo, FileIdInfo, FileStandardInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetVolumeInformationByHandleW,
        SYNCHRONIZE, SetFileInformationByHandle,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    #[cfg(test)]
    use super::hooks;
    use super::{Dir, ESCAPE_MESSAGE, Entry, Identity, Kind, Open, Removal, Replace, Root, escape};

    /// The deepest a folder can sit below the root before a removal gives up.
    const MOST_DEPTH: usize = 4_096;
    /// `IsReparseTagNameSurrogate`: the reparse point names another entry (a symlink, a
    /// junction, a mount point), which is what could redirect a path.
    const NAME_SURROGATE: u32 = 0x2000_0000;
    /// `IO_REPARSE_TAG_AF_UNIX`: a Unix socket, neither a file nor a folder.
    const AF_UNIX: u32 = 0x8000_0023;
    const DIRECTORY_ACCESS: u32 =
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

    /// `name` as UTF-16, refused unless it is one plain entry: no separator, no `:` (an
    /// alternate data stream), no NUL, and not `.` or `..`.
    fn wide_name(name: &OsStr) -> io::Result<Vec<u16>> {
        let wide: Vec<u16> = name.encode_wide().collect();
        let plain = !wide.is_empty()
            && name != "."
            && name != ".."
            && !wide
                .iter()
                .any(|unit| matches!(unit, 0 | 0x2F | 0x3A | 0x5C));
        if plain {
            Ok(wide)
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a single plain entry name (a separator, a stream or NUL is refused)",
            ))
        }
    }

    fn nt_error(status: i32) -> io::Error {
        // SAFETY: a plain conversion of a status code.
        io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) }.cast_signed())
    }

    fn check(result: i32) -> io::Result<()> {
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn query<T: Default>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
        let mut info = T::default();
        // SAFETY: `info` is a `T`, the structure `class` fills, and as large as passed.
        check(unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                class,
                (&raw mut info).cast(),
                size_of::<T>() as u32,
            )
        })?;
        Ok(info)
    }

    fn set<T>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS, info: &T) -> io::Result<()> {
        // SAFETY: `info` is the structure `class` takes, as large as passed.
        check(unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                class,
                std::ptr::from_ref(info).cast(),
                size_of::<T>() as u32,
            )
        })
    }

    /// The path the open `file` has now, long names throughout (`\\?\C:\…`, as
    /// `std::fs::canonicalize` spells it).
    fn final_path(file: &File) -> io::Result<PathBuf> {
        let mut buffer = vec![0_u16; 512];
        loop {
            // SAFETY: `buffer` holds as many units as passed.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            if length < buffer.len() {
                return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
            }
            buffer.resize(length, 0);
        }
    }

    pub(super) fn identity(file: &File) -> io::Result<Identity> {
        if let Ok(info) = query::<FILE_ID_INFO>(file, FileIdInfo) {
            return Ok(Identity {
                dev: info.VolumeSerialNumber,
                ino: u128::from_le_bytes(info.FileId.Identifier),
            });
        }
        // A file system without 128-bit file IDs (FAT).
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `info` is a valid out structure.
        check(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) })?;
        Ok(Identity {
            dev: u64::from(info.dwVolumeSerialNumber),
            ino: (u128::from(info.nFileIndexHigh) << 32) | u128::from(info.nFileIndexLow),
        })
    }

    /// How many names (hard links) the open file has.
    pub(crate) fn link_count(file: &File) -> io::Result<u64> {
        query::<FILE_STANDARD_INFO>(file, FileStandardInfo)
            .map(|info| u64::from(info.NumberOfLinks))
    }

    fn kind_of(file: &File) -> io::Result<Kind> {
        let info = query::<FILE_ATTRIBUTE_TAG_INFO>(file, FileAttributeTagInfo)?;
        let reparse = info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        Ok(if reparse && info.ReparseTag & NAME_SURROGATE != 0 {
            Kind::Symlink
        } else if reparse && info.ReparseTag == AF_UNIX {
            Kind::Other
        } else if info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            Kind::Directory
        } else {
            Kind::File
        })
    }

    /// Whether the open `file` carries a reparse point of any kind.
    fn reparse_point(file: &File) -> io::Result<bool> {
        query::<FILE_ATTRIBUTE_TAG_INFO>(file, FileAttributeTagInfo)
            .map(|info| info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }

    /// Opens `name` in the folder `parent` by its handle, never following a reparse point at
    /// it. The entry opened must have that very name, in any letter case: an 8.3 short name
    /// (`GIT~1`) opens an entry the caller's check knew by another name.
    fn open_at(
        parent: &File,
        name: &OsStr,
        access: u32,
        disposition: u32,
        options: u32,
    ) -> io::Result<File> {
        let mut wide = wide_name(name)?;
        let file = nt_open(parent, &mut wide, access, SHARE_ALL, disposition, options)?;
        let path = final_path(&file)?;
        if !same_text(path.file_name().unwrap_or_default(), name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a short (8.3) name is refused; use the entry's full name",
            ));
        }
        Ok(file)
    }

    /// Whether `a` and `b` are one name to the file system: equal, ignoring case.
    fn same_text(a: &OsStr, b: &OsStr) -> bool {
        let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_wide().collect(), b.encode_wide().collect());
        // SAFETY: both slices are valid for the lengths passed.
        let order = unsafe {
            CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1)
        };
        order == CSTR_EQUAL
    }

    /// The full (long) name of the entry `name` in `dir`, refused when `name` is not that very
    /// name in some letter case (an 8.3 short name), for a call that takes a path.
    pub(super) fn long_name(dir: &Dir, name: &OsStr) -> io::Result<OsString> {
        let entry = open_at(&dir.handle, name, FILE_READ_ATTRIBUTES, FILE_OPEN, 0)?;
        final_path(&entry)?
            .file_name()
            .map(OsStr::to_os_string)
            .ok_or_else(escape)
    }

    /// `NtCreateFile` of `name` relative to `parent` (the folder itself when `name` is empty),
    /// never following a reparse point.
    fn nt_open(
        parent: &File,
        name: &mut [u16],
        access: u32,
        share: u32,
        disposition: u32,
        options: u32,
    ) -> io::Result<File> {
        let bytes = u16::try_from(name.len() * 2)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the name is too long"))?;
        let unicode = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.as_raw_handle(),
            ObjectName: &raw const unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: std::ptr::null(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut status_block = IO_STATUS_BLOCK::default();
        let mut handle: HANDLE = std::ptr::null_mut();
        // SAFETY: every pointer is to initialized storage alive for the call; on success the
        // call returns one new handle, adopted once below.
        let status = unsafe {
            NtCreateFile(
                &raw mut handle,
                access | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                &raw const attributes,
                &raw mut status_block,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                share,
                disposition,
                options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(nt_error(status));
        }
        // SAFETY: the call succeeded and returned a handle nothing else owns.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    /// The canonical root opened by its path, refused (as moved) unless it is a folder and no
    /// reparse point that names another entry.
    fn open_root(path: &Path) -> io::Result<File> {
        let file = std::fs::OpenOptions::new()
            .access_mode(DIRECTORY_ACCESS)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if kind_of(&file)? != Kind::Directory {
            return Err(escape());
        }
        Ok(file)
    }

    pub(super) fn root_identity(path: &Path) -> io::Result<Identity> {
        identity(&open_root(path)?)
    }

    fn open_child(parent: &File, name: &OsStr) -> io::Result<File> {
        match open_at(
            parent,
            name,
            DIRECTORY_ACCESS,
            FILE_OPEN,
            FILE_DIRECTORY_FILE,
        ) {
            Ok(file) if kind_of(&file)? == Kind::Directory => Ok(file),
            // A junction or folder symlink, opened as itself.
            Ok(_) => Err(escape()),
            // A file symlink where a folder was.
            Err(error)
                if error.kind() == io::ErrorKind::NotADirectory
                    && entry_at(parent, name)?.kind == Kind::Symlink =>
            {
                Err(escape())
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn open(
        root: &Root,
        folder: &Path,
        names: &[&OsStr],
        create: bool,
    ) -> io::Result<Dir> {
        let root_handle = open_root(&root.path)?;
        if Some(identity(&root_handle)?) != root.id {
            return Err(escape());
        }
        let mut handle = root_handle.try_clone()?;
        for name in names {
            handle = match open_child(&handle, name) {
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    create_contained(&handle, name, &root_handle)?;
                    open_child(&handle, name)?
                }
                other => other?,
            };
        }
        Ok(Dir {
            path: folder.to_path_buf(),
            root: root.clone(),
            handle,
            root_handle: Arc::new(root_handle),
        })
    }

    pub(super) fn open_dir(dir: &Dir, name: &OsStr) -> io::Result<Dir> {
        Ok(Dir {
            path: dir.path.join(name),
            root: dir.root.clone(),
            handle: open_child(&dir.handle, name)?,
            root_handle: Arc::clone(&dir.root_handle),
        })
    }

    pub(super) fn names(dir: &Dir) -> io::Result<Vec<OsString>> {
        names_of(&dir.handle)
    }

    fn names_of(folder: &File) -> io::Result<Vec<OsString>> {
        let mut buffer = vec![0_u64; 8 * 1024];
        let mut class = FileFullDirectoryRestartInfo;
        let mut names = Vec::new();
        loop {
            // SAFETY: `buffer` is 8-byte aligned and as large as passed.
            let filled = unsafe {
                GetFileInformationByHandleEx(
                    folder.as_raw_handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * size_of::<u64>()) as u32,
                )
            };
            if filled == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES.cast_signed()) {
                    return Ok(names);
                }
                return Err(error);
            }
            class = FileFullDirectoryInfo;
            let mut offset = 0;
            loop {
                // SAFETY: the call filled `buffer` with entries chained by `NextEntryOffset`,
                // each aligned and holding `FileNameLength` bytes of name.
                let (next, name) = unsafe {
                    let entry = buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_FULL_DIR_INFO>();
                    let length = (*entry).FileNameLength as usize / 2;
                    let name = std::slice::from_raw_parts(
                        (&raw const (*entry).FileName).cast::<u16>(),
                        length,
                    );
                    ((*entry).NextEntryOffset as usize, name)
                };
                if name != [0x2E] && name != [0x2E, 0x2E] {
                    names.push(OsString::from_wide(name));
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
    }

    fn entry_at(parent: &File, name: &OsStr) -> io::Result<Entry> {
        let file = match open_at(parent, name, FILE_READ_ATTRIBUTES, FILE_OPEN, 0) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Entry::MISSING),
            Err(error) => return Err(error),
        };
        let standard = query::<FILE_STANDARD_INFO>(&file, FileStandardInfo)?;
        Ok(Entry {
            kind: kind_of(&file)?,
            len: u64::try_from(standard.EndOfFile).unwrap_or(0),
            id: Some(identity(&file)?),
        })
    }

    pub(super) fn entry(dir: &Dir, name: &OsStr) -> io::Result<Entry> {
        entry_at(&dir.handle, name)
    }

    pub(super) fn contained(dir: &Dir) -> io::Result<()> {
        beneath(&dir.handle, &dir.root_handle)
    }

    /// Whether the held folder `held` is still under the held root: the path each has now
    /// (which follows every rename) puts one under the other.
    fn beneath(held: &File, root: &File) -> io::Result<()> {
        if final_path(held)?.starts_with(final_path(root)?) {
            Ok(())
        } else {
            Err(escape())
        }
    }

    /// The held folder opened once more without `FILE_SHARE_DELETE`, still under the root.
    /// While it is open nothing can rename or delete it, and NTFS and ReFS refuse to rename any
    /// folder above an open one, so its path keeps naming it; other file systems are refused.
    pub(super) fn pin(dir: &Dir) -> io::Result<File> {
        let mut system = [0_u16; 32];
        // SAFETY: only the file system name is asked for, into `system`, as large as passed.
        check(unsafe {
            GetVolumeInformationByHandleW(
                dir.handle.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                system.as_mut_ptr(),
                system.len() as u32,
            )
        })?;
        let end = system
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(system.len());
        if !matches!(
            String::from_utf16_lossy(&system[..end]).as_str(),
            "NTFS" | "ReFS"
        ) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "this file system cannot keep a folder in place while BiBCode works in it",
            ));
        }
        let pinned = nt_open(
            &dir.handle,
            &mut [],
            DIRECTORY_ACCESS,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_OPEN,
            FILE_DIRECTORY_FILE,
        )?;
        // The pinned folder must be the one held, and its path must name it now: a folder put
        // at that path before the pin would stay unpinned, free to become a junction.
        let id = identity(&dir.handle)?;
        let at_path = match open_root(&dir.path) {
            Ok(at_path) => at_path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(escape()),
            Err(error) => return Err(error),
        };
        if identity(&pinned)? != id
            || identity(&at_path)? != id
            || !same_text(final_path(&pinned)?.as_os_str(), dir.path.as_os_str())
        {
            return Err(escape());
        }
        contained(dir)?;
        Ok(pinned)
    }

    /// Opens a file without following a reparse point at its name. Nothing is truncated
    /// before the entry is known to be a plain file: `Write` opens or creates, checks, and
    /// only then truncates. A data reparse point (a cloud placeholder, a deduplicated file)
    /// is read as stored and never changed.
    pub(super) fn open_file(dir: &Dir, name: &OsStr, open: Open) -> io::Result<File> {
        let (access, disposition, options) = match open {
            Open::Read => (FILE_GENERIC_READ, FILE_OPEN, 0),
            Open::Write => (FILE_GENERIC_WRITE, FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE),
            Open::CreateNew => (FILE_GENERIC_WRITE, FILE_CREATE, FILE_NON_DIRECTORY_FILE),
            Open::Existing => (
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE,
            ),
        };
        let file = open_at(&dir.handle, name, access, disposition, options)?;
        match kind_of(&file)? {
            Kind::Symlink => return Err(escape()),
            _ if open != Open::Read && reparse_point(&file)? => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "the file is a reparse point (a cloud placeholder or similar); BiBCode does not change it",
                ));
            }
            _ => {}
        }
        if open == Open::Write {
            file.set_len(0)?;
        }
        Ok(file)
    }

    /// Creates folder `name` in held folder `parent` only while `parent` is under the root,
    /// checked just before and just after; a folder made in a parent that moved out is removed
    /// again through the parent's handle, only while it is still the folder made, and the call
    /// refused.
    fn create_contained(parent: &File, name: &OsStr, root: &File) -> io::Result<()> {
        beneath(parent, root)?;
        let created = match open_at(
            parent,
            name,
            DIRECTORY_ACCESS,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
        ) {
            Ok(file) => Some(identity(&file)?),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
            Err(error) => return Err(error),
        };
        #[cfg(test)]
        hooks::after_create(name);
        if beneath(parent, root).is_err() {
            if let Some(id) = created
                && let Err(error) = remove_empty(parent, name, Some(id))
            {
                // Something was put in it already: it stays where the moved parent went.
                return Err(io::Error::other(format!(
                    "{ESCAPE_MESSAGE}; the folder BiBCode had just made there could not be removed: {error}"
                )));
            }
            return Err(escape());
        }
        Ok(())
    }

    /// Deletes the open `file` through its handle: at once (POSIX semantics) where the file
    /// system can, else when the handle closes, here.
    fn dispose(file: File) -> io::Result<()> {
        let posix = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        };
        match set(&file, FileDispositionInfoEx, &posix) {
            Err(error)
                if error.raw_os_error().is_some_and(|code| {
                    [
                        ERROR_INVALID_PARAMETER,
                        ERROR_NOT_SUPPORTED,
                        ERROR_INVALID_FUNCTION,
                    ]
                    .iter()
                    .any(|known| known.cast_signed() == code)
                }) =>
            {
                set(
                    &file,
                    FileDispositionInfo,
                    &FILE_DISPOSITION_INFO { DeleteFile: true },
                )
            }
            other => other,
        }
    }

    /// Removes the file, symlink or junction `name` in `parent`, never a folder.
    fn remove_at(parent: &File, name: &OsStr) -> io::Result<()> {
        let file = open_at(parent, name, DELETE, FILE_OPEN, 0)?;
        if kind_of(&file)? == Kind::Directory {
            return Err(io::ErrorKind::IsADirectory.into());
        }
        dispose(file)
    }

    /// Removes the empty folder `name` in `parent` (with `id`, only while it is that folder).
    fn remove_empty(parent: &File, name: &OsStr, id: Option<Identity>) -> io::Result<()> {
        let file = open_at(parent, name, DELETE, FILE_OPEN, FILE_DIRECTORY_FILE)?;
        if kind_of(&file)? != Kind::Directory {
            return Err(escape());
        }
        if id.is_some() && Some(identity(&file)?) != id {
            return Err(io::Error::other("another folder took the name"));
        }
        dispose(file)
    }

    pub(super) fn remove_file(dir: &Dir, name: &OsStr) -> io::Result<()> {
        remove_at(&dir.handle, name)
    }

    pub(super) fn rename(
        dir: &Dir,
        name: &OsStr,
        to: &Dir,
        to_name: &OsStr,
        replace: Replace,
    ) -> io::Result<()> {
        let target = wide_name(to_name)?;
        let file = open_at(&dir.handle, name, DELETE, FILE_OPEN, 0)?;
        let header = offset_of!(FILE_RENAME_INFORMATION, FileName);
        let size = size_of::<FILE_RENAME_INFORMATION>() + target.len() * size_of::<u16>();
        let mut buffer = vec![0_u64; size.div_ceil(size_of::<u64>())];
        let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: `buffer` is aligned and large enough for the header and the name; the target
        // folder's handle stays open through the call. A no-replace rename fails rather than
        // replace anything, in one step.
        let status = unsafe {
            (*info).Anonymous.ReplaceIfExists = replace == Replace::Allowed;
            (*info).RootDirectory = to.handle.as_raw_handle();
            (*info).FileNameLength = (target.len() * size_of::<u16>()) as u32;
            std::ptr::copy_nonoverlapping(
                target.as_ptr(),
                info.cast::<u8>().add(header).cast::<u16>(),
                target.len(),
            );
            NtSetInformationFile(
                file.as_raw_handle(),
                &raw mut status_block,
                info.cast(),
                size as u32,
                FileRenameInformation,
            )
        };
        if status < 0 {
            return Err(nt_error(status));
        }
        Ok(())
    }

    /// Removes the folder `name` in `dir` and everything in it, never by path: renamed through
    /// the handle to a fresh name, opened by that name, emptied through handles, and its
    /// now-empty name removed only while it is still the folder that was opened.
    pub(super) fn remove_dir_all(dir: &Dir, name: &OsStr) -> Result<(), Removal> {
        let parked = OsString::from(format!(".bibcode-delete-{}", uuid::Uuid::new_v4().simple()));
        dir.rename(name, dir, &parked, Replace::Never)
            .map_err(Removal::Untouched)?;
        let opened = open_child(&dir.handle, &parked).and_then(|file| Ok((identity(&file)?, file)));
        let (id, folder) = match opened {
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
        let still_ours = || entry_at(&dir.handle, &parked).is_ok_and(|entry| entry.id == Some(id));
        let emptied = empty_tree(&folder, &dir.root_handle, 0);
        drop(folder);
        match emptied {
            // The held parent must still be under the root right before the parked name goes.
            Ok(()) if still_ours() => {
                #[cfg(test)]
                hooks::before_unlink(&parked);
                dir.contained()
                    .and_then(|()| remove_empty(&dir.handle, &parked, Some(id)))
                    .map_err(|error| Removal::Partial {
                        error,
                        left_at: parked,
                    })
            }
            Ok(()) => Err(Removal::Partial {
                error: io::Error::other("the folder moved while it was deleted"),
                left_at: parked,
            }),
            Err(error) => {
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

    /// Removes everything in held folder `folder`, depth first, through handles only, checking
    /// before each removal that the folder is still under the root.
    fn empty_tree(folder: &File, root: &File, depth: usize) -> io::Result<()> {
        if depth > MOST_DEPTH {
            return Err(io::Error::other(
                "the folder is nested too deeply to delete",
            ));
        }
        for child in names_of(folder)? {
            if entry_at(folder, &child)?.kind == Kind::Directory {
                let inner = open_child(folder, &child)?;
                empty_tree(&inner, root, depth + 1)?;
                drop(inner);
                beneath(folder, root)?;
                remove_empty(folder, &child, None)?;
            } else {
                #[cfg(test)]
                hooks::before_unlink(&child);
                beneath(folder, root)?;
                remove_at(folder, &child)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical_root() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(root.path()).unwrap();
        (root, path)
    }

    /// A link to the folder `target` at `link`: a symlink on Unix, a junction on Windows (which
    /// needs no privilege, and is what another process would put there).
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        junction::create(target, link).unwrap();
    }

    #[test]
    fn a_walk_refuses_a_symlinked_folder_and_works_by_name_through_the_handle() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root_path.join("real")).unwrap();
        link_dir(outside.path(), &root_path.join("link"));

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
        #[cfg(unix)]
        {
            std::fs::rename(root_path.join("real"), root_path.join("moved")).unwrap();
            std::os::unix::fs::symlink(outside.path(), root_path.join("real")).unwrap();
        }
        // Windows refuses to move any folder above one held open.
        #[cfg(windows)]
        assert!(
            std::fs::rename(root_path.join("real"), root_path.join("moved")).is_err(),
            "the folders above a held one stay in place"
        );
        dir.rename(
            OsStr::new("a.txt"),
            &dir,
            OsStr::new("b.txt"),
            Replace::Never,
        )
        .unwrap();
        #[cfg(unix)]
        {
            assert!(root_path.join("moved/new/deeper/b.txt").exists());
            assert!(is_escape(&dir.recheck().unwrap_err()));
        }
        #[cfg(windows)]
        assert!(root_path.join("real/new/deeper/b.txt").exists());
        assert!(!outside.path().join("b.txt").exists());
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
        link_dir(&outside, &root_path);
        assert!(is_escape(
            &Dir::open(&root, &root_path, false).err().expect("refused")
        ));
        // Another folder put where the root was.
        #[cfg(unix)]
        std::fs::remove_file(&root_path).unwrap();
        #[cfg(windows)]
        std::fs::remove_dir(&root_path).unwrap();
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
        let lock = |path: &Path, locked: bool| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let mode = if locked { 0o500 } else { 0o700 };
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            }
            // A read-only file cannot be deleted on Windows.
            #[cfg(windows)]
            {
                let file = path.join("file");
                let mut permissions = std::fs::metadata(&file)?.permissions();
                permissions.set_readonly(locked);
                std::fs::set_permissions(&file, permissions)
            }
        };
        lock(&root_path.join("stuck/locked"), true).unwrap();
        let result = dir.remove_dir_all(OsStr::new("stuck"));
        let parked = std::fs::read_dir(&root_path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        for name in &parked {
            let _ = lock(&root_path.join(name).join("locked"), false);
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
    fn a_parked_folder_moved_out_mid_delete_keeps_everything_not_yet_removed() {
        let (_root, root_path) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir(root_path.join("victim")).unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(root_path.join("victim").join(name), name).unwrap();
        }
        let dir = Dir::open(&root, &root_path, false).unwrap();
        let parked = std::rc::Rc::new(std::cell::RefCell::new(None));
        let seen = std::rc::Rc::clone(&parked);
        on_park(move |name| *seen.borrow_mut() = Some(name.to_os_string()));
        let (base, away) = (root_path.clone(), outside.join("moved"));
        let watched = std::rc::Rc::clone(&parked);
        // Before the first removal, another process moves the parked folder out.
        on_unlink(move |_| {
            if let Some(name) = watched.borrow_mut().take() {
                std::fs::rename(base.join(name), &away).unwrap();
            }
        });
        let result = dir.remove_dir_all(OsStr::new("victim"));
        clear_test_hooks();
        assert!(matches!(result, Err(Removal::Partial { .. })), "{result:?}");
        let mut left: Vec<_> = std::fs::read_dir(outside.join("moved"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(
            left,
            ["a", "b", "c"],
            "nothing was removed once it left the root"
        );
    }

    /// The held parent moved out of the root after the folder was emptied, before its parked
    /// name goes: the final removal is refused, so nothing is removed outside the root (#139
    /// X5 round 5).
    #[test]
    fn a_parent_moved_out_before_the_final_removal_keeps_the_parked_folder() {
        let (_root, root_path) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir_all(root_path.join("sub/victim")).unwrap();
        let dir = Dir::open(&root, &root_path.join("sub"), false).unwrap();
        let (held, away) = (root_path.join("sub"), outside.join("sub"));
        let moved_to = away.clone();
        // The folder is empty, so the only removal left is its parked name.
        on_unlink(move |_| std::fs::rename(&held, &moved_to).unwrap());
        let result = dir.remove_dir_all(OsStr::new("victim"));
        clear_test_hooks();
        assert!(matches!(result, Err(Removal::Partial { .. })), "{result:?}");
        let left: Vec<_> = std::fs::read_dir(&away)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            left.len() == 1 && left[0].starts_with(".bibcode-delete-"),
            "the parked folder stays in the parent that left: {left:?}"
        );
    }

    #[test]
    fn a_folder_made_in_a_moved_parent_that_cannot_be_removed_says_so() {
        let (_root, root_path) = canonical_root();
        let (_outside, outside) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        std::fs::create_dir(root_path.join("a")).unwrap();
        let (from, to) = (root_path.join("a"), outside.join("a"));
        // The parent moves out, and something lands in the folder just made, at once.
        on_create(move |name| {
            if name == "b" {
                std::fs::rename(&from, &to).unwrap();
                std::fs::write(to.join("b/theirs"), "x").unwrap();
            }
        });
        let error = Dir::open(&root, &root_path.join("a/b/c"), true)
            .err()
            .expect("refused");
        clear_test_hooks();
        assert!(!is_escape(&error));
        assert!(
            error.to_string().contains("could not be removed"),
            "{error}"
        );
        assert!(outside.join("a/b/theirs").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_no_replace_rename_is_refused_where_the_flag_is_unsupported() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        std::fs::write(root_path.join("a"), "a").unwrap();
        std::fs::create_dir(root_path.join("folder")).unwrap();
        force_no_replace_unsupported(true);
        let file = dir.rename(OsStr::new("a"), &dir, OsStr::new("b"), Replace::Never);
        let folder = dir.rename(
            OsStr::new("folder"),
            &dir,
            OsStr::new("elsewhere"),
            Replace::Never,
        );
        clear_test_hooks();
        // Files and folders alike: refused, typed, and nothing moved.
        for refused in [file.unwrap_err(), folder.unwrap_err()] {
            assert_eq!(refused.kind(), io::ErrorKind::Unsupported);
            assert_eq!(refused.to_string(), imp::NO_REPLACE_UNSUPPORTED);
        }
        assert_eq!(std::fs::read_to_string(root_path.join("a")).unwrap(), "a");
        assert!(!root_path.join("b").exists());
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

    /// A pinned folder, and every folder above it, cannot be renamed while the pin is held, so
    /// a path handed to the trash keeps naming it; its entries can still move.
    #[cfg(windows)]
    #[test]
    fn a_pinned_folder_and_the_folders_above_it_stay_in_place() {
        let (_root, root_path) = canonical_root();
        std::fs::create_dir_all(root_path.join("a/b")).unwrap();
        std::fs::write(root_path.join("a/b/victim.txt"), "v").unwrap();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path.join("a/b"), false).unwrap();
        let pin = dir.pin().unwrap();
        assert!(std::fs::rename(root_path.join("a/b"), root_path.join("a/c")).is_err());
        assert!(std::fs::rename(root_path.join("a"), root_path.join("z")).is_err());
        std::fs::rename(
            root_path.join("a/b/victim.txt"),
            root_path.join("victim.txt"),
        )
        .unwrap();
        drop(pin);
        // Without the pin, only the folders above the held one stay.
        std::fs::rename(root_path.join("a/b"), root_path.join("a/c")).unwrap();
        assert!(is_escape(&dir.recheck().unwrap_err()));
    }

    /// The held folder renamed away and another put at its path before the pin: the pin would
    /// hold the moved folder while the path handed to the trash names the unpinned stand-in,
    /// which could then become a junction out of the root. Refused (#216 review).
    #[cfg(windows)]
    #[test]
    fn a_pin_refuses_a_folder_replaced_at_its_path_before_it_was_pinned() {
        let (_root, root_path) = canonical_root();
        std::fs::create_dir(root_path.join("sub")).unwrap();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path.join("sub"), false).unwrap();
        std::fs::rename(root_path.join("sub"), root_path.join("held")).unwrap();
        std::fs::create_dir(root_path.join("sub")).unwrap();
        let error = dir.pin().expect_err("a stand-in folder is refused");
        assert!(is_escape(&error), "{error}");
        // With nothing swapped the pin holds.
        let held = Dir::open(&root, &root_path.join("held"), false).unwrap();
        drop(held.pin().unwrap());
    }

    /// An alternate data stream (`name:stream`), a separator, `.` or `..` is not one entry of
    /// the folder: refused, and nothing is written to the file the stream belongs to.
    #[cfg(windows)]
    #[test]
    fn a_name_that_is_not_one_plain_entry_is_refused() {
        let (_root, root_path) = canonical_root();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        std::fs::write(root_path.join("a.txt"), "a").unwrap();
        std::fs::create_dir(root_path.join("sub")).unwrap();
        for name in [
            "a.txt:stream",
            "a.txt::$DATA",
            "new.txt:stream",
            r"sub\x",
            "sub/x",
            ".",
            "..",
        ] {
            let name = OsStr::new(name);
            for open in [Open::Read, Open::Write, Open::CreateNew, Open::Existing] {
                assert!(dir.open_file(name, open).is_err(), "{name:?} {open:?}");
            }
            assert!(dir.entry(name).is_err(), "{name:?}");
            assert!(dir.open_dir(name).is_err(), "{name:?}");
            assert!(dir.remove_file(name).is_err(), "{name:?}");
            assert!(
                dir.rename(OsStr::new("a.txt"), &dir, name, Replace::Never)
                    .is_err(),
                "{name:?}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(root_path.join("a.txt")).unwrap(),
            "a"
        );
        assert!(std::fs::metadata(root_path.join("a.txt:stream")).is_err());
        assert!(!root_path.join("new.txt").exists());
        assert!(root_path.join("sub").is_dir());
    }

    /// The 8.3 short name of `path`'s last component, when the volume makes them.
    #[cfg(windows)]
    fn short_name(path: &Path) -> Option<OsString> {
        use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut buffer = vec![0_u16; 1024];
        // SAFETY: `wide` is NUL-terminated and `buffer` holds as many units as passed.
        let length = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                wide.as_ptr(),
                buffer.as_mut_ptr(),
                1024,
            )
        };
        let length = usize::try_from(length)
            .ok()
            .filter(|&n| n > 0 && n < 1024)?;
        let short = PathBuf::from(OsString::from_wide(&buffer[..length]));
        let name = short.file_name()?.to_os_string();
        (Some(name.as_os_str()) != path.file_name()).then_some(name)
    }

    /// A short name opens the entry it stands for, which a check of the long path never saw
    /// (`GIT~1` for `.git`): every operation refuses it.
    #[cfg(windows)]
    #[test]
    fn an_entry_named_by_its_short_name_is_refused() {
        let (_root, root_path) = canonical_root();
        std::fs::create_dir(root_path.join("a long folder name")).unwrap();
        std::fs::write(root_path.join("a long file name.txt"), "keep").unwrap();
        let (Some(short_file), Some(short_folder)) = (
            short_name(&root_path.join("a long file name.txt")),
            short_name(&root_path.join("a long folder name")),
        ) else {
            eprintln!("this volume makes no 8.3 names; nothing to check");
            return;
        };
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path, false).unwrap();
        for open in [Open::Read, Open::Write, Open::Existing] {
            assert!(dir.open_file(&short_file, open).is_err(), "{open:?}");
        }
        assert!(dir.entry(&short_file).is_err());
        assert!(dir.remove_file(&short_file).is_err());
        assert!(
            dir.rename(&short_file, &dir, OsStr::new("moved.txt"), Replace::Never)
                .is_err()
        );
        assert!(dir.open_dir(&short_folder).is_err());
        assert!(Dir::open(&root, &root_path.join(&short_folder), false).is_err());
        assert!(dir.remove_dir_all(&short_folder).is_err());
        assert_eq!(
            std::fs::read_to_string(root_path.join("a long file name.txt")).unwrap(),
            "keep"
        );
        assert!(root_path.join("a long folder name").is_dir());
    }

    /// A name in another letter case is the same entry on a case-insensitive folder: it works,
    /// and stays inside the root.
    #[cfg(windows)]
    #[test]
    fn a_name_in_another_letter_case_reaches_the_same_entry() {
        let (_root, root_path) = canonical_root();
        std::fs::create_dir(root_path.join("Real")).unwrap();
        let root = Root::new(&root_path).unwrap();
        let dir = Dir::open(&root, &root_path.join("REAL"), false).unwrap();
        std::io::Write::write_all(
            &mut dir.open_file(OsStr::new("a.txt"), Open::CreateNew).unwrap(),
            b"one",
        )
        .unwrap();
        dir.contained().unwrap();
        assert_eq!(
            std::fs::read_to_string(root_path.join("Real/a.txt")).unwrap(),
            "one"
        );
        assert_eq!(dir.kind(OsStr::new("A.TXT")).unwrap(), Kind::File);
    }

    /// A folder named by another spelling of a path (without `\\?\`, a device or UNC path) is
    /// not below the canonical root, whatever it resolves to.
    #[cfg(windows)]
    #[test]
    fn a_folder_spelled_outside_the_canonical_root_is_refused() {
        let (_root, root_path) = canonical_root();
        std::fs::create_dir(root_path.join("sub")).unwrap();
        let root = Root::new(&root_path).unwrap();
        let plain = crate::git::without_verbatim_prefix(root_path.join("sub"));
        assert_ne!(plain, root_path.join("sub"));
        let text = root_path.to_string_lossy().into_owned();
        let drive = text.trim_start_matches(r"\\?\");
        for folder in [
            plain,
            PathBuf::from(format!(r"\\.\{drive}\sub")),
            PathBuf::from(format!(r"\\?\GLOBALROOT\??\{drive}\sub")),
            PathBuf::from(format!(r"\\localhost\{}\sub", drive.replacen(':', "$", 1))),
            PathBuf::from(r"\\.\pipe\bibcode"),
        ] {
            let error = Dir::open(&root, &folder, false)
                .err()
                .unwrap_or_else(|| panic!("{folder:?} is refused"));
            assert!(is_escape(&error), "{folder:?}: {error}");
        }
    }
}
