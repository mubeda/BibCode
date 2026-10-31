//! Cursor and OpenCode: their documented user config, edited one key at a time.
//!
//! Every file the tool reads is looked at: OpenCode merges `opencode.json` and
//! `opencode.jsonc`, so a `bibcode` entry in either counts, and a change goes to the file that
//! already holds the entry. A file is parsed into an order-keeping tree, only `bibcode` in the
//! MCP section changes, and the result replaces the file atomically: a temporary file in the
//! same folder with the old file's mode and owner, a check that nobody saved the file since it
//! was read, then a rename. BiBCode's own changes to one tool run one at a time. A file with
//! comments can be read but not written without losing them, so a change it would need is
//! refused, as is a file that is not JSON at all and a link to a file outside the tool's own
//! folder. Extended attributes and ACLs on a replaced file are not kept.

use std::{
    collections::HashMap,
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, PoisonError},
    time::SystemTime,
};

use serde_json::Value;

use super::{
    McpClient, SERVER_NAME, State,
    ordered_json::{Json, parse_jsonc},
    refusal,
};

/// Reads and replaces before giving up on a file someone else keeps saving.
const ATTEMPTS: usize = 3;

/// One lock per config file path: BiBCode's own changes never race each other.
static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = LazyLock::new(Default::default);

/// When a test's stand-in for another program saves the file during a change.
#[cfg(all(test, unix))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Moment {
    /// After the read, just before the check that precedes the rename.
    BeforeCheck,
    /// Just after the rename: a save no check can stop.
    AfterRename,
}

/// A test's stand-in for another program saving the file during a change.
#[cfg(all(test, unix))]
type Interference = Arc<dyn Fn(&Path, Moment) + Send + Sync>;

/// One tool's user config files and the object in them that holds MCP servers.
#[derive(Clone)]
pub(super) struct ConfigFile {
    client: McpClient,
    directory: PathBuf,
    /// Every file the tool reads; a new entry goes to the first that exists, else the first.
    paths: Vec<PathBuf>,
    section: &'static str,
    home: PathBuf,
    /// Runs just before the check that precedes a rename, as another program's save would.
    #[cfg(all(test, unix))]
    interfere: Option<Interference>,
}

/// A file as read: its bytes and modification time tell whether it was saved since.
struct Loaded {
    path: PathBuf,
    original: Vec<u8>,
    modified: Option<SystemTime>,
    /// `false` for JSONC, which can be read but not written back.
    writable: bool,
    document: Json,
}

enum Change<'a> {
    Add(&'a [String]),
    Remove,
}

enum ReplaceError {
    /// Someone saved the file after it was read.
    Changed,
    /// Someone saved the file in the instant between the last check and the rename, so it
    /// no longer holds what BiBCode wrote. With no lock shared with the tool, this can be made
    /// rare but not impossible; it is reported, never claimed as success.
    Raced(PathBuf),
    Io(std::io::Error),
}

impl ConfigFile {
    /// `~/.cursor/mcp.json`, `{ "mcpServers": { "bibcode": { "command", "args" } } }`.
    pub(super) fn cursor(directory: PathBuf, home: &Path) -> Self {
        let paths = vec![directory.join("mcp.json")];
        Self::new(McpClient::Cursor, directory, paths, "mcpServers", home)
    }

    /// `opencode.json` and `opencode.jsonc` in OpenCode's config folder, which it merges:
    /// `{ "mcp": { "bibcode": { "type": "local", "command": [...], "enabled": true } } }`.
    pub(super) fn opencode(directory: PathBuf, home: &Path) -> Self {
        let paths = vec![
            directory.join("opencode.json"),
            directory.join("opencode.jsonc"),
        ];
        Self::new(McpClient::Opencode, directory, paths, "mcp", home)
    }

    fn new(
        client: McpClient,
        directory: PathBuf,
        paths: Vec<PathBuf>,
        section: &'static str,
        home: &Path,
    ) -> Self {
        Self {
            client,
            directory,
            paths,
            section,
            home: home.to_path_buf(),
            #[cfg(all(test, unix))]
            interfere: None,
        }
    }

    #[cfg(all(test, unix))]
    pub(super) fn with_interference(mut self, interfere: Interference) -> Self {
        self.interfere = Some(interfere);
        self
    }

