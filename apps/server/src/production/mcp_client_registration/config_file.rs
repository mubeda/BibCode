//! Cursor and OpenCode: their documented user config, edited one key at a time. The file is
//! parsed into an order-keeping tree, only `bibcode` in the MCP section changes, and the result
//! replaces the file atomically (a temporary file in the same folder, the old file's mode, then
//! a rename). A file that is not plain JSON, comments included, is refused and left untouched:
//! rewriting it would drop what BiBCode cannot parse.

use std::{
    fmt,
    io::Write as _,
    path::{Path, PathBuf},
};

use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{MapAccess, SeqAccess, Visitor},
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::Value;

use super::{McpClient, SERVER_NAME, refusal};

/// A JSON value whose objects keep their keys in file order.
#[derive(Clone, Debug, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn string(text: &str) -> Self {
        Self::String(text.to_owned())
    }

    fn object(entries: impl IntoIterator<Item = (&'static str, Json)>) -> Self {
        Self::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Json, E> {
        serde_json::Number::from_f64(value)
            .map(Json::Number)
            .ok_or_else(|| E::custom("a number JSON cannot hold"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Json, E> {
        Ok(Json::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Json, E> {
        Ok(Json::String(value))
    }

    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_none<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Json, D::Error> {
        Json::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = sequence.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut entries: Vec<(String, Json)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            // A repeated key keeps its first place and its last value, as JSON readers do.
            match entries.iter_mut().find(|(existing, _)| *existing == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
        }
        Ok(Json::Object(entries))
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(value) => value.serialize(serializer),
            Self::String(value) => serializer.serialize_str(value),
            Self::Array(items) => {
                let mut sequence = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    sequence.serialize_element(item)?;
                }
                sequence.end()
            }
            Self::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

/// One tool's user config file and the object in it that holds MCP servers.
pub(super) struct ConfigFile {
    client: McpClient,
    directory: PathBuf,
    path: PathBuf,
    section: &'static str,
    /// The path as the person would write it (`~/…`), for messages.
    shown: String,
}

impl ConfigFile {
    /// `~/.cursor/mcp.json`, `{ "mcpServers": { "bibcode": { "command", "args" } } }`.
    pub(super) fn cursor(directory: PathBuf, home: &Path) -> Self {
        let path = directory.join("mcp.json");
        Self::new(McpClient::Cursor, directory, path, "mcpServers", home)
    }

    /// `~/.config/opencode/opencode.json` (or an existing `opencode.jsonc` when there is no
    /// `.json`), `{ "mcp": { "bibcode": { "type": "local", "command": [...], "enabled" } } }`.
    pub(super) fn opencode(directory: PathBuf, home: &Path) -> Self {
        let json = directory.join("opencode.json");
        let jsonc = directory.join("opencode.jsonc");
        let path = if !json.exists() && jsonc.exists() {
            jsonc
        } else {
            json
        };
        Self::new(McpClient::Opencode, directory, path, "mcp", home)
    }

    fn new(
        client: McpClient,
        directory: PathBuf,
        path: PathBuf,
        section: &'static str,
        home: &Path,
    ) -> Self {
        let shown = path.strip_prefix(home).map_or_else(
            |_| path.display().to_string(),
            |relative| format!("~/{}", relative.display()),
        );
        Self {
            client,
            directory,
            path,
            section,
            shown,
        }
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

    pub(super) async fn is_registered(&self) -> Result<bool, Value> {
        let document = self.load().await?;
        Ok(document
            .as_ref()
            .and_then(|document| section(document, self.section))
            .is_some_and(|servers| servers.iter().any(|(key, _)| key == SERVER_NAME)))
    }

    pub(super) async fn add(&self, launch: &[String]) -> Result<(), Value> {
        let mut document = self.load().await?.unwrap_or(Json::Object(Vec::new()));
        let Json::Object(entries) = &mut document else {
            unreachable!("load accepts only an object");
        };
        let servers = match entries.iter_mut().find(|(key, _)| key == self.section) {
            Some((_, servers)) => servers,
            None => {
                entries.push((self.section.to_owned(), Json::Object(Vec::new())));
                &mut entries.last_mut().expect("just pushed").1
            }
        };
        let Json::Object(servers) = servers else {
            unreachable!("load accepts only an object section");
        };
        let entry = self.entry(launch);
        match servers.iter_mut().find(|(key, _)| key == SERVER_NAME) {
            Some(existing) => existing.1 = entry,
            None => servers.push((SERVER_NAME.to_owned(), entry)),
        }
        self.write(&document).await
    }

    pub(super) async fn remove(&self) -> Result<(), Value> {
        let Some(mut document) = self.load().await? else {
            return Ok(());
        };
        let Json::Object(entries) = &mut document else {
            unreachable!("load accepts only an object");
        };
        let Some((_, Json::Object(servers))) =
            entries.iter_mut().find(|(key, _)| key == self.section)
        else {
            return Ok(());
        };
        let before = servers.len();
        servers.retain(|(key, _)| key != SERVER_NAME);
        if servers.len() == before {
            return Ok(());
        }
        self.write(&document).await
    }

    /// The file as an object whose MCP section, if any, is an object; `None` when it does not
    /// exist yet.
    async fn load(&self) -> Result<Option<Json>, Value> {
        let text = match tokio::fs::read_to_string(&self.path).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                tracing::warn!(client = self.client.id(), %error, "could not read an MCP client's config");
                return Err(refusal(
                    "failed",
                    &format!(
                        "BiBCode could not read {} ({}). Check its permissions, then try again.",
                        self.shown,
                        error.kind()
                    ),
                ));
            }
        };
        if text.trim().is_empty() {
            return Ok(None);
        }
        let document = serde_json::from_str::<Json>(&text)
            .map_err(|error| self.invalid(&format!("it isn't plain JSON ({error})")))?;
        let Json::Object(entries) = &document else {
            return Err(self.invalid("it isn't a JSON object"));
        };
        if entries
            .iter()
            .any(|(key, value)| key == self.section && !matches!(value, Json::Object(_)))
        {
            return Err(self.invalid(&format!("its \"{}\" isn't an object", self.section)));
        }
        Ok(Some(document))
    }

    fn invalid(&self, why: &str) -> Value {
        refusal(
            "invalid_config",
            &format!(
                "BiBCode left {} unchanged because {why}. Fix the file, or add BiBCode to {} by hand from Other MCP clients.",
                self.shown,
                self.client.label()
            ),
        )
    }

    async fn write(&self, document: &Json) -> Result<(), Value> {
        let mut contents = serde_json::to_vec_pretty(document).expect("a JSON tree serializes");
        contents.push(b'\n');
        let directory = self.directory.clone();
        let path = self.path.clone();
        let written =
            tokio::task::spawn_blocking(move || replace_file(&directory, &path, &contents)).await;
        match written {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                tracing::warn!(client = self.client.id(), %error, "could not write an MCP client's config");
                Err(refusal(
                    "failed",
                    &format!(
                        "BiBCode could not save {} ({}). Check its permissions, then try again.",
                        self.shown,
                        error.kind()
                    ),
                ))
            }
            Err(error) => {
                tracing::warn!(client = self.client.id(), %error, "writing an MCP client's config stopped");
                Err(refusal(
                    "failed",
                    "BiBCode could not save the change. Try again.",
                ))
            }
        }
    }
}

fn section<'a>(document: &'a Json, name: &str) -> Option<&'a [(String, Json)]> {
    let Json::Object(entries) = document else {
        return None;
    };
    entries.iter().find_map(|(key, value)| match value {
        Json::Object(servers) if key == name => Some(servers.as_slice()),
        _ => None,
    })
}

/// Replaces `path` with `contents` in one rename: through a symlink to its target, keeping the
/// old file's mode. The folder is created only for a tool BiBCode found installed.
fn replace_file(directory: &Path, path: &Path, contents: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let target = if path.is_symlink() {
        std::fs::canonicalize(path)?
    } else {
        path.to_path_buf()
    };
    let permissions = std::fs::metadata(&target)
        .ok()
        .map(|metadata| metadata.permissions());
    let parent = target.parent().unwrap_or(directory);
    let name = target.file_name().map_or_else(
        || "config".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let temporary = parent.join(format!(
        ".{name}.bibcode-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = std::fs::File::create_new(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        if let Some(permissions) = permissions {
            std::fs::set_permissions(&temporary, permissions)?;
        }
        std::fs::rename(&temporary, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
