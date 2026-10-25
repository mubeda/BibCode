//! Registers the repository-scoped Pipelines RPC surface. It mirrors
//! `pull_requests_rpc.rs`, and is the one place the `pipelines.subscribe`
//! stream's task is spawned.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    pull_requests::{
        error::PullRequestsOperationError,
        pipelines::{
            PipelinesService,
            model::{
                self, GetInput, JobInput, JobLogInput, ListInput, LogFrom, RunActionInput,
                SubscribeInput,
            },
        },
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
};

const SUBSCRIBE_STREAM_CAPACITY: usize = 8;
/// Ids above this do not fit a JavaScript `Number`.
const MAX_ID: u64 = 9_007_199_254_740_991;

pub const PIPELINES_UNARY_METHODS: &[&str] = &[
    "pipelines.list",
    "pipelines.get",
    "pipelines.getJob",
    "pipelines.getJobLog",
    "pipelines.readSnapshot",
    "pipelines.runAction",
];

pub const PIPELINES_STREAM_METHODS: &[&str] = &["pipelines.subscribe"];

/// What each capability flag promises: a server advertises a flag only when
/// every method it names is registered.
pub const PIPELINES_READS_METHODS: &[&str] = &[
    "pipelines.list",
    "pipelines.get",
    "pipelines.getJob",
    "pipelines.getJobLog",
    "pipelines.readSnapshot",
    "pipelines.subscribe",
];
pub const PIPELINES_MUTATIONS_METHODS: &[&str] = &["pipelines.runAction"];

/// Every method this server registers, so the advertised flags can say so.
pub fn pipelines_reads_registered() -> bool {
    PIPELINES_READS_METHODS.iter().all(|method| {
        PIPELINES_UNARY_METHODS.contains(method) || PIPELINES_STREAM_METHODS.contains(method)
    })
}

pub fn pipelines_mutations_registered() -> bool {
    PIPELINES_MUTATIONS_METHODS.iter().all(|method| {
        PIPELINES_UNARY_METHODS.contains(method) || PIPELINES_STREAM_METHODS.contains(method)
    })
}

#[derive(Clone)]
pub struct PipelinesRpcServices {
    pub service: PipelinesService,
}

impl PipelinesRpcServices {
    pub fn new(service: PipelinesService) -> Self {
        Self { service }
    }

    async fn handle_read_unary(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let operation = request.tag.as_str();
        match operation {
            "pipelines.list" => {
                let input: ListInput = decode(request.payload, operation)?;
                validate_cwd(&input.cwd, operation)?;
                if input.workflow_id.is_some_and(|id| id > MAX_ID) {
                    return Err(invalid_request(operation));
                }
                encode(self.service.list(input, &cancellation).await, operation)
            }
            "pipelines.get" => {
                let input: GetInput = decode(request.payload, operation)?;
                validate_cwd(&input.cwd, operation)?;
                validate_id(input.pipeline_id, operation)?;
                if input
                    .attempt
                    .is_some_and(|attempt| attempt == 0 || attempt > MAX_ID)
                {
                    return Err(invalid_request(operation));
                }
                encode(self.service.get(input, &cancellation).await, operation)
            }
            "pipelines.getJob" => {
                let input: JobInput = decode(request.payload, operation)?;
                validate_cwd(&input.cwd, operation)?;
                validate_id(input.job_id, operation)?;
                encode(self.service.job(input, &cancellation).await, operation)
            }
            "pipelines.getJobLog" => {
                let input: JobLogInput = decode(request.payload, operation)?;
                validate_cwd(&input.cwd, operation)?;
                validate_id(input.job_id, operation)?;
                if let LogFrom::Offset { offset } | LogFrom::Before { offset } = input.from
                    && offset > MAX_ID
                {
                    return Err(invalid_request(operation));
                }
                encode(self.service.job_log(input, &cancellation).await, operation)
            }
            "pipelines.readSnapshot" => {
                let input: SubscribeInput = decode(request.payload, operation)?;
                validate_subscribe(&input, operation)?;
                encode(
                    self.service.read_snapshot(input, &cancellation).await,
                    operation,
                )
            }
            _ => Err(json!(PullRequestsOperationError::new(
                operation,
                "unavailable"
            ))),
        }
    }

    async fn handle_mutation_unary(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let operation = request.tag.as_str();
        let input: RunActionInput = decode(request.payload, operation)?;
        validate_cwd(&input.cwd, operation)?;
        validate_id(input.target.id(), operation)?;
        encode(
            self.service.run_action(input, &cancellation).await,
            operation,
        )
    }