    /// The path as the person would write it (`~/…`), for messages.
    fn shown(&self, path: &Path) -> String {
        let canonical_home = std::fs::canonicalize(&self.home).ok();
        [Some(self.home.as_path()), canonical_home.as_deref()]
            .into_iter()
            .flatten()
            .find_map(|home| path.strip_prefix(home).ok())
            .map_or_else(
                || path.display().to_string(),
                |relative| format!("~/{}", relative.display()),
            )
    }

    fn entry(&self, launch: &[String]) -> Json {
        let strings =
            |parts: &[String]| Json::Array(parts.iter().map(|part| Json::string(part)).collect());
        match self.client {
            McpClient::Opencode => Json::object([
                ("type", Json::string("local")),
                ("command", strings(launch)),
                ("enabled", Json::Bool(true)),
            ]),
            _ => Json::object([
                ("command", Json::string(&launch[0])),
                ("args", strings(&launch[1..])),
            ]),
        }
    }

    /// The command an entry launches, when it is one BiBCode can read and the tool runs it:
    /// for OpenCode a `"type": "local"` entry not turned off with `"enabled": false` (left out,
    /// it is on). Cursor's `mcp.json` has no such flag; Cursor turns servers off in its own
    /// settings.
    fn launch_of(&self, entry: &Json) -> Option<Vec<String>> {
        match self.client {
            McpClient::Opencode => {
                if entry.get("type").and_then(Json::as_str) != Some("local")
                    || matches!(entry.get("enabled"), Some(Json::Bool(false)))
                {
                    return None;
                }
                entry.get("command")?.strings()
            }
            _ => {
                let mut launch = vec![entry.get("command")?.as_str()?.to_owned()];
                if let Some(args) = entry.get("args") {
                    launch.extend(args.strings()?);
                }
                Some(launch)
            }
        }
    }

    /// Whether any file holds `bibcode`, and whether every such entry runs `launch`.
    pub(super) async fn read(&self, launch: Option<&[String]>) -> Result<State, Value> {
        let file = self.clone();
        let launch = launch.map(<[String]>::to_vec);
        blocking(move || file.read_now(launch.as_deref())).await
    }

    pub(super) async fn add(&self, launch: &[String]) -> Result<(), Value> {
        let file = self.clone();
        let launch = launch.to_vec();
        blocking(move || file.change_now(&Change::Add(&launch))).await
    }

    pub(super) async fn remove(&self) -> Result<(), Value> {
        let file = self.clone();
        blocking(move || file.change_now(&Change::Remove)).await
    }

    fn read_now(&self, launch: Option<&[String]>) -> Result<State, Value> {
        let loaded = self.load()?;
        let entries = loaded
            .iter()
            .filter_map(|file| self.servers(&file.document)?.get(SERVER_NAME))
            .collect::<Vec<_>>();
        if entries.is_empty() {
            return Ok(State::Absent);
        }
        Ok(State::Present {
            up_to_date: launch.map(|launch| {
                entries
                    .iter()
                    .all(|entry| self.launch_of(entry).as_deref() == Some(launch))
            }),
        })
    }

