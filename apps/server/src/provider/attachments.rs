use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, OwnedMutexGuard};
use url::Url;
use uuid::Uuid;

use crate::orchestration::AttachmentReference;

pub(crate) const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 8;
const MAX_ENCODED_ATTACHMENT_BYTES: usize = 4 * MAX_ATTACHMENT_BYTES.div_ceil(3);
const MAX_ATTACHMENT_NAME_LENGTH: usize = 255;
const MAX_ATTACHED_FILES_TEXT_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct AttachmentMaterializer {
    state_dir: PathBuf,
    attachments_dir: PathBuf,
    root_initialized: Arc<AtomicBool>,
    root_transaction: Arc<Mutex<()>>,
    #[cfg(test)]
    after_stage_write: Option<Arc<AttachmentPrepareTestPause>>,
    #[cfg(test)]
    after_final_publication: Option<Arc<AttachmentPrepareTestPause>>,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct AttachmentPrepareTestPause {
    reached: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}

#[derive(Debug)]
pub(crate) struct PreparedAttachmentBatch {
    attachments: Vec<Value>,
    references: Vec<AttachmentReference>,
    owned_finals: Vec<PathBuf>,
    owned_stages: Vec<PathBuf>,
    _root_transaction: Option<OwnedMutexGuard<()>>,
}

impl PreparedAttachmentBatch {
    fn new(capacity: usize, root_transaction: Option<OwnedMutexGuard<()>>) -> Self {
        Self {
            attachments: Vec::with_capacity(capacity),
            references: Vec::with_capacity(capacity),
            owned_finals: Vec::new(),
            owned_stages: Vec::new(),
            _root_transaction: root_transaction,
        }
    }

    pub(crate) fn attachments(&self) -> &[Value] {
        &self.attachments
    }

    pub(crate) fn references(&self) -> &[AttachmentReference] {
        &self.references
    }

    pub(crate) fn commit(mut self) {
        self.owned_finals.clear();
    }

    fn remove_stage(
        &mut self,
        staged: &Path,
        id: &str,
    ) -> Result<(), AttachmentMaterializationError> {
        match std::fs::remove_file(staged) {
            Ok(()) => {
                self.owned_stages.retain(|path| path != staged);
                Ok(())
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                self.owned_stages.retain(|path| path != staged);
                Ok(())
            }
            Err(source) => Err(AttachmentMaterializationError::Write {
                id: id.to_owned(),
                source,
            }),
        }
    }
}

impl Drop for PreparedAttachmentBatch {
    fn drop(&mut self) {
        for path in self.owned_stages.iter().rev() {
            let _ = std::fs::remove_file(path);
        }
        for path in self.owned_finals.iter().rev() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MaterializedAttachment {
    pub attachment_type: String,
    pub name: String,
    pub mime_type: String,
    pub base64_data: String,
    pub file_url: String,
    pub path: PathBuf,
}

#[derive(Debug, Error)]
pub(crate) enum AttachmentMaterializationError {
    #[error("invalid attachment metadata: {0}")]
    InvalidMetadata(String),
    #[error("invalid attachment id {0}")]
    InvalidId(String),
    #[error("failed to access attachment directory {path}: {source}")]
    AttachmentDirectory {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read attachment {id}: {source}")]
    Read { id: String, source: std::io::Error },
    #[error("failed to write attachment {id}: {source}")]
    Write { id: String, source: std::io::Error },
    #[error("attachment {0} resolves outside the attachment directory")]
    EscapesDirectory(String),
    #[error("attachment {0} cannot be represented as a file URL")]
    InvalidFileUrl(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentInput {
    #[serde(rename = "type")]
    attachment_type: String,
    id: String,
    name: String,
    mime_type: String,
    size_bytes: u64,
    #[serde(default)]
    data_url: Option<String>,
}

impl AttachmentMaterializer {
    pub(crate) fn new(attachments_dir: PathBuf) -> Self {
        let state_dir = attachments_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();
        Self {
            state_dir,
            attachments_dir,
            root_initialized: Arc::new(AtomicBool::new(false)),
            // ponytail: this root-wide in-process lock assumes one server process per state root;
            // add an OS file lock if shared multi-process state roots become supported.
            root_transaction: Arc::new(Mutex::new(())),
            #[cfg(test)]
            after_stage_write: None,
            #[cfg(test)]
            after_final_publication: None,
        }
    }

    #[cfg(test)]
    fn with_pause_after_stage_write(mut self, pause: Arc<AttachmentPrepareTestPause>) -> Self {
        self.after_stage_write = Some(pause);
        self
    }

    #[cfg(test)]
    fn with_pause_after_final_publication(
        mut self,
        pause: Arc<AttachmentPrepareTestPause>,
    ) -> Self {
        self.after_final_publication = Some(pause);
        self
    }

    pub(crate) async fn prepare(
        &self,
        attachments: Vec<Value>,
    ) -> Result<PreparedAttachmentBatch, AttachmentMaterializationError> {
        if attachments.is_empty() {
            return Ok(PreparedAttachmentBatch::new(0, None));
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(AttachmentMaterializationError::InvalidMetadata(
                "at most eight attachments are allowed".to_owned(),
            ));
        }
        let transaction = self.root_transaction.clone().lock_owned().await;
        let mut prepared = PreparedAttachmentBatch::new(attachments.len(), Some(transaction));
        let root = self.canonical_root(true).await?;
        if !self.root_initialized.load(Ordering::Acquire) {
            self.scavenge_stages(&root).await?;
            self.root_initialized.store(true, Ordering::Release);
        }
        for value in attachments {
            let data_url_present = value.get("dataUrl").is_some();
            let attachment: AttachmentInput = serde_json::from_value(value).map_err(|error| {
                AttachmentMaterializationError::InvalidMetadata(error.to_string())
            })?;
            validate_attachment(&attachment)?;
            let bytes = match (data_url_present, attachment.data_url.as_deref()) {
                (true, Some(data_url)) => {
                    let bytes = decode_data_url(data_url, &attachment.mime_type)?;
                    if bytes.len() != usize::try_from(attachment.size_bytes).unwrap_or(usize::MAX) {
                        return Err(AttachmentMaterializationError::InvalidMetadata(
                            "claimed size does not match decoded data".to_owned(),
                        ));
                    }
                    self.publish(&root, &attachment.id, &bytes, &mut prepared)
                        .await?;
                    bytes
                }
                (false, None) => {
                    let existing = self.read_canonical(&root, &attachment.id).await?;
                    if existing.len()
                        != usize::try_from(attachment.size_bytes).unwrap_or(usize::MAX)
                    {
                        return Err(AttachmentMaterializationError::InvalidMetadata(
                            "claimed size does not match prepared file".to_owned(),
                        ));
                    }
                    existing
                }
                _ => {
                    return Err(AttachmentMaterializationError::InvalidMetadata(
                        "dataUrl must be a base64 string when present".to_owned(),
                    ));
                }
            };
            let canonical_path = self.canonical_path(&root, &attachment.id).await?;
            debug_assert!(canonical_path.starts_with(&root));
            prepared.attachments.push(serde_json::json!({
                "type": attachment.attachment_type,
                "id": attachment.id,
                "name": attachment.name,
                "mimeType": attachment.mime_type,
                "sizeBytes": attachment.size_bytes,
            }));
            prepared.references.push(AttachmentReference {
                attachment_id: attachment.id,
                content_digest: Some(crate::crypto::sha256_hex(&bytes)),
                size_bytes: i64::try_from(attachment.size_bytes)
                    .expect("validated attachment size"),
            });
        }
        Ok(prepared)
    }

    pub(crate) async fn reconcile_startup(
        &self,
        referenced: &HashSet<String>,
    ) -> Result<(), AttachmentMaterializationError> {
        let _transaction = self.root_transaction.clone().lock_owned().await;
        let root = self.canonical_root(true).await?;
        let mut entries = tokio::fs::read_dir(&root).await.map_err(|source| {
            AttachmentMaterializationError::AttachmentDirectory {
                path: root.clone(),
                source,
            }
        })?;
        while let Some(entry) = entries.next_entry().await.map_err(|source| {
            AttachmentMaterializationError::AttachmentDirectory {
                path: root.clone(),
                source,
            }
        })? {
            let metadata = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(
                    |source| AttachmentMaterializationError::AttachmentDirectory {
                        path: root.clone(),
                        source,
                    },
                )?;
            if metadata.file_type().is_symlink()
                || is_reparse_point(&metadata)
                || !metadata.is_file()
            {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with('.') && name.ends_with(".upload") {
                remove_attachment_leaf(&entry.path(), &root).await?;
                continue;
            }
            if validate_attachment_id(name).is_err() {
                continue;
            }
            match self.canonical_path(&root, name).await {
                Ok(_) if referenced.contains(name) => {}
                Ok(path) => remove_attachment_leaf(&path, &root).await?,
                Err(AttachmentMaterializationError::EscapesDirectory(_)) => {}
                Err(error) => return Err(error),
            }
        }
        self.root_initialized.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) async fn materialize(
        &self,
        attachments: Vec<Value>,
    ) -> Result<Vec<MaterializedAttachment>, AttachmentMaterializationError> {
        if attachments.is_empty() {
            return Ok(Vec::new());
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(AttachmentMaterializationError::InvalidMetadata(
                "at most eight attachments are allowed".to_owned(),
            ));
        }
        let root = self.canonical_root(false).await?;
        let mut materialized = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            if attachment.get("dataUrl").is_some() {
                return Err(AttachmentMaterializationError::InvalidMetadata(
                    "prepared attachments cannot contain dataUrl".to_owned(),
                ));
            }
            let attachment: AttachmentInput =
                serde_json::from_value(attachment).map_err(|error| {
                    AttachmentMaterializationError::InvalidMetadata(error.to_string())
                })?;
            validate_attachment(&attachment)?;
            let path = self.canonical_path(&root, &attachment.id).await?;
            let bytes = self.read_canonical(&root, &attachment.id).await?;
            if bytes.len() != usize::try_from(attachment.size_bytes).unwrap_or(usize::MAX) {
                return Err(AttachmentMaterializationError::InvalidMetadata(
                    "claimed size does not match prepared file".to_owned(),
                ));
            }
            let file_url = Url::from_file_path(&path)
                .map_err(|()| AttachmentMaterializationError::InvalidFileUrl(attachment.id))?
                .to_string();
            materialized.push(MaterializedAttachment {
                attachment_type: attachment.attachment_type,
                name: attachment.name,
                mime_type: attachment.mime_type,
                base64_data: STANDARD.encode(bytes),
                file_url,
                path,
            });
        }
        Ok(materialized)
    }

    pub(crate) async fn resolve_existing_file(
        &self,
        id: &str,
    ) -> Result<PathBuf, AttachmentMaterializationError> {
        validate_attachment_id(id)?;
        let root = self.canonical_root(false).await?;
        self.canonical_path(&root, id).await
    }

    async fn canonical_root(
        &self,
        create: bool,
    ) -> Result<PathBuf, AttachmentMaterializationError> {
        if create {
            tokio::fs::create_dir_all(&self.state_dir)
                .await
                .map_err(
                    |source| AttachmentMaterializationError::AttachmentDirectory {
                        path: self.state_dir.clone(),
                        source,
                    },
                )?;
        }
        let state_dir = tokio::fs::canonicalize(&self.state_dir)
            .await
            .map_err(
                |source| AttachmentMaterializationError::AttachmentDirectory {
                    path: self.state_dir.clone(),
                    source,
                },
            )?;
        match tokio::fs::symlink_metadata(&self.attachments_dir).await {
            Ok(metadata) if metadata.file_type().is_symlink() || is_reparse_point(&metadata) => {
                return Err(AttachmentMaterializationError::EscapesDirectory(
                    "attachments".to_owned(),
                ));
            }
            Ok(_) => {}
            Err(source) if create && source.kind() == std::io::ErrorKind::NotFound => {
                match tokio::fs::create_dir(&self.attachments_dir).await {
                    Ok(()) => {}
                    Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(source) => {
                        return Err(AttachmentMaterializationError::AttachmentDirectory {
                            path: self.attachments_dir.clone(),
                            source,
                        });
                    }
                }
            }
            Err(source) => {
                return Err(AttachmentMaterializationError::AttachmentDirectory {
                    path: self.attachments_dir.clone(),
                    source,
                });
            }
        }
        let metadata = tokio::fs::symlink_metadata(&self.attachments_dir)
            .await
            .map_err(
                |source| AttachmentMaterializationError::AttachmentDirectory {
                    path: self.attachments_dir.clone(),
                    source,
                },
            )?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(AttachmentMaterializationError::EscapesDirectory(
                "attachments".to_owned(),
            ));
        }
        if !metadata.is_dir() {
            return Err(AttachmentMaterializationError::AttachmentDirectory {
                path: self.attachments_dir.clone(),
                source: std::io::Error::other("attachment root is not a directory"),
            });
        }
        tokio::fs::canonicalize(&self.attachments_dir)
            .await
            .and_then(|root| {
                if root.starts_with(&state_dir) {
                    Ok(root)
                } else {
                    Err(std::io::Error::other(
                        "attachment root escapes state directory",
                    ))
                }
            })
            .map_err(
                |source| AttachmentMaterializationError::AttachmentDirectory {
                    path: self.attachments_dir.clone(),
                    source,
                },
            )
    }

    async fn canonical_path(
        &self,
        root: &Path,
        id: &str,
    ) -> Result<PathBuf, AttachmentMaterializationError> {
        let leaf = root.join(id);
        let metadata = tokio::fs::symlink_metadata(&leaf).await.map_err(|source| {
            AttachmentMaterializationError::Read {
                id: id.to_owned(),
                source,
            }
        })?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(AttachmentMaterializationError::EscapesDirectory(
                id.to_owned(),
            ));
        }
        if !metadata.is_file() {
            return Err(AttachmentMaterializationError::Read {
                id: id.to_owned(),
                source: std::io::Error::other("attachment is not a regular file"),
            });
        }
        let path = tokio::fs::canonicalize(leaf).await.map_err(|source| {
            AttachmentMaterializationError::Read {
                id: id.to_owned(),
                source,
            }
        })?;
        if path.starts_with(root) {
            Ok(path)
        } else {
            Err(AttachmentMaterializationError::EscapesDirectory(
                id.to_owned(),
            ))
        }
    }

    async fn read_canonical(
        &self,
        root: &Path,
        id: &str,
    ) -> Result<Vec<u8>, AttachmentMaterializationError> {
        let path = self.canonical_path(root, id).await?;
        let file = tokio::fs::File::open(path).await.map_err(|source| {
            AttachmentMaterializationError::Read {
                id: id.to_owned(),
                source,
            }
        })?;
        let mut bytes = Vec::with_capacity(MAX_ATTACHMENT_BYTES.min(4096));
        file.take((MAX_ATTACHMENT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|source| AttachmentMaterializationError::Read {
                id: id.to_owned(),
                source,
            })?;
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(AttachmentMaterializationError::InvalidMetadata(
                "prepared attachment exceeds 10 MiB".to_owned(),
            ));
        }
        Ok(bytes)
    }

    async fn publish(
        &self,
        root: &Path,
        id: &str,
        bytes: &[u8],
        prepared: &mut PreparedAttachmentBatch,
    ) -> Result<(), AttachmentMaterializationError> {
        let staged = root.join(format!(".{id}.{}.upload", Uuid::new_v4()));
        let file =
            create_stage_file(&staged).map_err(|source| AttachmentMaterializationError::Write {
                id: id.to_owned(),
                source,
            })?;
        prepared.owned_stages.push(staged.clone());
        let mut file = tokio::fs::File::from_std(file);
        let write = async {
            file.write_all(bytes).await?;
            #[cfg(test)]
            if let Some(pause) = &self.after_stage_write {
                pause.reached.notify_one();
                pause.resume.notified().await;
            }
            file.flush().await
        }
        .await;
        if let Err(source) = write {
            return Err(AttachmentMaterializationError::Write {
                id: id.to_owned(),
                source,
            });
        }
        drop(file);
        let final_path = root.join(id);
        match std::fs::hard_link(&staged, &final_path) {
            Ok(()) => {
                #[cfg(test)]
                if let Some(pause) = &self.after_final_publication {
                    pause.reached.notify_one();
                    pause.resume.notified().await;
                }
                prepared.owned_finals.push(final_path);
                prepared.remove_stage(&staged, id)?;
                Ok(())
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = self.read_canonical(root, id).await;
                prepared.remove_stage(&staged, id)?;
                match existing {
                    Ok(existing) if existing == bytes => Ok(()),
                    Ok(_) => Err(AttachmentMaterializationError::InvalidMetadata(
                        "attachment id already exists with different content".to_owned(),
                    )),
                    Err(error) => Err(error),
                }
            }
            Err(source) => Err(AttachmentMaterializationError::Write {
                id: id.to_owned(),
                source,
            }),
        }
    }

    async fn scavenge_stages(&self, root: &Path) -> Result<(), AttachmentMaterializationError> {
        let mut entries = tokio::fs::read_dir(root).await.map_err(|source| {
            AttachmentMaterializationError::AttachmentDirectory {
                path: root.to_path_buf(),
                source,
            }
        })?;
        while let Some(entry) = entries.next_entry().await.map_err(|source| {
            AttachmentMaterializationError::AttachmentDirectory {
                path: root.to_path_buf(),
                source,
            }
        })? {
            let metadata = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(
                    |source| AttachmentMaterializationError::AttachmentDirectory {
                        path: root.to_path_buf(),
                        source,
                    },
                )?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && !is_reparse_point(&metadata)
                && name.starts_with('.')
                && name.ends_with(".upload")
            {
                remove_attachment_leaf(&entry.path(), root).await?;
            }
        }
        Ok(())
    }
}

async fn remove_attachment_leaf(
    path: &Path,
    root: &Path,
) -> Result<(), AttachmentMaterializationError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(AttachmentMaterializationError::AttachmentDirectory {
            path: root.to_path_buf(),
            source,
        }),
    }
}

pub(crate) fn prompt_parts(text: Option<&str>, attachments: Vec<Value>) -> Vec<Value> {
    let mut parts = Vec::with_capacity(attachments.len() + usize::from(text.is_some()));
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        parts.push(serde_json::json!({ "type": "text", "text": text }));
    }
    parts.extend(attachments);
    parts
}

fn validate_attachment_id(id: &str) -> Result<(), AttachmentMaterializationError> {
    let mut components = Path::new(id).components();
    let valid_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let valid_characters = !id.is_empty()
        && id.len() <= 128
        && !is_windows_reserved_name(id)
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if valid_component && valid_characters {
        Ok(())
    } else {
        Err(AttachmentMaterializationError::InvalidId(id.to_owned()))
    }
}

fn validate_attachment(attachment: &AttachmentInput) -> Result<(), AttachmentMaterializationError> {
    validate_attachment_id(&attachment.id)?;
    let valid_name = !attachment.name.is_empty()
        && attachment.name.trim() == attachment.name
        && attachment.name.encode_utf16().count() <= MAX_ATTACHMENT_NAME_LENGTH
        && attachment.name != "."
        && attachment.name != ".."
        && !attachment
            .name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'));
    if !valid_name {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "invalid attachment name".to_owned(),
        ));
    }
    let valid_mime = !attachment.mime_type.is_empty()
        && attachment.mime_type.trim() == attachment.mime_type
        && attachment.mime_type.len() <= 100
        && attachment
            .mime_type
            .split_once('/')
            .is_some_and(|(kind, subtype)| {
                !kind.is_empty()
                    && !subtype.is_empty()
                    && kind.bytes().chain(subtype.bytes()).all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-')
                    })
            });
    let matching_type = match attachment.attachment_type.as_str() {
        "image" => is_image_mime(&attachment.mime_type),
        "file" => !is_image_mime(&attachment.mime_type),
        _ => false,
    };
    if !valid_mime || !matching_type {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "attachment type and MIME type do not match".to_owned(),
        ));
    }
    if attachment.size_bytes > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "attachment exceeds 10 MiB".to_owned(),
        ));
    }
    Ok(())
}

