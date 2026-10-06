//! Authenticated chat upload RPCs share one registry with durable turn admission.
use crate::{
    RpcRegistry,
    transfer::staging::{
        UploadAppendInput, UploadBeginInput, UploadError, UploadErrorReason, UploadOwner,
        UploadRegistry, UploadTarget,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdInput {
    upload_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalImagePasteInput {
    upload_id: String,
    name: String,
    mime_type: String,
    size_bytes: u64,
}
/// Pasted images older than this are removed when the next image is pasted.
const TERMINAL_PASTE_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
fn error_value(error: UploadError) -> Value {
    serde_json::to_value(error).expect("upload error serializes")
}
fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(
        |error| json!({"_tag":"UploadError", "reason":"invalid", "message":error.to_string()}),
    )
}
fn image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}
/// ponytail: expiry runs only when an image is pasted; a startup sweep can join if the folder
/// ever needs cleaning on servers that stop receiving pastes.
/// Only files this module named (`<uuid>.<image extension>`) are ever removed, so a misplaced
/// file or alias in the directory cannot widen the sweep.
fn is_terminal_paste_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.split_once('.'))
        .is_some_and(|(stem, extension)| {
            Uuid::parse_str(stem).is_ok() && ["png", "jpg", "gif", "webp"].contains(&extension)
        })
}
async fn remove_expired_pastes(directory: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if !is_terminal_paste_name(&entry.file_name()) {
            continue;
        }
        let expired = entry
            .metadata()
            .await
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > TERMINAL_PASTE_RETENTION);
        if expired {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}
