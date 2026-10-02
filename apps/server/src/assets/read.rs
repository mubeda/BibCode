//! Exact asset byte streams. This path never signs or redeems HTTP capabilities.
use super::{AssetError, AssetResource, FALLBACK_FAVICON, ResolvedAsset};
use crate::{
    RpcRequest, RpcStreamChunk,
    transfer::download::{ChunkPacer, OwnedReadSource, send_chunk},
    workspace::{WorkspaceError, WorkspaceRpc},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use tokio::{io::AsyncReadExt, sync::mpsc};
use tokio_util::sync::CancellationToken;

const MAX_ASSET_BYTES: u64 = 10 * 1024 * 1024;
#[derive(Deserialize)]
pub struct AssetReadInput {
    pub resource: AssetResource,
}
pub(crate) struct AssetReader {
    reader: OwnedReadSource,
    resource: AssetResource,
    size: u64,
    mime: String,
}
impl AssetReader {
    pub(crate) async fn open(
        resolved: ResolvedAsset,
        resource: AssetResource,
    ) -> Result<Self, Value> {
        match resolved {
            ResolvedAsset::ProjectFaviconFallback => Ok(Self {
                reader: OwnedReadSource::Static(std::io::Cursor::new(FALLBACK_FAVICON.as_bytes())),
                resource,
                size: u64::try_from(FALLBACK_FAVICON.len()).expect("small fallback"),
                mime: "image/svg+xml".into(),
            }),
            ResolvedAsset::File(path) => {
                let file = crate::transfer::download::open_regular_read_file(&path)
                    .await
                    .map_err(|error| asset_io_error(&resource, &path, error))?;
                let metadata = file
                    .metadata()
                    .await
                    .map_err(|error| asset_io_error(&resource, &path, error))?;
                if !metadata.is_file() {
                    return Err(WorkspaceRpc::asset_failure(
                        &resource,
                        &AssetError::NotFound(path.to_string_lossy().into_owned()),
                    ));
                }
                if metadata.len() > MAX_ASSET_BYTES {
                    return Err(too_large(&resource));
                }
                let mime = mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_owned();
                Ok(Self {
                    reader: OwnedReadSource::File(file),
                    resource,
                    size: metadata.len(),
                    mime,
                })
            }
        }
    }
    fn changed_error(&self) -> Value {
        WorkspaceRpc::asset_failure(
            &self.resource,
            &AssetError::Workspace(WorkspaceError::operation(
                "read-asset",
                Path::new("asset"),
                std::io::Error::other("Asset changed while it was read. Try again."),
            )),
        )
    }
}
fn asset_io_error(resource: &AssetResource, path: &Path, error: std::io::Error) -> Value {
    WorkspaceRpc::asset_failure(
        resource,
        &AssetError::Workspace(WorkspaceError::operation("read-asset", path, error)),
    )
}
fn too_large(resource: &AssetResource) -> Value {
    json!({"_tag":"AssetTooLargeError","resource":resource,"limitBytes":MAX_ASSET_BYTES,"message":"Asset exceeds the 10 MiB response limit."})
}

pub(crate) fn asset_read_stream(
    workspace: WorkspaceRpc,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(1);
    let owner_workspace = workspace.clone();
    let rejected = sender.clone();
    let rejected_resource = request.payload.get("resource").cloned();
    if !owner_workspace.spawn_read_work(cancellation.clone(),async move {
        let input: AssetReadInput = match serde_json::from_value(request.payload) {
            Ok(input) => input,
            Err(error) => {
                send_chunk(&sender,&cancellation,Err(json!({"_tag":"InvalidRequest","method":request.tag,"message":error.to_string()}))).await;
                return;
            }
        };
        if cancellation.is_cancelled() || sender.is_closed() {return;}
        let preparing=workspace.prepare_exact_asset(input.resource,&cancellation);
        tokio::pin!(preparing);
        let prepared=tokio::select! {
            biased;
            ()=cancellation.cancelled()=>{let _=preparing.await;return;},
            ()=sender.closed()=>{cancellation.cancel();let _=preparing.await;return;},
            result=&mut preparing=>result,
        };
        let mut source = match prepared {
            Ok(source) => source,
            Err(error) => {
                send_chunk(&sender, &cancellation, Err(error)).await;
                return;
            }
        };
        pump_asset(&mut source,&sender,&cancellation).await;
        source.reader.close().await;
    }) && let Some(resource)=rejected_resource.and_then(|value|serde_json::from_value(value).ok()) {
        let _=rejected.try_send(Err(WorkspaceRpc::asset_failure(&resource,&AssetError::Workspace(WorkspaceError::Cancelled))));
    }
    receiver
}

async fn pump_asset(
    source: &mut AssetReader,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) {
    let start = json!({"_tag":"start","mimeType":source.mime,"sizeBytes":source.size});
    if source.size <= 64 * 1024 {
        let mut bytes = Vec::with_capacity(usize::try_from(source.size).expect("small asset"));
        let mut limited = (&mut source.reader).take(source.size + 1);
        let read = tokio::select! {biased; ()=cancellation.cancelled()=>return,()=sender.closed()=>return,result=limited.read_to_end(&mut bytes)=>result};
        match read {
            Ok(_) => {
                if u64::try_from(bytes.len()).expect("bounded asset") != source.size {
                    send_chunk(sender, cancellation, Err(source.changed_error())).await;
                    return;
                }
                let mut events = vec![start];
                if !bytes.is_empty() {
                    events.push(json!({"_tag":"bytes","offset":0,"data":STANDARD.encode(&bytes)}));
                }
                events.push(json!({"_tag":"end"}));
                send_chunk(sender, cancellation, Ok(events)).await;
            }
            Err(error) => {
                send_chunk(
                    sender,
                    cancellation,
                    Err(asset_io_error(&source.resource, Path::new("asset"), error)),
                )
                .await;
            }
        }
        return;
    }
    if !send_chunk(sender, cancellation, Ok(vec![start])).await {
        return;
    }
    let mut total = 0_u64;
    let mut pacer = ChunkPacer::default();
    loop {
        let mut bytes = vec![0; pacer.size()];
        let read = tokio::select! {biased; ()=cancellation.cancelled()=>return,()=sender.closed()=>return,result=source.reader.read(&mut bytes)=>result};
        match read {
            Ok(0) => {
                if total != source.size {
                    send_chunk(sender, cancellation, Err(source.changed_error())).await;
                } else {
                    send_chunk(sender, cancellation, Ok(vec![json!({"_tag":"end"})])).await;
                }
                return;
            }
            Ok(size) => {
                let next = total + u64::try_from(size).expect("bounded chunk");
                if next > MAX_ASSET_BYTES {
                    send_chunk(sender, cancellation, Err(too_large(&source.resource))).await;
                    return;
                }
                bytes.truncate(size);
                if !send_chunk(
                    sender,
                    cancellation,
                    Ok(vec![
                        json!({"_tag":"bytes","offset":total,"data":STANDARD.encode(&bytes)}),
                    ]),
                )
                .await
                {
                    return;
                }
                total = next;
                pacer.handed_off();
            }
            Err(error) => {
                send_chunk(
                    sender,
                    cancellation,
                    Err(asset_io_error(&source.resource, Path::new("asset"), error)),
                )
                .await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RequestId,
        assets::AssetAccess,
        workspace::{WorkspaceRpcDependencies, WorkspaceService},
    };
    use std::pin::Pin;
    struct Resolver(Option<std::path::PathBuf>);
    #[cfg(unix)]
    #[tokio::test]
    async fn asset_read_refuses_a_leaf_replaced_by_a_symlink_after_resolution() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("image.svg"), b"image").unwrap();
        std::fs::write(outside.path().join("secret"), b"private").unwrap();
        let resource = AssetResource::WorkspaceFile {
            thread_id: "thread".into(),
            path: "image.svg".into(),
        };
        let access = AssetAccess::new(vec![7; 32], root.path().join("attachments"));
        let resolved = access
            .read_exact(super::super::AssetIssueRequest {
                resource: resource.clone(),
                workspace_root: Some(root.path().into()),
            })
            .await
            .unwrap();
        let ResolvedAsset::File(path) = &resolved else {
            panic!("expected file");
        };
        std::fs::remove_file(path).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), path).unwrap();
        assert!(
            AssetReader::open(resolved, resource).await.is_err(),
            "a resolved exact asset must not follow a substituted leaf link"
        );
    }
    impl crate::workspace::AssetContextResolver for Resolver {
        fn resolve_workspace_root<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<Option<std::path::PathBuf>, String>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Ok(self.0.clone()) })
        }
    }
    #[tokio::test]
    async fn asset_read_workspace_image_uses_thread_context_and_short_admission() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("image.svg"), vec![b'x'; 1024 * 1024]).unwrap();
        std::fs::write(root.path().join("report.html"), b"private").unwrap();
        std::fs::write(root.path().join("report.pdf"), b"private").unwrap();
        let registry = crate::worktree_catalog::WorkspaceAvailabilityRegistry::new();
        let rpc = WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                asset_access: Some(AssetAccess::new(
                    vec![7; 32],
                    root.path().join("attachments"),
                )),
                asset_context_resolver: Some(std::sync::Arc::new(Resolver(Some(
                    root.path().into(),
                )))),
                ..WorkspaceRpcDependencies::default()
            },
        )
        .with_availability_registry(registry.clone());
        for path in ["report.html", "report.pdf"] {
            let mut stream = asset_read_stream(
                rpc.clone(),
                request(AssetResource::WorkspaceFile {
                    thread_id: "thread".into(),
                    path: path.into(),
                }),
                CancellationToken::new(),
            );
            assert_eq!(
                stream.recv().await.unwrap().unwrap_err()["_tag"],
                "AssetPreviewTypeValidationError"
            );
        }
        let mut stream = asset_read_stream(
            rpc.clone(),
            request(AssetResource::WorkspaceFile {
                thread_id: "thread".into(),
                path: "image.svg".into(),
            }),
            CancellationToken::new(),
        );
        assert_eq!(
            stream.recv().await.unwrap().unwrap()[0]["mimeType"],
            "image/svg+xml"
        );
        let guard = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            registry.mark_removing("thread", root.path()),
        )
        .await
        .unwrap()
        .unwrap();
        let mut refused = asset_read_stream(
            rpc,
            request(AssetResource::WorkspaceFile {
                thread_id: "thread".into(),
                path: "image.svg".into(),
            }),
            CancellationToken::new(),
        );
        assert_eq!(
            refused.recv().await.unwrap().unwrap_err()["_tag"],
            "WorkspaceUnavailableError"
        );
        drop(stream);
        drop(guard);
        let no_context = WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                asset_access: Some(AssetAccess::new(
                    vec![7; 32],
                    root.path().join("attachments"),
                )),
                asset_context_resolver: Some(std::sync::Arc::new(Resolver(None))),
                ..WorkspaceRpcDependencies::default()
            },
        );
        let mut refused = asset_read_stream(
            no_context,
            request(AssetResource::WorkspaceFile {
                thread_id: "unknown".into(),
                path: "image.svg".into(),
            }),
            CancellationToken::new(),
        );
        assert_eq!(
            refused.recv().await.unwrap().unwrap_err()["_tag"],
            "AssetWorkspaceContextNotFoundError"
        );
    }
    #[tokio::test]
    async fn asset_growth_over_limit_never_emits_end() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("attachments")).unwrap();
        let path = root.path().join("attachments/growing");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(1024 * 1024).unwrap();
        let mut stream = asset_read_stream(
            fixture(root.path()),
            request(AssetResource::Attachment {
                attachment_id: "growing".into(),
            }),
            CancellationToken::new(),
        );
        assert_eq!(
            stream.recv().await.unwrap().unwrap()[0]["sizeBytes"],
            1024 * 1024
        );
        file.set_len(10 * 1024 * 1024 + 1).unwrap();
        let mut failure = None;
        while let Some(chunk) = stream.recv().await {
            match chunk {
                Ok(events) => assert!(events.iter().all(|event| event["_tag"] != "end")),
                Err(error) => failure = Some(error),
            }
        }
        assert_eq!(failure.unwrap()["_tag"], "AssetTooLargeError");
    }
    #[tokio::test]
    async fn asset_truncation_and_containment_errors_preserve_required_wire_causes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("attachments")).unwrap();
        let path = root.path().join("attachments/truncated");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(1024 * 1024).unwrap();
        let resource = AssetResource::Attachment {
            attachment_id: "truncated".into(),
        };
        let mut stream = asset_read_stream(
            fixture(root.path()),
            request(resource.clone()),
            CancellationToken::new(),
        );
        assert_eq!(
            stream.recv().await.unwrap().unwrap()[0]["sizeBytes"],
            1024 * 1024
        );
        file.set_len(0).unwrap();
        let mut failure = None;
        while let Some(chunk) = stream.recv().await {
            match chunk {
                Ok(events) => assert!(events.iter().all(|event| event["_tag"] != "end")),
                Err(error) => failure = Some(error),
            }
        }
        let error = failure.unwrap();
        assert_eq!(error["_tag"], "AssetWorkspaceAssetInspectionError");
        assert!(
            error.get("cause").is_some(),
            "the emitted stream failure must decode against AssetAccessError"
        );
        let contract:Value=serde_json::from_str(include_str!("../../../../packages/contracts/fixtures/rpc-wire/contract-shapes/assets__read-truncated-failure.json")).unwrap();
        assert_eq!(
            error, contract["exit"]["cause"][0]["error"],
            "the runtime failure must match the same vector decoded by TypeScript"
        );
        let outside = WorkspaceRpc::asset_failure(
            &resource,
            &AssetError::Workspace(WorkspaceError::PathOutsideRoot {
                relative_path: "../secret".into(),
            }),
        );
        assert!(
            outside.get("cause").is_some(),
            "containment failure must also carry its schema-required cause"
        );
    }
    fn fixture(root: &Path) -> WorkspaceRpc {
        WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                asset_access: Some(AssetAccess::new(vec![7; 32], root.join("attachments"))),
                ..WorkspaceRpcDependencies::default()
            },
        )
    }
    fn request(resource: AssetResource) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").unwrap(),
            tag: "assets.read".into(),
            payload: json!({"resource":resource}),
            headers: vec![],
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }
    #[tokio::test]
    async fn small_asset_start_bytes_end_share_one_chunk_and_empty_omits_bytes() {
        let root = tempfile::tempdir().unwrap();
        let rpc = fixture(root.path());
        let resource = AssetResource::ProjectFavicon {
            cwd: root.path().to_string_lossy().into_owned(),
        };
        let mut stream =
            asset_read_stream(rpc.clone(), request(resource), CancellationToken::new());
        let values = stream.recv().await.unwrap().unwrap();
        assert_eq!(values.len(), 3);
        assert_eq!(values[0]["mimeType"], "image/svg+xml");
        assert_eq!(
            STANDARD
                .decode(values[1]["data"].as_str().unwrap())
                .unwrap(),
            FALLBACK_FAVICON.as_bytes()
        );
        assert_eq!(values[2], json!({"_tag":"end"}));
        assert!(stream.recv().await.is_none());
        std::fs::create_dir(root.path().join("attachments")).unwrap();
        std::fs::write(root.path().join("attachments/empty"), b"").unwrap();
        let mut stream = asset_read_stream(
            rpc,
            request(AssetResource::Attachment {
                attachment_id: "empty".into(),
            }),
            CancellationToken::new(),
        );
        let values = stream.recv().await.unwrap().unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["sizeBytes"], 0);
        assert_eq!(values[1]["_tag"], "end");
    }
    #[tokio::test]
    async fn asset_read_attachment_bytes_and_too_large_refusal() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("attachments")).unwrap();
        std::fs::write(root.path().join("attachments/small"), b"abc").unwrap();
        let mut stream = asset_read_stream(
            fixture(root.path()),
            request(AssetResource::Attachment {
                attachment_id: "small".into(),
            }),
            CancellationToken::new(),
        );
        let values = stream.recv().await.unwrap().unwrap();
        assert_eq!(
            STANDARD
                .decode(values[1]["data"].as_str().unwrap())
                .unwrap(),
            b"abc"
        );
        let file = std::fs::File::create(root.path().join("attachments/large")).unwrap();
        file.set_len(10 * 1024 * 1024 + 1).unwrap();
        let mut stream = asset_read_stream(
            fixture(root.path()),
            request(AssetResource::Attachment {
                attachment_id: "large".into(),
            }),
            CancellationToken::new(),
        );
        let error = stream.recv().await.unwrap().unwrap_err();
        assert_eq!(error["_tag"], "AssetTooLargeError");
        assert_eq!(error["limitBytes"], 10 * 1024 * 1024);
        assert!(stream.recv().await.is_none());
    }
    #[tokio::test]
    async fn asset_read_interrupt_stops_io_without_successful_end() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("attachments")).unwrap();
        std::fs::write(root.path().join("attachments/large"), vec![9; 1024 * 1024]).unwrap();
        let cancellation = CancellationToken::new();
        let mut stream = asset_read_stream(
            fixture(root.path()),
            request(AssetResource::Attachment {
                attachment_id: "large".into(),
            }),
            cancellation.clone(),
        );
        assert_eq!(stream.recv().await.unwrap().unwrap()[0]["_tag"], "start");
        cancellation.cancel();
        while let Some(chunk) = stream.recv().await {
            assert!(chunk.unwrap().iter().all(|event| event["_tag"] != "end"));
        }
    }
}