fn decode_data_url(
    data_url: &str,
    expected_mime: &str,
) -> Result<Vec<u8>, AttachmentMaterializationError> {
    let (mime_type, encoded) = data_url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .filter(|(mime_type, _)| *mime_type == expected_mime && !mime_type.contains(';'))
        .ok_or_else(|| {
            AttachmentMaterializationError::InvalidMetadata(
                "attachment dataUrl must be base64 with the declared MIME type".to_owned(),
            )
        })?;
    let _ = mime_type;
    if encoded.len() > MAX_ENCODED_ATTACHMENT_BYTES {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "attachment dataUrl exceeds the base64 size limit".to_owned(),
        ));
    }
    let decoded = STANDARD.decode(encoded).map_err(|_| {
        AttachmentMaterializationError::InvalidMetadata(
            "attachment dataUrl contains invalid base64".to_owned(),
        )
    })?;
    if decoded.len() > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "attachment exceeds 10 MiB".to_owned(),
        ));
    }
    Ok(decoded)
}

pub(crate) fn split_native_images_and_file_references(
    attachments: Vec<MaterializedAttachment>,
) -> (Vec<MaterializedAttachment>, Vec<MaterializedAttachment>) {
    attachments
        .into_iter()
        .partition(|attachment| attachment.attachment_type == "image")
}