    fn handle_subscribe(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(SUBSCRIBE_STREAM_CAPACITY);
        let service = self.service.clone();
        let operation = request.tag.clone();
        tokio::spawn(async move {
            let input = match decode::<SubscribeInput>(request.payload, &operation)
                .and_then(|input| validate_subscribe(&input, &operation).map(|()| input))
            {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let emit = forward_changed_to_stream(sender.clone());
            if let Err(error) = service.subscribe(input, &emit, &cancellation).await {
                let _ = sender.send(Err(json!(error))).await;
            }
        });
        receiver
    }
}

/// The poller calls `emit` synchronously from inside its tick: a full
/// stream refuses the event and `emit` answers `false`, so the poller sends
/// those names with its next event.
fn forward_changed_to_stream(
    sender: mpsc::Sender<RpcStreamChunk>,
) -> impl Fn(model::Changed) -> bool + Send + Sync {
    move |changed: model::Changed| sender.try_send(Ok(vec![json!(changed)])).is_ok()
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value, operation: &str) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|_| invalid_request(operation))
}

fn validate_cwd(cwd: &str, operation: &str) -> Result<(), Value> {
    if Path::new(cwd).as_os_str().is_empty() || cwd.trim().is_empty() {
        Err(invalid_request(operation))
    } else {
        Ok(())
    }
}

fn validate_id(id: u64, operation: &str) -> Result<(), Value> {
    if id == 0 || id > MAX_ID {
        Err(invalid_request(operation))
    } else {
        Ok(())
    }
}

fn validate_subscribe(input: &SubscribeInput, operation: &str) -> Result<(), Value> {
    validate_cwd(&input.list.cwd, operation)?;
    for id in [input.pipeline_id, input.job_id].into_iter().flatten() {
        validate_id(id, operation)?;
    }
    Ok(())
}

fn invalid_request(operation: &str) -> Value {
    let mut error = PullRequestsOperationError::new(operation, "host_rejected");
    error.message = "The Pipelines request is invalid.".into();
    json!(error)
}

fn encode<T: Serialize>(
    result: Result<T, PullRequestsOperationError>,
    operation: &str,
) -> RpcResult {
    result.map_err(|error| json!(error)).and_then(|value| {
        serde_json::to_value(value).map_err(|_| {
            json!(PullRequestsOperationError::new(
                operation,
                "invalid_response"
            ))
        })
    })
}