/// Copies a completed image upload to a new server-named file, so a terminal program on this host
/// can read it, and returns the file's absolute path.
async fn stage_terminal_image_paste(
    uploads: &UploadRegistry,
    owner: &UploadOwner,
    directory: &Path,
    input: TerminalImagePasteInput,
) -> Result<PathBuf, UploadError> {
    let extension = image_extension(&input.mime_type).ok_or_else(|| {
        UploadError::new(
            UploadErrorReason::Invalid,
            "Only PNG, JPEG, GIF and WebP images can be pasted",
        )
    })?;
    let target = UploadTarget::ChatAttachment {
        attachment_type: "image".into(),
        name: input.name,
        mime_type: input.mime_type,
    };
    let binding = uploads
        .bind(owner, &input.upload_id, &target, input.size_bytes)
        .await?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(UploadError::io)?;
    // A symlinked or junctioned directory would point the sweep and the copy somewhere else.
    let metadata = tokio::fs::symlink_metadata(directory)
        .await
        .map_err(UploadError::io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(UploadError::new(
            UploadErrorReason::Invalid,
            "The terminal paste folder is not a plain directory",
        ));
    }
    remove_expired_pastes(directory).await;
    let path = std::path::absolute(directory.join(format!("{}.{extension}", Uuid::new_v4())))
        .map_err(UploadError::io)?;
    if let Err(error) = tokio::fs::copy(binding.path(), &path).await {
        // A partial copy is outside the upload accounting; do not leave it behind.
        let _ = tokio::fs::remove_file(&path).await;
        return Err(UploadError::io(error));
    }
    binding.commit();
    Ok(path)
}
pub fn register_uploads_rpc(
    registry: &mut RpcRegistry,
    uploads: UploadRegistry,
    terminal_pastes_dir: PathBuf,
) {
    let begin = uploads.clone();
    registry.register_unary_with_context("uploads.begin", move |request, context, _| {
        let uploads = begin.clone();
        async move {
            let input = decode::<UploadBeginInput>(request.payload)?;
            let result = uploads
                .begin(&UploadOwner::from_context(&context), input)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    let append = uploads.clone();
    registry.register_unary_with_context("uploads.append", move |request, context, _| {
        let uploads = append.clone();
        async move {
            let input = decode::<UploadAppendInput>(request.payload)?;
            let result = uploads
                .append(&UploadOwner::from_context(&context), input)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    let get = uploads.clone();
    registry.register_unary_with_context("uploads.get", move |request, context, _| {
        let uploads = get.clone();
        async move {
            let input = decode::<IdInput>(request.payload)?;
            let result = uploads
                .get(&UploadOwner::from_context(&context), &input.upload_id)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    let paste = uploads.clone();
    registry.register_unary_with_context("terminal.stageImagePaste", move |request, context, _| {
        let uploads = paste.clone();
        let directory = terminal_pastes_dir.clone();
        async move {
            let input = decode::<TerminalImagePasteInput>(request.payload)?;
            let owner = UploadOwner::from_context(&context);
            // Owned work: a cancelled call still finishes the copy, its cleanup and the
            // stage's retirement instead of stranding a file mid-copy.
            let path = tokio::spawn(async move {
                stage_terminal_image_paste(&uploads, &owner, &directory, input).await
            })
            .await
            .map_err(|error| {
                error_value(UploadError::new(
                    UploadErrorReason::Invalid,
                    error.to_string(),
                ))
            })?
            .map_err(error_value)?;
            Ok(json!({ "path": path }))
        }
    });
    registry.register_unary_with_context("uploads.cancel", move |request, context, _| {
        let uploads = uploads.clone();
        async move {
            let input = decode::<IdInput>(request.payload)?;
            uploads
                .cancel(&UploadOwner::from_context(&context), &input.upload_id)
                .await
                .map_err(error_value)?;
            Ok(json!({}))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::staging::UploadLimits;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::sync::Arc;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    fn owner() -> UploadOwner {
        UploadOwner::Session("owner-a".into())
    }

    fn input(upload_id: &str, mime_type: &str) -> TerminalImagePasteInput {
        TerminalImagePasteInput {
            upload_id: upload_id.into(),
            name: "screenshot.png".into(),
            mime_type: mime_type.into(),
            size_bytes: PNG.len() as u64,
        }
    }

    async fn completed_upload(registry: &UploadRegistry) -> String {
        let id = registry
            .begin(
                &owner(),
                UploadBeginInput {
                    target: UploadTarget::ChatAttachment {
                        attachment_type: "image".into(),
                        name: "screenshot.png".into(),
                        mime_type: "image/png".into(),
                    },
                    size_bytes: PNG.len() as u64,
                    sha256: None,
                },
            )
            .await
            .unwrap()
            .upload_id;
        registry
            .append(
                &owner(),
                UploadAppendInput {
                    upload_id: id.clone(),
                    offset: 0,
                    data: STANDARD.encode(PNG),
                    sha256: Some(crate::crypto::sha256_hex(PNG)),
                },
            )
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn pasted_image_lands_in_a_fresh_absolute_file_and_retires_the_upload() {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new(
            temp.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let pastes = temp.path().join("terminal-pastes");
        let id = completed_upload(&registry).await;

        let path =
            stage_terminal_image_paste(&registry, &owner(), &pastes, input(&id, "image/png"))
                .await
                .unwrap();

        assert!(path.is_absolute());
        assert_eq!(path.parent(), Some(pastes.as_path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), PNG);
        let again =
            stage_terminal_image_paste(&registry, &owner(), &pastes, input(&id, "image/png"))
                .await
                .unwrap_err();
        assert_eq!(again.reason, UploadErrorReason::NotFound);
    }

    #[tokio::test]
    async fn refuses_non_image_types_and_other_owners_uploads() {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new(
            temp.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let pastes = temp.path().join("terminal-pastes");
        let id = completed_upload(&registry).await;

        let svg =
            stage_terminal_image_paste(&registry, &owner(), &pastes, input(&id, "image/svg+xml"))
                .await
                .unwrap_err();
        assert_eq!(svg.reason, UploadErrorReason::Invalid);
        let stranger = UploadOwner::Session("owner-b".into());
        assert!(
            stage_terminal_image_paste(&registry, &stranger, &pastes, input(&id, "image/png"))
                .await
                .is_err()
        );
        assert!(!pastes.exists());
    }

    fn age(path: &Path) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - TERMINAL_PASTE_RETENTION - Duration::from_secs(60))
            .unwrap();
    }

    #[tokio::test]
    async fn pasting_removes_images_past_retention_and_keeps_recent_ones() {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new(
            temp.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let pastes = temp.path().join("terminal-pastes");
        std::fs::create_dir_all(&pastes).unwrap();
        let stale = pastes.join(format!("{}.png", Uuid::new_v4()));
        let recent = pastes.join(format!("{}.png", Uuid::new_v4()));
        std::fs::write(&stale, PNG).unwrap();
        std::fs::write(&recent, PNG).unwrap();
        age(&stale);
        let id = completed_upload(&registry).await;

        stage_terminal_image_paste(&registry, &owner(), &pastes, input(&id, "image/png"))
            .await
            .unwrap();

        assert!(!stale.exists());
        assert!(recent.exists());
    }

    #[tokio::test]
    async fn sweep_removes_only_its_own_files_and_refuses_an_aliased_folder() {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new(
            temp.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let pastes = temp.path().join("terminal-pastes");
        std::fs::create_dir_all(&pastes).unwrap();
        let foreign = pastes.join("notes.png");
        std::fs::write(&foreign, PNG).unwrap();
        age(&foreign);
        let id = completed_upload(&registry).await;
        stage_terminal_image_paste(&registry, &owner(), &pastes, input(&id, "image/png"))
            .await
            .unwrap();
        assert!(foreign.exists());

        #[cfg(unix)]
        {
            let workspace = temp.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();
            let source = workspace.join(format!("{}.png", Uuid::new_v4()));
            std::fs::write(&source, PNG).unwrap();
            age(&source);
            let alias = temp.path().join("aliased-pastes");
            std::os::unix::fs::symlink(&workspace, &alias).unwrap();
            let id = completed_upload(&registry).await;
            let error =
                stage_terminal_image_paste(&registry, &owner(), &alias, input(&id, "image/png"))
                    .await
                    .unwrap_err();
            assert_eq!(error.reason, UploadErrorReason::Invalid);
            assert!(source.exists());
        }
    }
}