    fn servers<'a>(&self, document: &'a Json) -> Option<&'a Json> {
        document.get(self.section)
    }

    fn change_now(&self, change: &Change<'_>) -> Result<(), Value> {
        let locks = self.locks();
        let _guards = locks
            .iter()
            .map(|lock| lock.lock().unwrap_or_else(PoisonError::into_inner))
            .collect::<Vec<_>>();
        for _ in 0..ATTEMPTS {
            match self.change_once(change) {
                Err(ReplaceError::Changed) => {}
                Err(ReplaceError::Raced(path)) => {
                    return Err(refusal(
                        "failed",
                        &format!(
                            "Another app changed {} at the same time as BiBCode. Check the file, then try again.",
                            self.shown(&path)
                        ),
                    ));
                }
                Err(ReplaceError::Io(error)) => {
                    tracing::warn!(client = self.client.id(), %error, "could not save an MCP client's config");
                    return Err(refusal(
                        "failed",
                        &format!(
                            "BiBCode could not save {}'s settings ({}). Check the file's permissions, then try again.",
                            self.client.label(),
                            error.kind()
                        ),
                    ));
                }
                Ok(result) => return result,
            }
        }
        Err(refusal(
            "failed",
            &format!(
                "{} kept changing while BiBCode was saving it. Close the apps that edit it, then try again.",
                self.shown(&self.paths[0])
            ),
        ))
    }

    /// One read and replace. The outer `Err` asks for another attempt or reports an I/O
    /// failure; the inner one is a refusal to change anything.
    fn change_once(&self, change: &Change<'_>) -> Result<Result<(), Value>, ReplaceError> {
        let loaded = match self.load() {
            Ok(loaded) => loaded,
            Err(refused) => return Ok(Err(refused)),
        };
        let holding = loaded
            .iter()
            .filter(|file| {
                self.servers(&file.document)
                    .and_then(|servers| servers.get(SERVER_NAME))
                    .is_some()
            })
            .collect::<Vec<_>>();
        let targets: Vec<Option<&Loaded>> = match change {
            Change::Remove => holding.into_iter().map(Some).collect(),
            Change::Add(_) if holding.is_empty() => vec![loaded.first()],
            Change::Add(_) => holding.into_iter().map(Some).collect(),
        };
        let mut writes = Vec::with_capacity(targets.len());
        for target in targets {
            let (path, mut document) = match target {
                Some(file) if !file.writable => {
                    return Ok(Err(self.invalid(
                        &file.path,
                        "it has comments or trailing commas, which BiBCode would lose",
                    )));
                }
                Some(file) => (file.path.clone(), file.document.clone()),
                None => (self.paths[0].clone(), Json::Object(Vec::new())),
            };
            let destination = match self.destination(&path) {
                Ok(destination) => destination,
                Err(refused) => return Ok(Err(refused)),
            };
            self.apply(&mut document, change);
            let mut contents =
                serde_json::to_vec_pretty(&document).expect("a JSON tree serializes");
            contents.push(b'\n');
            writes.push((destination, target, contents));
        }
        for (destination, target, contents) in writes {
            self.replace(&destination, target, &contents)?;
        }
        Ok(Ok(()))
    }

    fn apply(&self, document: &mut Json, change: &Change<'_>) {
        let Json::Object(entries) = document else {
            unreachable!("load accepts only an object");
        };
        let servers = match entries.iter_mut().position(|(key, _)| key == self.section) {
            Some(index) => &mut entries[index].1,
            None => {
                entries.push((self.section.to_owned(), Json::Object(Vec::new())));
                &mut entries.last_mut().expect("just pushed").1
            }
        };
        let Json::Object(servers) = servers else {
            unreachable!("load accepts only an object section");
        };
        match change {
            Change::Add(launch) => {
                let entry = self.entry(launch);
                match servers.iter_mut().find(|(key, _)| key == SERVER_NAME) {
                    Some(existing) => existing.1 = entry,
                    None => servers.push((SERVER_NAME.to_owned(), entry)),
                }
            }
            Change::Remove => servers.retain(|(key, _)| key != SERVER_NAME),
        }
    }

    /// Every file that exists, each an object whose MCP section, if any, is an object.
    fn load(&self) -> Result<Vec<Loaded>, Value> {
        let mut loaded = Vec::new();
        for path in &self.paths {
            let original = match std::fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    tracing::warn!(client = self.client.id(), %error, "could not read an MCP client's config");
                    return Err(refusal(
                        "failed",
                        &format!(
                            "BiBCode could not read {} ({}). Check its permissions, then try again.",
                            self.shown(path),
                            error.kind()
                        ),
                    ));
                }
            };
            let modified = std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok();
            let text = String::from_utf8_lossy(&original);
            let (document, writable) = if text.trim().is_empty() {
                (Json::Object(Vec::new()), true)
            } else {
                match serde_json::from_str::<Json>(&text) {
                    Ok(document) => (document, true),
                    Err(strict) => match parse_jsonc(&text) {
                        Ok(document) => (document, false),
                        Err(_) => {
                            return Err(
                                self.invalid(path, &format!("it isn't valid JSON ({strict})"))
                            );
                        }
                    },
                }
            };
            if !matches!(document, Json::Object(_)) {
                return Err(self.invalid(path, "it isn't a JSON object"));
            }
            if document
                .get(self.section)
                .is_some_and(|servers| !matches!(servers, Json::Object(_)))
            {
                return Err(
                    self.invalid(path, &format!("its \"{}\" isn't an object", self.section))
                );
            }
            loaded.push(Loaded {
                path: path.clone(),
                original,
                modified,
                writable,
                document,
            });
        }
        Ok(loaded)
    }

    fn invalid(&self, path: &Path, why: &str) -> Value {
        refusal(
            "invalid_config",
            &format!(
                "BiBCode left {} unchanged because {why}. Fix the file, or add BiBCode to {} by hand from Other MCP clients.",
                self.shown(path),
                self.client.label()
            ),
        )
    }

    /// Where a write lands: the file, or the file a link inside the tool's folder points to.
    /// A link out of that folder (a dotfiles checkout, say) is not BiBCode's to replace.
    fn destination(&self, path: &Path) -> Result<PathBuf, Value> {
        if !path.is_symlink() {
            return Ok(path.to_path_buf());
        }
        let target = std::fs::canonicalize(path)
            .map_err(|_| self.invalid(path, "it is a link to a file that does not exist"))?;
        let folder =
            std::fs::canonicalize(&self.directory).unwrap_or_else(|_| self.directory.clone());
        if target.starts_with(&folder) {
            Ok(target)
        } else {
            Err(self.invalid(
                path,
                &format!(
                    "it is a link to {}, outside {}",
                    self.shown(&target),
                    self.shown(&self.directory)
                ),
            ))
        }
    }

    fn locks(&self) -> Vec<Arc<Mutex<()>>> {
        let mut table = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        self.paths
            .iter()
            .map(|path| table.entry(path.clone()).or_default().clone())
            .collect()
    }

    /// Replaces `destination` with `contents` in one rename, keeping the old file's mode and
    /// owner, unless the file is no longer what `read` saw.
    fn replace(
        &self,
        destination: &Path,
        read: Option<&Loaded>,
        contents: &[u8],
    ) -> Result<(), ReplaceError> {
        std::fs::create_dir_all(&self.directory).map_err(ReplaceError::Io)?;
        let parent = destination.parent().unwrap_or(&self.directory);
        let name = destination.file_name().map_or_else(
            || "config".to_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        let temporary = parent.join(format!(
            ".{name}.bibcode-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let result = (|| {
            let mut file = std::fs::File::create_new(&temporary).map_err(ReplaceError::Io)?;
            file.write_all(contents).map_err(ReplaceError::Io)?;
            file.sync_all().map_err(ReplaceError::Io)?;
            drop(file);
            if let Ok(metadata) = std::fs::metadata(destination) {
                std::fs::set_permissions(&temporary, metadata.permissions())
                    .map_err(ReplaceError::Io)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt as _;
                    let created = std::fs::metadata(&temporary).map_err(ReplaceError::Io)?;
                    if (created.uid(), created.gid()) != (metadata.uid(), metadata.gid()) {
                        std::os::unix::fs::chown(
                            &temporary,
                            Some(metadata.uid()),
                            Some(metadata.gid()),
                        )
                        .map_err(ReplaceError::Io)?;
                    }
                }
            }
            #[cfg(all(test, unix))]
            if let Some(interfere) = &self.interfere {
                interfere(destination, Moment::BeforeCheck);
            }
            if !unchanged(destination, read).map_err(ReplaceError::Io)? {
                return Err(ReplaceError::Changed);
            }
            std::fs::rename(&temporary, destination).map_err(ReplaceError::Io)?;
            #[cfg(all(test, unix))]
            if let Some(interfere) = &self.interfere {
                interfere(destination, Moment::AfterRename);
            }
            // Read back: a save landing between the check and the rename leaves the file
            // without what BiBCode wrote.
            match std::fs::read(destination) {
                Ok(saved) if saved == contents => Ok(()),
                Ok(_) => Err(ReplaceError::Raced(destination.to_path_buf())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Err(ReplaceError::Raced(destination.to_path_buf()))
                }
                Err(error) => Err(ReplaceError::Io(error)),
            }
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

/// Whether the file is still what was read: absent if it was absent, else the same bytes
/// and modification time.
fn unchanged(path: &Path, read: Option<&Loaded>) -> std::io::Result<bool> {
    let current = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    Ok(match (read, current) {
        (None, None) => true,
        (Some(read), Some(current)) => {
            current == read.original
                && std::fs::metadata(path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    == read.modified
        }
        _ => false,
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Value> + Send + 'static,
) -> Result<T, Value> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "an MCP client config change stopped");
            Err(refusal(
                "failed",
                "BiBCode could not finish the change. Try again.",
            ))
        })
}