pub(crate) fn append_file_references(
    text: String,
    files: &[MaterializedAttachment],
) -> Result<String, AttachmentMaterializationError> {
    if files.is_empty() {
        return Ok(text);
    }
    let mut section = String::from("\n<attached_files>\n");
    for file in files {
        let path = file.path.to_str().ok_or_else(|| {
            AttachmentMaterializationError::InvalidMetadata(
                "attachment path is not Unicode".to_owned(),
            )
        })?;
        if path.chars().any(char::is_control) {
            return Err(AttachmentMaterializationError::InvalidMetadata(
                "attachment path contains control characters".to_owned(),
            ));
        }
        section.push_str("- ");
        section.push_str(&escape_xml(&file.name));
        section.push_str(": ");
        section.push_str(&escape_xml(path));
        section.push('\n');
        if section.len() > MAX_ATTACHED_FILES_TEXT_BYTES {
            return Err(AttachmentMaterializationError::InvalidMetadata(
                "attached file references exceed 16 KiB".to_owned(),
            ));
        }
    }
    section.push_str("</attached_files>");
    if section.len() > MAX_ATTACHED_FILES_TEXT_BYTES {
        return Err(AttachmentMaterializationError::InvalidMetadata(
            "attached file references exceed 16 KiB".to_owned(),
        ));
    }
    Ok(text + &section)
}