pub fn register_pipelines_rpc(registry: &mut RpcRegistry, services: PipelinesRpcServices) {
    for method in PIPELINES_UNARY_METHODS {
        let services = services.clone();
        if PIPELINES_MUTATIONS_METHODS.contains(method) {
            registry.register_unary(*method, move |request, cancellation| {
                let services = services.clone();
                async move { services.handle_mutation_unary(request, cancellation).await }
            });
        } else {
            registry.register_unary(*method, move |request, cancellation| {
                let services = services.clone();
                async move { services.handle_read_unary(request, cancellation).await }
            });
        }
    }
    for method in PIPELINES_STREAM_METHODS {
        let services = services.clone();
        registry.register_stream(*method, move |request, cancellation| {
            services.handle_subscribe(request, cancellation)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        pull_requests::PullRequestsService,
        rpc::{ACTIVE_RPC_METHODS, MethodMode, RequestId},
    };
    use std::path::PathBuf;

    fn services() -> PipelinesRpcServices {
        PipelinesRpcServices::new(PullRequestsService::new(PathBuf::new()).pipelines())
    }

    fn request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").unwrap(),
            tag: tag.into(),
            payload,
            headers: vec![],
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    #[test]
    fn registers_every_pipelines_method_needed_by_production_startup() {
        let mut registry = RpcRegistry::empty();
        for method in ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| !method.name.starts_with("pipelines."))
        {
            match method.mode {
                MethodMode::Unary => {
                    registry.register_unary(method.name, |_, _| async { Ok(json!({})) })
                }
                MethodMode::Stream => registry.register_stream(method.name, |_, _| {
                    let (_, receiver) = tokio::sync::mpsc::channel(1);
                    receiver
                }),
            }
        }
        assert!(registry.validate_complete().is_err());
        register_pipelines_rpc(&mut registry, services());
        registry.validate_complete().unwrap();
        assert_eq!(PIPELINES_UNARY_METHODS.len(), 6);
        assert_eq!(PIPELINES_STREAM_METHODS.len(), 1);
        for method in PIPELINES_UNARY_METHODS {
            assert!(
                ACTIVE_RPC_METHODS
                    .iter()
                    .any(|active| active.name == *method && active.mode == MethodMode::Unary),
                "{method}"
            );
        }
        assert!(ACTIVE_RPC_METHODS.iter().any(|active| {
            active.name == "pipelines.subscribe" && active.mode == MethodMode::Stream
        }));
    }

    /// `pipelinesReads` names the six reads and `pipelinesMutations` names
    /// `runAction`, all registered here.
    #[test]
    fn each_advertised_pipelines_flag_names_only_registered_methods() {
        assert!(pipelines_reads_registered());
        assert!(pipelines_mutations_registered());
        // Every registered method is one a flag promises.
        for method in PIPELINES_UNARY_METHODS
            .iter()
            .chain(PIPELINES_STREAM_METHODS)
        {
            assert!(
                PIPELINES_READS_METHODS.contains(method)
                    || PIPELINES_MUTATIONS_METHODS.contains(method),
                "{method} belongs to no capability flag"
            );
        }
    }

    #[tokio::test]
    async fn pipelines_subscribe_emit_forwards_changed_events_and_reports_a_full_stream() {
        let (sender, mut receiver) = mpsc::channel(SUBSCRIBE_STREAM_CAPACITY);
        let emit = forward_changed_to_stream(sender);
        let changed = model::Changed {
            list: true,
            pipeline: false,
            refused: None,
        };
        assert!(emit(changed));
        assert_eq!(
            receiver.recv().await.unwrap(),
            Ok(vec![json!({"list": true, "pipeline": false})])
        );
        // A refused pipeline's name says why, in the contract's words.
        assert!(emit(model::Changed {
            list: false,
            pipeline: true,
            refused: Some(model::Refusal::NotFound),
        }));
        assert_eq!(
            receiver.recv().await.unwrap(),
            Ok(vec![
                json!({"list": false, "pipeline": true, "refused": "not_found"})
            ])
        );
        for _ in 0..SUBSCRIBE_STREAM_CAPACITY {
            assert!(emit(model::Changed::default()));
        }
        assert!(
            !emit(model::Changed::default()),
            "a full stream refuses the event and says so"
        );
        assert!(receiver.recv().await.unwrap().is_ok());
        assert!(emit(model::Changed::default()), "room again after a read");
    }

    #[tokio::test]
    async fn pipelines_rpc_ids_and_payloads_are_validated_before_any_read() {
        let services = services();
        for (method, payload) in [
            (
                "pipelines.get",
                json!({"cwd":"/repo","pipelineId":0,"attempt":null,"refresh":"user"}),
            ),
            (
                "pipelines.get",
                json!({"cwd":"/repo","pipelineId":9_007_199_254_740_992_u64,"attempt":null,"refresh":"user"}),
            ),
            (
                "pipelines.getJob",
                json!({"cwd":"/repo","jobId":"secret-id","refresh":"user"}),
            ),
            (
                "pipelines.getJobLog",
                json!({"cwd":"/repo","jobId":1,"attempt":null,"from":{"_tag":"middle"},"refresh":"user"}),
            ),
            (
                "pipelines.list",
                json!({"cwd":"  ","scope":"all","ref":null,"workflowId":null,"cursor":null,"refresh":"user"}),
            ),
            (
                "pipelines.list",
                json!({"cwd":"/repo","scope":"later","ref":null,"workflowId":null,"cursor":null,"refresh":"user"}),
            ),
            (
                "pipelines.runAction",
                json!({"cwd":"/repo","target":{"_tag":"job","id":0},"action":"retry"}),
            ),
            (
                "pipelines.runAction",
                json!({"cwd":"/repo","target":{"_tag":"pipeline","id":4821},"action":"delete"}),
            ),
            (
                "pipelines.runAction",
                json!({"cwd":" ","target":{"_tag":"pipeline","id":4821},"action":"retry"}),
            ),
        ] {
            let request = request(method, payload);
            let error = if method == "pipelines.runAction" {
                services
                    .handle_mutation_unary(request, CancellationToken::new())
                    .await
            } else {
                services
                    .handle_read_unary(request, CancellationToken::new())
                    .await
            }
            .unwrap_err();
            assert_eq!(error["code"], "host_rejected", "{method}");
            assert_eq!(error["message"], "The Pipelines request is invalid.");
            assert!(!error.to_string().contains("secret-id"));
        }
    }
}