fn is_image_mime(mime: &str) -> bool {
    mime.get(..6)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("image/"))
}

fn create_stage_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x0000_0001 | 0x0000_0002 | 0x0000_0004);
    }
    options.open(path)
}

fn is_windows_reserved_name(id: &str) -> bool {
    matches!(
        id.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse_point(_: &std::fs::Metadata) -> bool {
    false
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use serde_json::json;
    use std::{collections::HashSet, path::PathBuf, process::Command, sync::Arc};
    use tempfile::TempDir;

    use super::{AttachmentMaterializer, STANDARD};

    const ATTACHMENT_ABORT_CHILD_DIR: &str = "BIBCODE_ATTACHMENT_ABORT_CHILD_DIR";
    const ATTACHMENT_ABORT_CHILD_READY: &str = "BIBCODE_ATTACHMENT_ABORT_CHILD_READY";

    #[test]
    fn attachment_final_publication_abort_child() {
        let Some(attachments_dir) = std::env::var_os(ATTACHMENT_ABORT_CHILD_DIR) else {
            return;
        };
        let ready = PathBuf::from(
            std::env::var_os(ATTACHMENT_ABORT_CHILD_READY).expect("child ready path"),
        );
        let attachments_dir = PathBuf::from(attachments_dir);
        let pause = Arc::new(super::AttachmentPrepareTestPause::default());
        let materializer = AttachmentMaterializer::new(attachments_dir.clone())
            .with_pause_after_final_publication(pause.clone());
        let reached = pause.reached.notified();
        tokio::runtime::Runtime::new()
            .expect("child runtime")
            .block_on(async move {
                let _prepare = tokio::spawn(async move {
                    materializer
                        .prepare(vec![json!({
                            "type":"file", "id":"aborted-final", "name":"notes.txt",
                            "mimeType":"text/plain", "sizeBytes":5,
                            "dataUrl":"data:text/plain;base64,bm90ZXM="
                        })])
                        .await
                });
                tokio::time::timeout(std::time::Duration::from_secs(5), reached)
                    .await
                    .expect("hard-link publication reaches the abort barrier");
                assert!(attachments_dir.join("aborted-final").exists());
                std::fs::write(ready, "published").expect("child ready marker");
                std::process::abort();
            });
    }

    #[tokio::test]
    async fn materializes_an_image_attachment_from_the_state_directory() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments dir");
        tokio::fs::write(attachments_dir.join("image-1"), b"image bytes")
            .await
            .expect("attachment file");

        let attachments = AttachmentMaterializer::new(attachments_dir)
            .materialize(vec![json!({
                "type": "image",
                "id": "image-1",
                "name": "screen.png",
                "mimeType": "image/png",
                "sizeBytes": 11
            })])
            .await
            .expect("materialized image");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].attachment_type, "image");
        assert_eq!(attachments[0].name, "screen.png");
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(attachments[0].base64_data, "aW1hZ2UgYnl0ZXM=");
        assert!(attachments[0].file_url.starts_with("file://"));
    }

    #[tokio::test]
    async fn startup_reconciliation_preserves_referenced_finals_and_removes_orphans_and_stages() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments dir");
        tokio::fs::write(attachments_dir.join("keep-1"), b"keep")
            .await
            .expect("referenced final");
        tokio::fs::write(attachments_dir.join("orphan-1"), b"orphan")
            .await
            .expect("orphan final");
        tokio::fs::write(attachments_dir.join(".stale.upload"), b"partial")
            .await
            .expect("stale stage");

        let materializer = AttachmentMaterializer::new(attachments_dir.clone());
        let referenced = HashSet::from(["keep-1".to_owned()]);
        materializer.reconcile_startup(&referenced).await.unwrap();

        assert!(attachments_dir.join("keep-1").exists());
        assert!(!attachments_dir.join("orphan-1").exists());
        assert!(!attachments_dir.join(".stale.upload").exists());
    }

    #[tokio::test]
    async fn cancelling_after_stage_write_before_flush_removes_the_pending_stage_and_final() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        let pause = Arc::new(super::AttachmentPrepareTestPause::default());
        let materializer = AttachmentMaterializer::new(attachments_dir.clone())
            .with_pause_after_stage_write(pause.clone());
        let reached = pause.reached.notified();
        let task = tokio::spawn(async move {
            materializer
                .prepare(vec![json!({
                    "type":"file", "id":"cancelled", "name":"notes.txt",
                    "mimeType":"text/plain", "sizeBytes":5,
                    "dataUrl":"data:text/plain;base64,bm90ZXM="
                })])
                .await
        });

        tokio::time::timeout(std::time::Duration::from_secs(5), reached)
            .await
            .expect("write_all reaches the flush barrier");
        assert!(
            !task.is_finished(),
            "the preparation future remains pending before flush"
        );
        task.abort();
        pause.resume.notify_one();
        let _ = task.await;

        assert!(!attachments_dir.join("cancelled").exists());
        assert!(
            std::fs::read_dir(&attachments_dir)
                .expect("attachment entries")
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".upload")),
            "cancellation removes every owned stage"
        );
    }

    #[tokio::test]
    async fn startup_removes_a_final_left_by_a_process_aborted_after_publication() {
        let state = TempDir::new().expect("state dir");
        let config = crate::ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        let attachments_dir = config.state_dir().join("attachments");
        let ready = state.path().join("published");
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "provider::attachments::tests::attachment_final_publication_abort_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ATTACHMENT_ABORT_CHILD_DIR, &attachments_dir)
            .env(ATTACHMENT_ABORT_CHILD_READY, &ready)
            .output()
            .expect("run crash child");
        assert!(ready.exists(), "the child reached final publication");
        assert!(!output.status.success(), "the child must abort");
        assert!(attachments_dir.join("aborted-final").exists());

        let database = crate::persistence::Database::open_in_memory()
            .await
            .expect("database");
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let runtime = crate::production::runtime::ProductionRuntime::start(
            &config,
            database,
            crate::auth::AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("restarted runtime");

        assert!(
            !attachments_dir.join("aborted-final").exists(),
            "startup reconciliation removes the unreferenced final"
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn prepares_and_materializes_a_file_upload() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        let materializer = AttachmentMaterializer::new(attachments_dir.clone());

        let prepared_batch = materializer
            .prepare(vec![json!({
                "type": "file",
                "id": "notes-1",
                "name": "notes.txt",
                "mimeType": "text/plain",
                "sizeBytes": 5,
                "dataUrl": "data:text/plain;base64,bm90ZXM="
            })])
            .await
            .expect("file upload prepares");
        let prepared = prepared_batch.attachments().to_vec();
        assert_eq!(
            prepared,
            vec![json!({
                "type": "file",
                "id": "notes-1",
                "name": "notes.txt",
                "mimeType": "text/plain",
                "sizeBytes": 5
            })]
        );
        prepared_batch.commit();

        let attachments = materializer
            .materialize(prepared)
            .await
            .expect("file materializes");
        assert_eq!(attachments[0].attachment_type, "file");
        assert_eq!(attachments[0].base64_data, "bm90ZXM=");
        assert!(attachments_dir.join("notes-1").is_file());
    }

    #[tokio::test]
    async fn prepared_batch_exposes_sha256_references_for_every_attachment() {
        let state = TempDir::new().expect("state dir");
        let prepared = AttachmentMaterializer::new(state.path().join("attachments"))
            .prepare(vec![
                json!({
                    "type":"file", "id":"a", "name":"a.txt", "mimeType":"text/plain",
                    "sizeBytes":1, "dataUrl":"data:text/plain;base64,YQ=="
                }),
                json!({
                    "type":"file", "id":"b", "name":"b.txt", "mimeType":"text/plain",
                    "sizeBytes":1, "dataUrl":"data:text/plain;base64,Yg=="
                }),
            ])
            .await
            .expect("attachments prepare");

        assert_eq!(
            prepared
                .references()
                .iter()
                .map(|reference| (
                    reference.attachment_id.as_str(),
                    reference.content_digest.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "a",
                    Some("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb")
                ),
                (
                    "b",
                    Some("3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d")
                ),
            ]
        );
    }

    #[tokio::test]
    async fn dropping_a_prepared_batch_rolls_back_its_files() {
        let state = TempDir::new().expect("state dir");
        let attachment = state.path().join("attachments/drop-1");
        let prepared = AttachmentMaterializer::new(state.path().join("attachments"))
            .prepare(vec![json!({
                "type":"file", "id":"drop-1", "name":"notes.txt", "mimeType":"text/plain",
                "sizeBytes":5, "dataUrl":"data:text/plain;base64,bm90ZXM="
            })])
            .await
            .expect("upload prepares");
        assert!(attachment.is_file());

        drop(prepared);

        assert!(
            !attachment.exists(),
            "dropping ownership must roll back the final file"
        );
    }

    #[tokio::test]
    async fn rejects_attachment_ids_that_escape_the_state_directory() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments dir");
        tokio::fs::write(state.path().join("outside"), b"secret")
            .await
            .expect("outside file");

        let error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "image",
                "id": "../outside",
                "name": "outside.png",
                "mimeType": "image/png",
                "sizeBytes": 6
            })])
            .await
            .expect_err("traversal must fail");

        assert!(error.to_string().contains("invalid attachment id"));

        let missing_root_error = AttachmentMaterializer::new(state.path().join("missing"))
            .materialize(vec![json!({
                "type": "image",
                "id": "image-1",
                "name": "missing.png",
                "mimeType": "image/png",
                "sizeBytes": 11
            })])
            .await
            .expect_err("a missing attachment directory must fail");
        assert!(
            missing_root_error
                .to_string()
                .contains("failed to access attachment directory")
        );

        let invalid_metadata_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({ "type": "image" })])
            .await
            .expect_err("incomplete metadata must fail");
        assert!(
            invalid_metadata_error
                .to_string()
                .contains("invalid attachment metadata")
        );

        let mismatched_attachment_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "file",
                "id": "image-1",
                "name": "notes.txt",
                "mimeType": "image/png",
                "sizeBytes": 11
            })])
            .await
            .expect_err("mismatched type must fail");
        assert!(
            mismatched_attachment_error
                .to_string()
                .contains("type and MIME type do not match")
        );

        let missing_attachment_error = AttachmentMaterializer::new(attachments_dir.clone())
            .materialize(vec![json!({
                "type": "image",
                "id": "missing",
                "name": "missing.png",
                "mimeType": "image/png",
                "sizeBytes": 0
            })])
            .await
            .expect_err("a missing attachment must fail");
        assert!(
            missing_attachment_error
                .to_string()
                .contains("failed to read attachment")
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                state.path().join("outside"),
                attachments_dir.join("linked-image"),
            )
            .expect("attachment symlink");
            let symlink_error = AttachmentMaterializer::new(attachments_dir.clone())
                .materialize(vec![json!({
                        "type": "image",
                        "id": "linked-image",
                        "name": "outside.png",
                        "mimeType": "image/png",
                        "sizeBytes": 6
                })])
                .await
                .expect_err("a symlink outside the attachment directory must fail");
            assert!(symlink_error.to_string().contains("resolves outside"));

            let materializer = AttachmentMaterializer::new(attachments_dir.clone());
            materializer
                .prepare(vec![json!({
                    "type": "image",
                    "id": "linked-image",
                    "name": "outside.png",
                    "mimeType": "image/png",
                    "sizeBytes": 6,
                    "dataUrl": "data:image/png;base64,c2VjcmV0"
                })])
                .await
                .expect_err("publishing over a symlink must fail");
            let mut entries = tokio::fs::read_dir(&attachments_dir)
                .await
                .expect("attachments directory");
            while let Some(entry) = entries.next_entry().await.expect("attachment entry") {
                assert!(
                    !entry.file_name().to_string_lossy().ends_with(".upload"),
                    "failed publication must remove its staged file"
                );
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_a_junction_used_as_the_attachment_root() {
        let state = TempDir::new().expect("state dir");
        let junction_target = state.path().join("junction-target");
        let attachments_dir = state.path().join("attachments");
        std::fs::create_dir(&junction_target).expect("junction target");
        if let Err(error) = junction::create(&junction_target, &attachments_dir) {
            let access_denied = matches!(error.raw_os_error(), Some(5 | 1314));
            assert!(
                access_denied,
                "junction creation failed for an unexpected reason: {error}"
            );
            eprintln!("skipping junction assertion: Windows denied junction creation: {error}");
            return;
        }

        let error = AttachmentMaterializer::new(attachments_dir)
            .prepare(vec![json!({
                "type": "file",
                "id": "notes-1",
                "name": "notes.txt",
                "mimeType": "text/plain",
                "sizeBytes": 5,
                "dataUrl": "data:text/plain;base64,bm90ZXM="
            })])
            .await
            .expect_err("a junction root must fail before publication");
        assert!(error.to_string().contains("resolves outside"));
        assert!(!junction_target.join("notes-1").exists());
    }

    #[tokio::test]
    async fn rejects_untrusted_upload_bodies_before_writing() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        let materializer = AttachmentMaterializer::new(attachments_dir.clone());
        let invalid = [
            json!({"type":"file","id":"notes-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":4,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
            json!({"type":"file","id":"notes-2","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain,notes"}),
            json!({"type":"image","id":"notes-3","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
            json!({"type":"file","id":"../notes","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
            json!({"type":"file","id":"notes-4","name":"../notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
        ];
        for upload in invalid {
            materializer
                .prepare(vec![upload])
                .await
                .expect_err("invalid upload must fail");
        }
        assert!(!attachments_dir.join("notes-1").exists());
    }

    #[tokio::test]
    async fn attachment_metadata_matches_wire_name_and_mime_boundaries() {
        let state = TempDir::new().expect("state dir");
        let materializer = AttachmentMaterializer::new(state.path().join("attachments"));
        let max_name = "é".repeat(super::MAX_ATTACHMENT_NAME_LENGTH);
        let max_mime = format!("a/{}", "b".repeat(98));

        materializer
            .prepare(vec![json!({
                "type":"file", "id":"valid-boundary", "name":max_name,
                "mimeType":max_mime, "sizeBytes":0,
                "dataUrl":format!("data:{max_mime};base64,")
            })])
            .await
            .expect("contract maxima prepare")
            .commit();

        for (index, (name, mime_type)) in [
            (" ".to_owned(), "text/plain".to_owned()),
            (" notes.txt".to_owned(), "text/plain".to_owned()),
            ("notes.txt ".to_owned(), "text/plain".to_owned()),
            (
                "x".repeat(super::MAX_ATTACHMENT_NAME_LENGTH + 1),
                "text/plain".to_owned(),
            ),
            ("😀".repeat(128), "text/plain".to_owned()),
            ("notes.txt".to_owned(), " ".to_owned()),
            ("notes.txt".to_owned(), " text/plain".to_owned()),
            ("notes.txt".to_owned(), format!("a/{}", "b".repeat(99))),
        ]
        .into_iter()
        .enumerate()
        {
            materializer
                .prepare(vec![json!({
                    "type":"file", "id":format!("invalid-boundary-{index}"), "name":name,
                    "mimeType":mime_type, "sizeBytes":0,
                    "dataUrl":format!("data:{mime_type};base64,")
                })])
                .await
                .expect_err("metadata outside the wire contract rejects");
        }
    }

    #[tokio::test]
    async fn rejects_predecode_limits_reserved_ids_and_residual_null_data_urls() {
        let state = TempDir::new().expect("state dir");
        let materializer = AttachmentMaterializer::new(state.path().join("attachments"));
        let body = "A".repeat(super::MAX_ENCODED_ATTACHMENT_BYTES + 4);
        let error = materializer
            .prepare(vec![json!({"type":"file","id":"notes-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":1,"dataUrl":format!("data:text/plain;base64,{body}")})])
            .await
            .expect_err("encoded body rejects before decode");
        assert_eq!(
            error.to_string(),
            "invalid attachment metadata: attachment dataUrl exceeds the base64 size limit"
        );
        for id in ["CON", "nul", &"a".repeat(129)] {
            materializer
                .prepare(vec![json!({"type":"file","id":id,"name":"notes.txt","mimeType":"text/plain","sizeBytes":0,"dataUrl":"data:text/plain;base64,"})])
                .await
                .expect_err("invalid Windows-safe id rejects");
        }
        materializer
            .prepare(vec![json!({"type":"image","id":"image-1","name":"screen.png","mimeType":"IMAGE/PNG","sizeBytes":0,"dataUrl":"data:IMAGE/PNG;base64,"})])
            .await
            .expect("image MIME matching is ASCII-case-insensitive")
            .commit();
        let reconnect = materializer
            .prepare(vec![json!({"type":"image","id":"image-1","name":"screen.png","mimeType":"image/png","sizeBytes":0})])
            .await
            .expect("a missing dataUrl reconnects to the prepared file");
        assert_eq!(reconnect.attachments()[0]["id"], "image-1");
        reconnect.commit();
        let null_error = materializer
            .prepare(vec![json!({"type":"image","id":"image-1","name":"screen.png","mimeType":"image/png","sizeBytes":0,"dataUrl":null})])
            .await
            .expect_err("an explicit null dataUrl is not a reconnect");
        assert!(
            null_error
                .to_string()
                .contains("base64 string when present")
        );
        materializer
            .materialize(vec![json!({"type":"image","id":"image-1","name":"screen.png","mimeType":"image/png","sizeBytes":0,"dataUrl":null})])
            .await
            .expect_err("residual null dataUrl rejects");
        let attachments = (0..9).map(|index| json!({"type":"file","id":format!("notes-{index}"),"name":"notes.txt","mimeType":"text/plain","sizeBytes":0,"dataUrl":"data:text/plain;base64,"})).collect();
        materializer
            .prepare(attachments)
            .await
            .expect_err("more than eight attachments rejects");
    }

    #[test]
    fn attached_file_section_does_not_cap_the_prompt_or_accept_control_paths() {
        let file = super::MaterializedAttachment {
            attachment_type: "file".to_owned(),
            name: "notes.txt".to_owned(),
            mime_type: "text/plain".to_owned(),
            base64_data: String::new(),
            file_url: "file:///notes".to_owned(),
            path: PathBuf::from("/safe/notes"),
        };
        let prompt = "x".repeat(32 * 1024);
        let appended = super::append_file_references(prompt.clone(), &[file.clone()])
            .expect("generated references do not cap the prompt");
        assert!(appended.starts_with(&prompt));
        assert!(appended.contains("<attached_files>"));
        assert!(appended.contains("notes.txt: "));
        let oversized_section = super::MaterializedAttachment {
            path: PathBuf::from("x".repeat(super::MAX_ATTACHED_FILES_TEXT_BYTES)),
            ..file.clone()
        };
        assert_eq!(
            super::append_file_references(String::new(), &[oversized_section])
                .expect_err("the generated section itself remains bounded")
                .to_string(),
            "invalid attachment metadata: attached file references exceed 16 KiB"
        );
        let control = super::MaterializedAttachment {
            path: PathBuf::from("/safe/notes\nnext"),
            ..file
        };
        assert!(super::append_file_references(String::new(), &[control]).is_err());
    }

    #[tokio::test]
    async fn rejects_oversized_decoded_upload_and_conflicting_retries() {
        let state = TempDir::new().expect("state dir");
        let materializer = AttachmentMaterializer::new(state.path().join("attachments"));
        let oversized = STANDARD.encode(vec![0; super::MAX_ATTACHMENT_BYTES + 1]);
        materializer
            .prepare(vec![json!({
                "type":"file", "id":"large-1", "name":"large.txt", "mimeType":"text/plain",
                "sizeBytes":1, "dataUrl":format!("data:text/plain;base64,{oversized}")
            })])
            .await
            .expect_err("decoded size is capped independently of the claim");

        let upload = json!({
            "type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain",
            "sizeBytes":5, "dataUrl":"data:text/plain;base64,bm90ZXM="
        });
        materializer
            .prepare(vec![upload.clone()])
            .await
            .expect("initial upload prepares")
            .commit();
        materializer
            .prepare(vec![upload])
            .await
            .expect("identical retry prepares")
            .commit();
        materializer
            .prepare(vec![json!({
                "type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain",
                "sizeBytes":5, "dataUrl":"data:text/plain;base64,b3RoZXI="
            })])
            .await
            .expect_err("different retry cannot overwrite");
        assert_eq!(
            tokio::fs::read(state.path().join("attachments/notes-1"))
                .await
                .expect("prepared file"),
            b"notes"
        );
    }

    #[tokio::test]
    async fn serialized_publication_keeps_equal_adopters_safe_when_the_owner_rolls_back() {
        let state = TempDir::new().expect("state dir");
        let materializer = AttachmentMaterializer::new(state.path().join("attachments"));
        let adopter = materializer.clone();
        let pause = Arc::new(super::AttachmentPrepareTestPause::default());
        let owner = materializer
            .clone()
            .with_pause_after_final_publication(pause.clone());
        let upload = json!({"type":"file","id":"same-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="});
        let owner = tokio::spawn({
            let upload = upload.clone();
            async move {
                owner.prepare(vec![
                    upload.clone(),
                    json!({"type":"file","id":"missing","name":"missing.txt","mimeType":"text/plain","sizeBytes":0}),
                ])
                .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), pause.reached.notified())
            .await
            .expect("the owner publishes its first item");
        let adopted = tokio::spawn(async move { adopter.prepare(vec![upload]).await });
        tokio::task::yield_now().await;
        assert!(
            !adopted.is_finished(),
            "an equal adopter waits while the owner can still roll back"
        );
        pause.resume.notify_one();
        let failed_owner = owner.await.expect("owner task");
        let adopted = adopted.await.expect("adopter task");
        assert!(
            failed_owner.is_err(),
            "the publishing owner must fail its later item"
        );
        let adopted = adopted.expect("the equal adopter republishes after rollback");
        assert_eq!(
            tokio::fs::read(state.path().join("attachments/same-1"))
                .await
                .expect("adopted attachment remains"),
            b"notes"
        );
        adopted.commit();

        let different = json!({"type":"file","id":"different-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,b3RoZXI="});
        let original = json!({"type":"file","id":"different-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="});
        materializer
            .prepare(vec![original])
            .await
            .expect("first body publishes")
            .commit();
        materializer
            .prepare(vec![different])
            .await
            .expect_err("a different body cannot adopt the published id");

        materializer
            .prepare(vec![
                json!({"type":"file","id":"cleanup-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
                json!({"type":"file","id":"cleanup-2","name":"notes.txt","mimeType":"text/plain","sizeBytes":4,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
            ])
            .await
            .expect_err("later batch failure cleans earlier publication");
        assert!(!state.path().join("attachments/cleanup-1").exists());
        let mut entries = tokio::fs::read_dir(state.path().join("attachments"))
            .await
            .expect("attachments");
        while let Some(entry) = entries.next_entry().await.expect("entry") {
            assert!(!entry.file_name().to_string_lossy().contains("cleanup"));
        }

        materializer
            .prepare(vec![
                json!({"type":"file","id":"rollback-1","name":"notes.txt","mimeType":"text/plain","sizeBytes":5,"dataUrl":"data:text/plain;base64,bm90ZXM="}),
                json!({"type":"file","id":"missing","name":"missing.txt","mimeType":"text/plain","sizeBytes":0}),
            ])
            .await
            .expect_err("a later reconnect failure rolls back earlier publication");
        assert!(
            !state.path().join("attachments/rollback-1").exists(),
            "all newly published batch files must roll back"
        );
    }

    #[tokio::test]
    async fn initialization_scavenges_stages_and_cancelled_preparation_rolls_back() {
        let state = TempDir::new().expect("state dir");
        let attachments_dir = state.path().join("attachments");
        tokio::fs::create_dir(&attachments_dir)
            .await
            .expect("attachments");
        let abandoned = attachments_dir.join(".abandoned.upload");
        tokio::fs::write(&abandoned, b"partial")
            .await
            .expect("stale stage");
        let materializer = AttachmentMaterializer::new(attachments_dir.clone());
        materializer
            .prepare(vec![json!({
                "type":"file", "id":"initialized", "name":"notes.txt", "mimeType":"text/plain",
                "sizeBytes":0, "dataUrl":"data:text/plain;base64,"
            })])
            .await
            .expect("initial batch prepares")
            .commit();
        assert!(
            !abandoned.exists(),
            "one-time root initialization scavenges stages"
        );

        let body = STANDARD.encode(vec![0; super::MAX_ATTACHMENT_BYTES]);
        let cancelled_path = attachments_dir.join("cancelled");
        let task_materializer = materializer.clone();
        let task = tokio::spawn(async move {
            task_materializer
                .prepare(vec![json!({
                    "type":"file", "id":"cancelled", "name":"large.bin",
                    "mimeType":"application/octet-stream", "sizeBytes":super::MAX_ATTACHMENT_BYTES,
                    "dataUrl":format!("data:application/octet-stream;base64,{body}")
                })])
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let has_stage_or_final = cancelled_path.exists()
                    || std::fs::read_dir(&attachments_dir)
                        .expect("attachment entries")
                        .flatten()
                        .any(|entry| entry.file_name().to_string_lossy().ends_with(".upload"));
                if has_stage_or_final {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("preparation reaches owned filesystem state");
        task.abort();
        let _ = task.await;
        assert!(!cancelled_path.exists(), "cancelled final is rolled back");
        assert!(
            std::fs::read_dir(&attachments_dir)
                .expect("attachment entries")
                .flatten()
                .all(|entry| !entry.file_name().to_string_lossy().ends_with(".upload")),
            "cancelled stages are removed synchronously"
        );
    }

    #[test]
    fn prompt_parts_preserve_text_and_attachment_only_turns() {
        let image = json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" });

        assert_eq!(
            super::prompt_parts(Some("describe this"), vec![image.clone()]),
            vec![
                json!({ "type": "text", "text": "describe this" }),
                image.clone()
            ]
        );
        assert_eq!(
            super::prompt_parts(Some(""), vec![image.clone()]),
            vec![image]
        );
    }
}
