use std::{
    any::Any,
    collections::HashMap,
    future::Future,
    io,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{FutureExt, Sink, SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use super::{
    byte_budget::{RpcOutboundBudget, RpcOutboundBytePermit},
    message::{ClientMessage, RequestId, RpcRequest, ServerMessage},
    methods::{ACTIVE_RPC_METHODS, MethodMode},
};
use crate::{
    auth::{AuthService, Principal, authorization_error, required_scope},
    diagnostics::TraceDiagnosticsStore,
    maintenance::{RpcAdmissionGate, RpcPermit, rpc_mutability},
};

const OUTBOUND_CAPACITY: usize = 64;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const PUMP_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

pub type RpcResult = Result<Value, Value>;
pub type RpcStreamChunk = Result<Vec<Value>, Value>;
type UnaryFuture = Pin<Box<dyn Future<Output = RpcUnaryResult> + Send + 'static>>;
type UnaryHandler =
    Arc<dyn Fn(RpcRequest, RpcSessionContext, CancellationToken) -> UnaryFuture + Send + Sync>;
type StreamHandler = Arc<
    dyn Fn(RpcRequest, RpcSessionContext, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
        + Send
        + Sync,
>;
type LatestStreamHandler = Arc<
    dyn Fn(
            RpcRequest,
            RpcSessionContext,
            CancellationToken,
        ) -> watch::Receiver<Option<RpcStreamChunk>>
        + Send
        + Sync,
>;

pub(crate) trait RpcResponseEnqueueGuard: Send {
    fn encoded_len_bound(&self, response: &ServerMessage) -> Result<usize, serde_json::Error> {
        encoded_server_message_len(response)
    }

    fn enqueue(self: Box<Self>, permit: RpcResponseEnqueuePermit, response: ServerMessage);
}

pub(crate) struct RpcOutboundFrame {
    payload: RpcOutboundPayload,
    _budget: Option<RpcOutboundBytePermit>,
}

enum RpcOutboundPayload {
    Plain(ServerMessage),
    Encoded(Message),
}

impl RpcOutboundFrame {
    fn into_wire(self) -> Result<Self, serde_json::Error> {
        let payload = match self.payload {
            RpcOutboundPayload::Plain(message) => {
                RpcOutboundPayload::Encoded(Message::Text(serde_json::to_string(&message)?.into()))
            }
            payload @ RpcOutboundPayload::Encoded(_) => payload,
        };
        Ok(Self {
            payload,
            _budget: self._budget,
        })
    }

    pub(crate) fn into_parts(self) -> (Message, Option<RpcOutboundBytePermit>) {
        let RpcOutboundPayload::Encoded(message) = self.payload else {
            unreachable!("RPC writer encodes plain responses before the transport sink")
        };
        (message, self._budget)
    }
}

pub(crate) struct RpcResponseEnqueuePermit {
    permit: mpsc::OwnedPermit<RpcOutboundFrame>,
    budget: Option<RpcOutboundBytePermit>,
    encoded_len_bound: usize,
}

pub(crate) struct PreparedRpcResponse {
    payload: RpcOutboundPayload,
    encoded_len: usize,
}

impl RpcResponseEnqueuePermit {
    pub(crate) fn prepare(&self, response: ServerMessage) -> Option<PreparedRpcResponse> {
        if self.budget.is_some() {
            let encoded = serde_json::to_string(&response).ok()?;
            (encoded.len() <= self.encoded_len_bound).then(|| PreparedRpcResponse {
                encoded_len: encoded.len(),
                payload: RpcOutboundPayload::Encoded(Message::Text(encoded.into())),
            })
        } else {
            Some(PreparedRpcResponse {
                payload: RpcOutboundPayload::Plain(response),
                encoded_len: 0,
            })
        }
    }

    pub(crate) fn send_prepared(mut self, prepared: PreparedRpcResponse) {
        if let Some(budget) = &mut self.budget
            && budget.shrink_to(prepared.encoded_len).is_err()
        {
            return;
        }
        self.permit.send(RpcOutboundFrame {
            payload: prepared.payload,
            _budget: self.budget,
        });
    }
}

#[derive(Clone)]
struct RpcOutboundQueue {
    sender: mpsc::Sender<RpcOutboundFrame>,
    budget: Option<RpcOutboundBudget>,
}

impl RpcOutboundQueue {
    async fn acquire_budget(
        &self,
        shutdown: &CancellationToken,
        bytes: usize,
        deadline: Instant,
    ) -> Result<Option<RpcOutboundBytePermit>, ()> {
        let Some(budget) = &self.budget else {
            return Ok(None);
        };
        let result = tokio::select! {
            () = shutdown.cancelled() => Err(()),
            result = budget.acquire(bytes, deadline) => result,
        };
        if result.is_err() && bytes > budget.connection_capacity {
            shutdown.cancel();
        }
        result.map(Some)
    }

    #[cfg(test)]
    fn try_send(&self, message: ServerMessage) -> Result<(), ()> {
        let (payload, budget) = if let Some(budget) = &self.budget {
            let encoded = serde_json::to_string(&message).map_err(|_| ())?;
            let permit = budget.try_acquire(encoded.len())?;
            (
                RpcOutboundPayload::Encoded(Message::Text(encoded.into())),
                Some(permit),
            )
        } else {
            (RpcOutboundPayload::Plain(message), None)
        };
        self.sender
            .try_send(RpcOutboundFrame {
                payload,
                _budget: budget,
            })
            .map_err(|_| ())
    }
}

pub(crate) struct RpcUnaryResult {
    result: RpcResult,
    enqueue_guard: Option<Box<dyn RpcResponseEnqueueGuard>>,
}

impl RpcUnaryResult {
    pub(crate) fn plain(result: RpcResult) -> Self {
        Self {
            result,
            enqueue_guard: None,
        }
    }

    pub(crate) fn guarded(
        result: RpcResult,
        enqueue_guard: impl RpcResponseEnqueueGuard + 'static,
    ) -> Self {
        Self {
            result,
            enqueue_guard: Some(Box::new(enqueue_guard)),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct RpcSessionContext {
    principal: Option<Principal>,
    auth: Option<AuthService>,
    admission: Option<RpcPermit>,
    pairing_confirmation: Option<PairingConfirmationLatch>,
}

#[derive(Clone, Default)]
pub(crate) struct PairingConfirmationLatch(Arc<AtomicBool>);

impl PairingConfirmationLatch {
    pub(crate) fn mark_confirmed(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub(crate) fn is_confirmed(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl RpcSessionContext {
    #[must_use]
    pub(crate) fn unauthenticated() -> Self {
        Self::default()
    }

    #[must_use]
    pub(crate) fn authenticated(principal: Principal, auth: AuthService) -> Self {
        Self {
            principal: Some(principal),
            auth: Some(auth),
            admission: None,
            pairing_confirmation: None,
        }
    }

    #[must_use]
    pub(crate) fn authenticated_pending_pairing(
        principal: Principal,
        auth: AuthService,
        pairing_confirmation: PairingConfirmationLatch,
    ) -> Self {
        Self {
            principal: Some(principal),
            auth: Some(auth),
            admission: None,
            pairing_confirmation: Some(pairing_confirmation),
        }
    }

    #[must_use]
    fn with_admission(mut self, admission: RpcPermit) -> Self {
        self.admission = Some(admission);
        self
    }

    #[must_use]
    pub(crate) fn admission_permit(&self) -> Option<RpcPermit> {
        self.admission.clone()
    }

    #[must_use]
    pub(crate) fn current_session_id(&self) -> Option<&str> {
        self.principal
            .as_ref()
            .map(|principal| principal.session_id.as_str())
    }

    fn has_pending_pairing_capability_for(&self, method: &str) -> bool {
        self.pairing_confirmation.is_some() && method == "auth.confirmPairing"
    }

    pub(crate) async fn confirm_current_pairing(&self) -> bool {
        let (Some(principal), Some(auth)) = (&self.principal, &self.auth) else {
            return false;
        };
        let session_id = principal.session_id.clone();
        let auth = auth.clone();
        let pairing_confirmation = self.pairing_confirmation.clone();
        let activation = tokio::spawn(async move {
            let Ok(true) = auth.confirm_pending_pairing_session(&session_id).await else {
                return false;
            };
            if let Some(latch) = pairing_confirmation {
                latch.mark_confirmed();
            }
            true
        });
        match activation.await {
            Ok(confirmed) => confirmed,
            Err(error) => {
                tracing::error!(%error, "pairing-session activation task failed");
                false
            }
        }
    }

    pub(crate) async fn is_currently_authorized(&self, required_scope: &str) -> bool {
        match (&self.principal, &self.auth) {
            (Some(principal), Some(auth)) => auth
                .authorize_session(&principal.session_id, required_scope)
                .await
                .is_ok(),
            (None, None) => true,
            _ => false,
        }
    }
}

#[derive(Clone)]
enum RpcMethod {
    Unary(UnaryHandler),
    Stream(StreamHandler),
    LatestStream(LatestStreamHandler),
}

#[derive(Clone, Default)]
pub struct RpcRegistry {
    methods: HashMap<String, RpcMethod>,
    trace_diagnostics: Option<TraceDiagnosticsStore>,
    admission_gate: RpcAdmissionGate,
}

impl RpcRegistry {
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_trace_diagnostics(trace_diagnostics: TraceDiagnosticsStore) -> Self {
        Self {
            methods: HashMap::new(),
            trace_diagnostics: Some(trace_diagnostics),
            admission_gate: RpcAdmissionGate::new(),
        }
    }

    pub(crate) fn admission_gate(&self) -> RpcAdmissionGate {
        self.admission_gate.clone()
    }

    pub fn register_unary<F, Fut>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult> + Send + 'static,
    {
        let handler = Arc::new(move |request, _context, cancellation| {
            let future = handler(request, cancellation);
            Box::pin(async move { RpcUnaryResult::plain(future.await) }) as UnaryFuture
        });
        self.register_unary_handler(name.into(), handler);
    }

    pub(crate) fn register_unary_with_context<F, Fut>(
        &mut self,
        name: impl Into<String>,
        handler: F,
    ) where
        F: Fn(RpcRequest, RpcSessionContext, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult> + Send + 'static,
    {
        let handler = Arc::new(move |request, context, cancellation| {
            let future = handler(request, context, cancellation);
            Box::pin(async move { RpcUnaryResult::plain(future.await) }) as UnaryFuture
        });
        self.register_unary_handler(name.into(), handler);
    }

    pub(crate) fn register_guarded_unary<F, Fut>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcUnaryResult> + Send + 'static,
    {
        let handler = Arc::new(move |request, _context, cancellation| {
            Box::pin(handler(request, cancellation)) as UnaryFuture
        });
        self.register_unary_handler(name.into(), handler);
    }

    fn register_unary_handler(&mut self, name: String, handler: UnaryHandler) {
        let trace_diagnostics = self.trace_diagnostics.clone();
        let diagnostic_name = name.clone();
        self.methods.insert(
            name,
            RpcMethod::Unary(Arc::new(move |request, context, cancellation| {
                let future = handler(request, context, cancellation);
                let trace_diagnostics = trace_diagnostics.clone();
                let diagnostic_name = diagnostic_name.clone();
                Box::pin(async move {
                    let result = future.await;
                    if let (Some(trace_diagnostics), Err(error)) =
                        (&trace_diagnostics, &result.result)
                        && let Err(write_error) =
                            trace_diagnostics.record_failure(&diagnostic_name, error)
                    {
                        tracing::warn!(
                            method = diagnostic_name,
                            error = %write_error,
                            "failed to persist RPC diagnostics"
                        );
                    }
                    result
                })
            })),
        );
    }

    pub fn register_stream<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
            + Send
            + Sync
            + 'static,
    {
        self.methods.insert(
            name.into(),
            RpcMethod::Stream(Arc::new(move |request, _context, cancellation| {
                handler(request, cancellation)
            })),
        );
    }

    pub fn register_latest_stream<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, CancellationToken) -> watch::Receiver<Option<RpcStreamChunk>>
            + Send
            + Sync
            + 'static,
    {
        self.methods.insert(
            name.into(),
            RpcMethod::LatestStream(Arc::new(move |request, _context, cancellation| {
                handler(request, cancellation)
            })),
        );
    }

    pub(crate) fn register_stream_with_context<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(RpcRequest, RpcSessionContext, CancellationToken) -> mpsc::Receiver<RpcStreamChunk>
            + Send
            + Sync
            + 'static,
    {
        self.methods
            .insert(name.into(), RpcMethod::Stream(Arc::new(handler)));
    }

    fn get(&self, name: &str) -> Option<RpcMethod> {
        self.methods.get(name).cloned()
    }

    pub fn validate_complete(&self) -> Result<(), String> {
        let mut issues = Vec::new();
        for spec in ACTIVE_RPC_METHODS {
            match (spec.mode, self.methods.get(spec.name)) {
                (MethodMode::Unary, Some(RpcMethod::Unary(_)))
                | (MethodMode::Stream, Some(RpcMethod::Stream(_) | RpcMethod::LatestStream(_))) => {
                }
                (_, None) => issues.push(format!("missing {}", spec.name)),
                (expected, Some(_)) => {
                    issues.push(format!(
                        "wrong mode for {}: expected {expected:?}",
                        spec.name
                    ));
                }
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues.join(", "))
        }
    }
}

struct InFlight {
    cancellation: CancellationToken,
    acknowledgements: Option<mpsc::Sender<()>>,
    task: JoinHandle<()>,
}

struct DispatchContext<'a> {
    registry: &'a RpcRegistry,
    session: &'a RpcSessionContext,
    outbound: &'a RpcOutboundQueue,
    completed: &'a mpsc::Sender<RequestId>,
    shutdown: &'a CancellationToken,
}

trait RpcInboundGuard: Send + Sync {}

impl<T: Send + Sync> RpcInboundGuard for T {}

type SharedRpcInboundGuard = Arc<dyn RpcInboundGuard>;

pub(crate) struct RpcInboundFrame {
    message: Message,
    guard: Option<SharedRpcInboundGuard>,
}

impl RpcInboundFrame {
    fn plain(message: Message) -> Self {
        Self {
            message,
            guard: None,
        }
    }

    pub(crate) fn guarded(message: Message, guard: impl Send + Sync + 'static) -> Self {
        Self {
            message,
            guard: Some(Arc::new(guard)),
        }
    }
}

pub(crate) async fn run_session(
    socket: WebSocket,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
) {
    let (socket_writer, socket_reader) = socket.split();
    let socket_reader = socket_reader.map(|frame| frame.map(RpcInboundFrame::plain));
    run_session_split(
        socket_writer,
        socket_reader,
        registry,
        context,
        session_shutdown,
    )
    .await;
}

struct PlainRpcSink<W> {
    inner: W,
    pending_budget: Option<RpcOutboundBytePermit>,
}

impl<W> PlainRpcSink<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            pending_budget: None,
        }
    }
}

impl<W> Sink<RpcOutboundFrame> for PlainRpcSink<W>
where
    W: Sink<Message> + Unpin,
{
    type Error = W::Error;

    fn poll_ready(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.inner).poll_ready(context)
    }

    fn start_send(mut self: Pin<&mut Self>, frame: RpcOutboundFrame) -> Result<(), Self::Error> {
        let (message, budget) = frame.into_parts();
        let result = Pin::new(&mut self.inner).start_send(message);
        if result.is_ok() {
            debug_assert!(self.pending_budget.is_none());
            self.pending_budget = budget;
        }
        result
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        let result = Pin::new(&mut self.inner).poll_flush(context);
        if result.is_ready() {
            self.pending_budget = None;
        }
        result
    }

    fn poll_close(
        mut self: Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        let result = Pin::new(&mut self.inner).poll_close(context);
        if result.is_ready() {
            self.pending_budget = None;
        }
        result
    }
}

pub(crate) async fn run_session_split<W, R>(
    socket_writer: W,
    socket_reader: R,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
) where
    W: Sink<Message> + Unpin + Send + 'static,
    W::Error: Send,
    R: Stream<Item = Result<RpcInboundFrame, axum::Error>> + Send,
{
    run_session_split_budgeted(
        PlainRpcSink::new(socket_writer),
        socket_reader,
        registry,
        context,
        session_shutdown,
        None,
    )
    .await;
}

pub(crate) async fn run_session_split_budgeted<W, R>(
    mut socket_writer: W,
    socket_reader: R,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
    outbound_budget: Option<RpcOutboundBudget>,
) where
    W: Sink<RpcOutboundFrame> + Unpin + Send + 'static,
    W::Error: Send,
    R: Stream<Item = Result<RpcInboundFrame, axum::Error>> + Send,
{
    let socket_reader = socket_reader;
    let mut socket_reader = std::pin::pin!(socket_reader);
    let (outbound_sender, mut outbound_receiver) =
        mpsc::channel::<RpcOutboundFrame>(OUTBOUND_CAPACITY);
    let outbound = RpcOutboundQueue {
        sender: outbound_sender,
        budget: outbound_budget,
    };
    let writer_shutdown = session_shutdown.clone();
    let mut writer = tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                () = writer_shutdown.cancelled() => break,
                message = outbound_receiver.recv() => {
                    let Some(message) = message else {
                        break;
                    };
                    message
                }
            };
            let Ok(message) = message.into_wire() else {
                break;
            };
            if !matches!(
                timeout(SOCKET_WRITE_TIMEOUT, socket_writer.send(message),).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
        let _ = timeout(SOCKET_WRITE_TIMEOUT, socket_writer.close()).await;
    });
    let (completed_sender, mut completed_receiver) =
        mpsc::channel::<RequestId>(MAX_IN_FLIGHT_REQUESTS);
    let mut in_flight = HashMap::<RequestId, InFlight>::new();
    let mut received_eof = false;
    {
        let dispatch = DispatchContext {
            registry: &registry,
            session: &context,
            outbound: &outbound,
            completed: &completed_sender,
            shutdown: &session_shutdown,
        };

        loop {
            if received_eof && in_flight.is_empty() {
                break;
            }

            tokio::select! {
                () = session_shutdown.cancelled() => break,
                completed = completed_receiver.recv(), if !in_flight.is_empty() => {
                    let Some(request_id) = completed else {
                        break;
                    };
                    if let Some(in_flight_request) = in_flight.remove(&request_id) {
                        let _ = in_flight_request.task.await;
                    }
                }
                frame = socket_reader.next() => {
                    let Some(frame) = frame else {
                        break;
                    };
                    let Ok(frame) = frame else {
                        break;
                    };
                    let RpcInboundFrame { message: frame, guard } = frame;
                    let decoded = match frame {
                        Message::Text(text) => decode_client_messages(text.as_bytes()),
                        Message::Binary(bytes) => decode_client_messages(&bytes),
                        Message::Close(_) => break,
                        Message::Ping(_) | Message::Pong(_) => continue,
                    };
                    let messages = match decoded {
                        Ok(messages) => messages,
                        Err(error) => {
                            if send_server_message(
                                &outbound,
                                &session_shutdown,
                                client_protocol_error(error.to_string()),
                            )
                            .await
                            .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                    };
                    for message in messages {
                        if process_client_message(
                            message,
                            &dispatch,
                            &mut in_flight,
                            &mut received_eof,
                            guard.clone(),
                        )
                        .await
                        .is_err()
                        {
                            received_eof = true;
                            break;
                        }
                    }
                }
            }
        }
    }

    session_shutdown.cancel();
    for request in in_flight.values() {
        request.cancellation.cancel();
    }
    // Cancelled handlers are expected to exit promptly; a handler that ignores
    // cancellation must not pin the session (and every budget permit riding on
    // it) forever, so the join is bounded and stragglers are aborted.
    let mut request_tasks: Vec<JoinHandle<()>> = in_flight
        .into_values()
        .map(|request| request.task)
        .collect();
    let join_all = async {
        for task in &mut request_tasks {
            let _ = task.await;
        }
    };
    if timeout(PUMP_JOIN_TIMEOUT, join_all).await.is_err() {
        for task in &request_tasks {
            task.abort();
        }
        for task in &mut request_tasks {
            let _ = task.await;
        }
    }
    drop(outbound);
    drop(completed_sender);
    if timeout(PUMP_JOIN_TIMEOUT, &mut writer).await.is_err() {
        writer.abort();
        let _ = writer.await;
    }
}

async fn process_client_message(
    message: ClientMessage,
    dispatch: &DispatchContext<'_>,
    in_flight: &mut HashMap<RequestId, InFlight>,
    received_eof: &mut bool,
    _inbound_guard: Option<SharedRpcInboundGuard>,
) -> Result<(), ()> {
    if *received_eof && matches!(message, ClientMessage::Request { .. }) {
        return Ok(());
    }

    match message {
        ClientMessage::Ping => {
            send_server_message(dispatch.outbound, dispatch.shutdown, ServerMessage::Pong).await
        }
        ClientMessage::Eof => {
            *received_eof = true;
            Ok(())
        }
        ClientMessage::Ack { request_id } => {
            if let Some(sender) = in_flight
                .get(&request_id)
                .and_then(|request| request.acknowledgements.as_ref())
            {
                let _ = sender.try_send(());
            }
            Ok(())
        }
        ClientMessage::Interrupt { request_id } => {
            if let Some(request) = in_flight.get(&request_id) {
                request.cancellation.cancel();
                return Ok(());
            }
            send_server_message(
                dispatch.outbound,
                dispatch.shutdown,
                ServerMessage::interrupt(request_id),
            )
            .await
        }
        ClientMessage::Request {
            id,
            tag,
            payload,
            headers,
            trace_id,
            span_id,
            sampled,
        } => {
            let request = RpcRequest {
                id,
                tag,
                payload,
                headers,
                trace_id,
                span_id,
                sampled,
            };
            if in_flight.contains_key(&request.id) {
                return Ok(());
            }
            if in_flight.len() >= MAX_IN_FLIGHT_REQUESTS {
                return send_server_message(
                    dispatch.outbound,
                    dispatch.shutdown,
                    ServerMessage::connection_defect("RPC in-flight request limit exceeded"),
                )
                .await;
            }
            let Some(method) = dispatch.registry.get(&request.tag) else {
                return send_server_message(
                    dispatch.outbound,
                    dispatch.shutdown,
                    ServerMessage::connection_defect(format!(
                        "Unknown request tag: {}",
                        request.tag
                    )),
                )
                .await;
            };
            if let Some(principal) = dispatch.session.principal.as_ref() {
                let Some(scope) = required_scope(&request.tag) else {
                    return send_server_message(
                        dispatch.outbound,
                        dispatch.shutdown,
                        ServerMessage::connection_defect(format!(
                            "RPC method {} has no declared authorization scope",
                            request.tag
                        )),
                    )
                    .await;
                };
                if let Some(auth) = dispatch.session.auth.as_ref()
                    && !dispatch
                        .session
                        .has_pending_pairing_capability_for(&request.tag)
                {
                    match auth.authorize_session(&principal.session_id, scope).await {
                        Ok(()) => {}
                        Err(crate::auth::AuthError::ScopeRequired(_)) => {
                            return send_server_message(
                                dispatch.outbound,
                                dispatch.shutdown,
                                ServerMessage::failure(
                                    request.id.clone(),
                                    authorization_error(scope),
                                ),
                            )
                            .await;
                        }
                        Err(_) => {
                            return send_server_message(
                                dispatch.outbound,
                                dispatch.shutdown,
                                ServerMessage::connection_defect(
                                    "Authenticated session is no longer valid",
                                ),
                            )
                            .await;
                        }
                    }
                }
            }
            let admission = match dispatch
                .registry
                .admission_gate
                .admit_named(rpc_mutability(&request.tag), request.tag.clone())
            {
                Ok(admission) => admission,
                Err(error) => {
                    return send_server_message(
                        dispatch.outbound,
                        dispatch.shutdown,
                        ServerMessage::failure(
                            request.id.clone(),
                            json!({
                                "_tag": "UpdateMaintenanceActiveError",
                                "message": error.to_string(),
                            }),
                        ),
                    )
                    .await;
                }
            };
            spawn_request(request, method, admission, dispatch, in_flight);
            Ok(())
        }
    }
}

fn spawn_request(
    request: RpcRequest,
    method: RpcMethod,
    admission: RpcPermit,
    dispatch: &DispatchContext<'_>,
    in_flight: &mut HashMap<RequestId, InFlight>,
) {
    let request_id = request.id.clone();
    let cancellation = CancellationToken::new();
    let request_cancellation = cancellation.clone();
    let context = dispatch.session.clone().with_admission(admission.clone());
    let outbound = dispatch.outbound.clone();
    let completed = dispatch.completed.clone();
    let session_shutdown = dispatch.shutdown.clone();
    let (acknowledgements, acknowledgement_receiver) = match method {
        RpcMethod::Unary(_) => (None, None),
        RpcMethod::Stream(_) | RpcMethod::LatestStream(_) => {
            let (sender, receiver) = mpsc::channel(1);
            (Some(sender), Some(receiver))
        }
    };
    let completion_id = request_id.clone();
    let panic_outbound = outbound.clone();
    let request_shutdown = session_shutdown.clone();
    let task = tokio::spawn(async move {
        let _admission = admission;
        let execution = AssertUnwindSafe(async move {
            match method {
                RpcMethod::Unary(handler) => {
                    run_unary(
                        request,
                        handler,
                        context,
                        request_cancellation,
                        request_shutdown.clone(),
                        outbound,
                    )
                    .await;
                }
                RpcMethod::Stream(handler) => {
                    let Some(acknowledgement_receiver) = acknowledgement_receiver else {
                        return;
                    };
                    run_stream(
                        request,
                        handler,
                        context,
                        request_cancellation,
                        request_shutdown.clone(),
                        acknowledgement_receiver,
                        outbound,
                    )
                    .await;
                }
                RpcMethod::LatestStream(handler) => {
                    let Some(acknowledgement_receiver) = acknowledgement_receiver else {
                        return;
                    };
                    run_latest_stream(
                        request,
                        handler,
                        context,
                        request_cancellation,
                        request_shutdown.clone(),
                        acknowledgement_receiver,
                        outbound,
                    )
                    .await;
                }
            }
        })
        .catch_unwind()
        .await;
        if let Err(payload) = execution {
            let _ = send_server_message(
                &panic_outbound,
                &session_shutdown,
                ServerMessage::connection_defect(panic_payload_message(payload.as_ref())),
            )
            .await;
        }
        let _ = completed.send(completion_id).await;
    });
    in_flight.insert(
        request_id,
        InFlight {
            cancellation,
            acknowledgements,
            task,
        },
    );
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "RPC handler panicked with a non-string payload".to_owned()
}

async fn run_unary(
    request: RpcRequest,
    handler: UnaryHandler,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    session_shutdown: CancellationToken,
    outbound: RpcOutboundQueue,
) {
    let request_id = request.id.clone();
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            let _ = try_send_control_message(
                &outbound,
                ServerMessage::interrupt(request_id),
            );
            return;
        }
        result = handler(request, context, cancellation.clone()) => result,
    };
    let RpcUnaryResult {
        result,
        enqueue_guard,
    } = result;
    let response = match result {
        Ok(value) => ServerMessage::success(request_id.clone(), Some(value)),
        Err(error) => ServerMessage::failure(request_id.clone(), error),
    };
    if let Some(enqueue_guard) = enqueue_guard {
        let encoded_len_bound = if outbound.budget.is_some() {
            let Ok(encoded_len_bound) = enqueue_guard.encoded_len_bound(&response) else {
                return;
            };
            encoded_len_bound
        } else {
            0
        };
        match reserve_server_message(&outbound, &session_shutdown, encoded_len_bound).await {
            Ok(permit) => enqueue_guard.enqueue(permit, response),
            Err(()) => {
                let _ = send_unbudgeted_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::failure(request_id, outbound_admission_failure()),
                )
                .await;
            }
        }
    } else if send_server_message(&outbound, &session_shutdown, response)
        .await
        .is_err()
    {
        let _ = send_unbudgeted_server_message(
            &outbound,
            &session_shutdown,
            ServerMessage::failure(request_id, outbound_admission_failure()),
        )
        .await;
    }
}

async fn run_stream(
    request: RpcRequest,
    handler: StreamHandler,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    session_shutdown: CancellationToken,
    mut acknowledgements: mpsc::Receiver<()>,
    outbound: RpcOutboundQueue,
) {
    let request_id = request.id.clone();
    let mut stream = handler(request, context, cancellation.clone());
    loop {
        let item = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = try_send_control_message(
                    &outbound,
                    ServerMessage::interrupt(request_id),
                );
                return;
            }
            item = stream.recv() => item,
        };
        let Some(item) = item else {
            send_stream_terminal(
                &outbound,
                &session_shutdown,
                ServerMessage::success(request_id.clone(), None),
                request_id,
            )
            .await;
            return;
        };
        match item {
            Err(error) => {
                send_stream_terminal(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::failure(request_id.clone(), error),
                    request_id,
                )
                .await;
                return;
            }
            Ok(values) => {
                if values.is_empty() {
                    let _ = send_server_message(
                        &outbound,
                        &session_shutdown,
                        ServerMessage::connection_defect("RPC stream produced an empty Chunk"),
                    )
                    .await;
                    return;
                }
                if send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::Chunk {
                        request_id: request_id.clone(),
                        values,
                    },
                )
                .await
                .is_err()
                {
                    // The chunk lost its outbound admission deadline. Ending the
                    // subscription silently would strand the client, so deliver
                    // an explicit terminal through the unbudgeted control lane.
                    let _ = send_unbudgeted_server_message(
                        &outbound,
                        &session_shutdown,
                        ServerMessage::failure(request_id, outbound_admission_failure()),
                    )
                    .await;
                    return;
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        let _ = try_send_control_message(
                            &outbound,
                            ServerMessage::interrupt(request_id),
                        );
                        return;
                    }
                    acknowledgement = acknowledgements.recv() => {
                        if acknowledgement.is_none() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn run_latest_stream(
    request: RpcRequest,
    handler: LatestStreamHandler,
    context: RpcSessionContext,
    cancellation: CancellationToken,
    session_shutdown: CancellationToken,
    mut acknowledgements: mpsc::Receiver<()>,
    outbound: RpcOutboundQueue,
) {
    let request_id = request.id.clone();
    let mut stream = handler(request, context, cancellation.clone());
    loop {
        let item = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = try_send_control_message(&outbound, ServerMessage::interrupt(request_id));
                return;
            }
            changed = stream.changed() => {
                if changed.is_err() {
                    send_latest_stream_terminal(
                        &outbound,
                        &session_shutdown,
                        &cancellation,
                        ServerMessage::success(request_id.clone(), None),
                        request_id,
                    ).await;
                    return;
                }
                stream.borrow_and_update().clone()
            }
        };
        let Some(item) = item else {
            continue;
        };
        match item {
            Err(error) => {
                send_latest_stream_terminal(
                    &outbound,
                    &session_shutdown,
                    &cancellation,
                    ServerMessage::failure(request_id.clone(), error),
                    request_id,
                )
                .await;
                return;
            }
            Ok(values) => {
                if values.is_empty() {
                    let _ = send_latest_stream_message(
                        &outbound,
                        &session_shutdown,
                        &cancellation,
                        ServerMessage::connection_defect("RPC stream produced an empty Chunk"),
                    )
                    .await;
                    return;
                }
                if send_latest_stream_message(
                    &outbound,
                    &session_shutdown,
                    &cancellation,
                    ServerMessage::Chunk {
                        request_id: request_id.clone(),
                        values,
                    },
                )
                .await
                .is_err()
                {
                    if cancellation.is_cancelled() {
                        let _ = try_send_control_message(
                            &outbound,
                            ServerMessage::interrupt(request_id),
                        );
                    } else {
                        let _ = send_unbudgeted_server_message(
                            &outbound,
                            &session_shutdown,
                            ServerMessage::failure(request_id, outbound_admission_failure()),
                        )
                        .await;
                    }
                    return;
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        let _ = try_send_control_message(
                            &outbound,
                            ServerMessage::interrupt(request_id),
                        );
                        return;
                    }
                    acknowledgement = acknowledgements.recv() => {
                        if acknowledgement.is_none() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

async fn send_latest_stream_terminal(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    cancellation: &CancellationToken,
    primary: ServerMessage,
    request_id: RequestId,
) {
    if send_latest_stream_message(outbound, session_shutdown, cancellation, primary)
        .await
        .is_err()
    {
        if cancellation.is_cancelled() {
            let _ = try_send_control_message(outbound, ServerMessage::interrupt(request_id));
        } else {
            let _ = send_unbudgeted_server_message(
                outbound,
                session_shutdown,
                ServerMessage::failure(request_id, outbound_admission_failure()),
            )
            .await;
        }
    }
}

async fn send_latest_stream_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    cancellation: &CancellationToken,
    message: ServerMessage,
) -> Result<(), ()> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(()),
        result = send_server_message(outbound, session_shutdown, message) => result,
    }
}

async fn send_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    message: ServerMessage,
) -> Result<(), ()> {
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let frame = if outbound.budget.is_some() {
        // Encode exactly once and drop the value tree before the admission
        // wait, so the memory resident while waiting is precisely the bytes
        // that will be charged.
        let encoded = serde_json::to_string(&message).map_err(|_| ())?;
        drop(message);
        let budget = outbound
            .acquire_budget(session_shutdown, encoded.len(), deadline)
            .await?;
        RpcOutboundFrame {
            payload: RpcOutboundPayload::Encoded(Message::Text(encoded.into())),
            _budget: budget,
        }
    } else {
        RpcOutboundFrame {
            payload: RpcOutboundPayload::Plain(message),
            _budget: None,
        }
    };
    tokio::select! {
        () = session_shutdown.cancelled() => Err(()),
        result = timeout_at(deadline, outbound.sender.send(frame)) => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    }
}

/// Sends a stream terminal, falling back to an explicit unbudgeted admission
/// failure when the budgeted send cannot be admitted — a subscription must
/// never end silently.
async fn send_stream_terminal(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    primary: ServerMessage,
    request_id: RequestId,
) {
    if send_server_message(outbound, session_shutdown, primary)
        .await
        .is_err()
    {
        let _ = send_unbudgeted_server_message(
            outbound,
            session_shutdown,
            ServerMessage::failure(request_id, outbound_admission_failure()),
        )
        .await;
    }
}

/// Delivers an interrupt without byte budgeting and without waiting: control
/// messages are bounded (at most one per in-flight request) and must not be
/// refused because data traffic has admission waiters queued.
fn try_send_control_message(outbound: &RpcOutboundQueue, message: ServerMessage) -> Result<(), ()> {
    let payload = if outbound.budget.is_some() {
        let encoded = serde_json::to_string(&message).map_err(|_| ())?;
        RpcOutboundPayload::Encoded(Message::Text(encoded.into()))
    } else {
        RpcOutboundPayload::Plain(message)
    };
    outbound
        .sender
        .try_send(RpcOutboundFrame {
            payload,
            _budget: None,
        })
        .map_err(|_| ())
}

/// Sends a bounded terminal message that bypasses the byte budget but still
/// waits for outbound queue capacity under the shared deadline. Used only when
/// the budgeted path already failed, so the client still observes a terminal.
async fn send_unbudgeted_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    message: ServerMessage,
) -> Result<(), ()> {
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let payload = if outbound.budget.is_some() {
        let encoded = serde_json::to_string(&message).map_err(|_| ())?;
        RpcOutboundPayload::Encoded(Message::Text(encoded.into()))
    } else {
        RpcOutboundPayload::Plain(message)
    };
    let frame = RpcOutboundFrame {
        payload,
        _budget: None,
    };
    tokio::select! {
        () = session_shutdown.cancelled() => Err(()),
        result = timeout_at(deadline, outbound.sender.send(frame)) => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    }
}

fn outbound_admission_failure() -> Value {
    json!({
        "_tag": "RpcOutboundAdmissionError",
        "message": "The response could not be admitted to the outbound byte \
                    budget before its deadline.",
    })
}

async fn reserve_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    encoded_len_bound: usize,
) -> Result<RpcResponseEnqueuePermit, ()> {
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let budget = outbound
        .acquire_budget(session_shutdown, encoded_len_bound, deadline)
        .await?;
    tokio::select! {
        () = session_shutdown.cancelled() => Err(()),
        result = timeout_at(deadline, outbound.sender.clone().reserve_owned()) => {
            match result {
                Ok(Ok(permit)) => Ok(RpcResponseEnqueuePermit {
                    permit,
                    budget,
                    encoded_len_bound,
                }),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    }
}

struct JsonLength(usize);

impl io::Write for JsonLength {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::FileTooLarge,
                "serialized RPC response is too large",
            )
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn encoded_server_message_len(
    message: &ServerMessage,
) -> Result<usize, serde_json::Error> {
    let mut length = JsonLength(0);
    serde_json::to_writer(&mut length, message)?;
    Ok(length.0)
}

fn decode_client_messages(bytes: &[u8]) -> Result<Vec<ClientMessage>, serde_json::Error> {
    let value: Value = serde_json::from_slice(bytes)?;
    match value {
        Value::Array(messages) => messages.into_iter().map(serde_json::from_value).collect(),
        message => serde_json::from_value(message).map(|message| vec![message]),
    }
}

fn client_protocol_error(message: String) -> ServerMessage {
    ServerMessage::ClientProtocolError {
        error: json!({
            "_tag": "RpcClientError",
            "reason": {
                "_tag": "RpcClientDefect",
                "message": message,
                "cause": message,
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::byte_budget::RpcOutboundProcessBudget;
    use futures_util::stream;
    use std::{
        convert::Infallible,
        pin::Pin,
        task::{Context, Poll},
    };

    #[test]
    fn pending_pairing_capability_is_limited_to_confirmation() {
        let context = RpcSessionContext {
            pairing_confirmation: Some(PairingConfirmationLatch::default()),
            ..RpcSessionContext::default()
        };

        assert!(context.has_pending_pairing_capability_for("auth.confirmPairing"));
        assert!(!context.has_pending_pairing_capability_for("auth.rotateCredential"));
        assert!(
            !RpcSessionContext::default().has_pending_pairing_capability_for("auth.confirmPairing")
        );
    }

    #[derive(Default)]
    struct BlockedSocketSink {
        pending: Option<RpcOutboundFrame>,
    }

    impl Sink<RpcOutboundFrame> for BlockedSocketSink {
        type Error = Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, item: RpcOutboundFrame) -> Result<(), Self::Error> {
            assert!(
                self.pending.is_none(),
                "blocked sink owns one pending frame"
            );
            self.pending = Some(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn poll_close(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            self.pending = None;
            Poll::Ready(Ok(()))
        }
    }

    struct EnqueueNotification(mpsc::UnboundedSender<RequestId>);

    impl RpcResponseEnqueueGuard for EnqueueNotification {
        fn enqueue(self: Box<Self>, permit: RpcResponseEnqueuePermit, response: ServerMessage) {
            let request_id = response
                .request_id()
                .cloned()
                .expect("test response request id");
            let prepared = permit.prepare(response).expect("prepare test response");
            permit.send_prepared(prepared);
            let _ = self.0.send(request_id);
        }
    }

    struct InboundDropNotification(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for InboundDropNotification {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    fn request_frame(ids: &[&str], tag: &str) -> RpcInboundFrame {
        RpcInboundFrame::plain(Message::Text(
            serde_json::to_string(
                &ids.iter()
                    .map(|id| {
                        json!({
                            "_tag": "Request",
                            "id": id,
                            "tag": tag,
                            "payload": {},
                            "headers": []
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .expect("request JSON")
            .into(),
        ))
    }

    fn unbudgeted_outbound(
        capacity: usize,
    ) -> (RpcOutboundQueue, mpsc::Receiver<RpcOutboundFrame>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (
            RpcOutboundQueue {
                sender,
                budget: None,
            },
            receiver,
        )
    }

    #[tokio::test]
    async fn session_shutdown_unblocks_a_full_outbound_queue() {
        let (outbound, _receiver) = unbudgeted_outbound(1);
        outbound.try_send(ServerMessage::Pong).expect("fill queue");
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        timeout(
            Duration::from_millis(100),
            send_server_message(&outbound, &shutdown, ServerMessage::Pong),
        )
        .await
        .expect("send observes cancellation")
        .expect_err("cancelled session rejects outbound messages");
    }

    #[tokio::test]
    async fn inbound_guard_is_released_after_dispatch_not_handler_completion() {
        let (handler_started_tx, handler_started_rx) = tokio::sync::oneshot::channel();
        let handler_started_tx = Arc::new(std::sync::Mutex::new(Some(handler_started_tx)));
        let mut registry = RpcRegistry::empty();
        registry.register_unary("test.pending", move |_request, _cancellation| {
            let handler_started_tx = Arc::clone(&handler_started_tx);
            async move {
                if let Some(sender) = handler_started_tx
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    let _ = sender.send(());
                }
                std::future::pending::<RpcResult>().await
            }
        });
        let (guard_dropped_tx, guard_dropped_rx) = tokio::sync::oneshot::channel();
        let plain = request_frame(&["1"], "test.pending");
        let guarded = RpcInboundFrame::guarded(
            plain.message,
            InboundDropNotification(Some(guard_dropped_tx)),
        );
        let (inbound_tx, inbound_rx) = mpsc::channel(1);
        let reader = stream::unfold(inbound_rx, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            BlockedSocketSink::default(),
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            None,
        ));

        inbound_tx.send(guarded).await.expect("guarded request");
        timeout(Duration::from_secs(1), handler_started_rx)
            .await
            .expect("handler dispatches")
            .expect("handler start signal");
        timeout(Duration::from_secs(1), guard_dropped_rx)
            .await
            .expect("input budget releases after dispatch")
            .expect("guard drop signal");

        shutdown.cancel();
        drop(inbound_tx);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("session cleanup deadline")
            .expect("session joins");
    }

    #[tokio::test]
    async fn latest_stream_request_cancellation_unblocks_a_full_outbound_queue() {
        let handler: LatestStreamHandler = Arc::new(|_request, _context, _cancellation| {
            let (sender, receiver) = watch::channel(None);
            sender.send_replace(Some(Ok(vec![json!({ "generation": 1 })])));
            receiver
        });
        let request = RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: "subscribeWorktreeCatalog".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let (outbound, _outbound_receiver) = unbudgeted_outbound(1);
        outbound.try_send(ServerMessage::Pong).expect("fill queue");
        let (_acknowledgements, acknowledgement_receiver) = mpsc::channel(1);
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(run_latest_stream(
            request,
            handler,
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
            CancellationToken::new(),
            acknowledgement_receiver,
            outbound,
        ));
        tokio::task::yield_now().await;
        cancellation.cancel();

        timeout(Duration::from_millis(100), task)
            .await
            .expect("request cancellation unblocks the outbound capacity wait")
            .expect("latest stream task joins");
    }

    #[tokio::test(start_paused = true)]
    async fn stream_admission_expiry_delivers_a_terminal_failure() {
        let process = RpcOutboundProcessBudget::new(1024);
        let _blocker = process.try_acquire(1024).expect("hold process capacity");
        let (sender, mut receiver) = mpsc::channel(8);
        let outbound = RpcOutboundQueue {
            sender,
            budget: Some(RpcOutboundBudget::new(process.clone(), 1024)),
        };
        let (chunk_sender, chunk_receiver) = mpsc::channel(1);
        chunk_sender
            .try_send(Ok(vec![json!({ "payload": "x".repeat(128) })]))
            .expect("queue stream chunk");
        let chunk_receiver = Arc::new(std::sync::Mutex::new(Some(chunk_receiver)));
        let handler: StreamHandler = Arc::new(move |_request, _context, _cancellation| {
            chunk_receiver
                .lock()
                .expect("stream receiver lock")
                .take()
                .expect("single stream invocation")
        });
        let request = RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: "test.stream".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let (_ack_sender, ack_receiver) = mpsc::channel(1);
        let task = tokio::spawn(run_stream(
            request,
            handler,
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
            CancellationToken::new(),
            ack_receiver,
            outbound,
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(6)).await;

        let frame = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("a terminal reaches the outbound queue")
            .expect("terminal frame");
        let (message, budget) = frame.into_wire().expect("encoded terminal").into_parts();
        assert!(budget.is_none(), "the terminal bypasses the byte budget");
        let Message::Text(text) = message else {
            panic!("expected a text terminal frame");
        };
        assert!(
            text.contains("RpcOutboundAdmissionError"),
            "admission expiry must surface as an explicit stream failure: {text}"
        );
        let decoded: Value = serde_json::from_str(&text).expect("terminal JSON");
        assert_eq!(decoded["requestId"], "1");
        drop(chunk_sender);
        timeout(Duration::from_secs(1), task)
            .await
            .expect("stream task ends after the terminal")
            .expect("stream task joins");
    }

    #[tokio::test]
    async fn latest_stream_cancellation_delivers_an_interrupt_past_queued_budget_waiters() {
        let process = RpcOutboundProcessBudget::new(64);
        let _blocker = process.try_acquire(64).expect("hold process capacity");
        let (sender, mut receiver) = mpsc::channel(8);
        let outbound = RpcOutboundQueue {
            sender,
            budget: Some(RpcOutboundBudget::new(process.clone(), 64)),
        };
        let waiter_outbound = outbound.clone();
        let waiter_shutdown = CancellationToken::new();
        let waiter = tokio::spawn(async move {
            let _ =
                send_server_message(&waiter_outbound, &waiter_shutdown, ServerMessage::Pong).await;
        });
        tokio::task::yield_now().await;

        let keep_streams = Arc::new(std::sync::Mutex::new(Vec::new()));
        let handler_streams = Arc::clone(&keep_streams);
        let handler: LatestStreamHandler = Arc::new(move |_request, _context, _cancellation| {
            let (stream_sender, stream_receiver) = watch::channel(None);
            handler_streams
                .lock()
                .expect("stream keep-alive lock")
                .push(stream_sender);
            stream_receiver
        });
        let request = RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: "test.latest".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let (_ack_sender, ack_receiver) = mpsc::channel(1);
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(run_latest_stream(
            request,
            handler,
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
            CancellationToken::new(),
            ack_receiver,
            outbound,
        ));
        tokio::task::yield_now().await;
        cancellation.cancel();

        let frame = timeout(Duration::from_millis(500), receiver.recv())
            .await
            .expect("the interrupt is delivered despite queued budget waiters")
            .expect("interrupt frame");
        let (message, budget) = frame.into_wire().expect("encoded interrupt").into_parts();
        assert!(budget.is_none(), "interrupts bypass the byte budget");
        let Message::Text(text) = message else {
            panic!("expected a text interrupt frame");
        };
        assert!(
            text.contains("Interrupt"),
            "cancellation must surface as an interrupt exit: {text}"
        );
        timeout(Duration::from_secs(1), task)
            .await
            .expect("latest stream task ends after the interrupt")
            .expect("latest stream task joins");
        waiter.abort();
        let _ = waiter.await;
    }

    #[tokio::test]
    async fn session_teardown_is_bounded_when_a_handler_ignores_cancellation() {
        let mut registry = RpcRegistry::empty();
        registry.register_unary("test.hang", |_request, _cancellation| async {
            std::future::pending::<RpcResult>().await
        });
        let (inbound_sender, inbound_receiver) = mpsc::channel(1);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            BlockedSocketSink::default(),
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            None,
        ));
        inbound_sender
            .send(request_frame(&["1"], "test.hang"))
            .await
            .expect("send hanging request");
        tokio::task::yield_now().await;
        drop(inbound_sender);

        timeout(Duration::from_secs(3), session)
            .await
            .expect("teardown bounds in-flight joins and aborts stragglers")
            .expect("session task joins");
    }

    #[tokio::test]
    async fn slow_socket_cannot_hide_more_than_one_large_response_in_the_session_queue() {
        let response = Arc::new("x".repeat(40 * 1024 * 1024));
        let (enqueued, mut enqueue_events) = mpsc::unbounded_channel();
        let mut registry = RpcRegistry::empty();
        registry.register_guarded_unary("test.largeResponse", move |_request, _cancellation| {
            let response = Arc::clone(&response);
            let enqueued = enqueued.clone();
            async move {
                RpcUnaryResult::guarded(
                    Ok(json!({ "value": response.as_str() })),
                    EnqueueNotification(enqueued),
                )
            }
        });
        let (inbound_sender, inbound_receiver) = mpsc::channel(1);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            BlockedSocketSink::default(),
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            Some(RpcOutboundBudget::new(
                RpcOutboundProcessBudget::new(128 * 1024 * 1024),
                64 * 1024 * 1024,
            )),
        ));
        inbound_sender
            .send(request_frame(&["1", "2"], "test.largeResponse"))
            .await
            .expect("send two large requests");

        timeout(Duration::from_secs(1), enqueue_events.recv())
            .await
            .expect("first response is enqueued")
            .expect("first enqueue notification");
        assert!(
            timeout(Duration::from_millis(100), enqueue_events.recv())
                .await
                .is_err(),
            "the connection byte budget must stop the second response before enqueue"
        );

        shutdown.cancel();
        drop(inbound_sender);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("session cleanup deadline")
            .expect("session task joins");
    }

    #[tokio::test]
    async fn slow_sockets_share_one_process_outbound_plaintext_budget() {
        let process_budget = RpcOutboundProcessBudget::new(128 * 1024 * 1024);
        let response = Arc::new("x".repeat(48 * 1024 * 1024));
        let (enqueued, mut enqueue_events) = mpsc::unbounded_channel();
        let mut sessions = HashMap::new();

        for request_id in ["1", "2", "3"] {
            let mut registry = RpcRegistry::empty();
            let response = Arc::clone(&response);
            let enqueued = enqueued.clone();
            registry.register_guarded_unary(
                "test.largeResponse",
                move |_request, _cancellation| {
                    let response = Arc::clone(&response);
                    let enqueued = enqueued.clone();
                    async move {
                        RpcUnaryResult::guarded(
                            Ok(json!({ "value": response.as_str() })),
                            EnqueueNotification(enqueued),
                        )
                    }
                },
            );
            let (inbound_sender, inbound_receiver) = mpsc::channel(1);
            let reader = stream::unfold(inbound_receiver, |mut receiver| async {
                receiver.recv().await.map(|item| (Ok(item), receiver))
            });
            let shutdown = CancellationToken::new();
            let task = tokio::spawn(run_session_split_budgeted(
                BlockedSocketSink::default(),
                reader,
                registry,
                RpcSessionContext::unauthenticated(),
                shutdown.clone(),
                Some(RpcOutboundBudget::new(
                    process_budget.clone(),
                    64 * 1024 * 1024,
                )),
            ));
            inbound_sender
                .send(request_frame(&[request_id], "test.largeResponse"))
                .await
                .expect("send large request");
            sessions.insert(request_id.to_owned(), (shutdown, inbound_sender, task));
        }

        let first = timeout(Duration::from_secs(2), enqueue_events.recv())
            .await
            .expect("first process-budgeted response")
            .expect("first enqueue event");
        let second = timeout(Duration::from_secs(2), enqueue_events.recv())
            .await
            .expect("second process-budgeted response")
            .expect("second enqueue event");
        assert_ne!(first, second);
        assert!(
            timeout(Duration::from_millis(100), enqueue_events.recv())
                .await
                .is_err(),
            "the process byte budget must stop the third slow-reader response before enqueue"
        );

        let first_id = first.as_str().to_owned();
        let (shutdown, inbound, task) = sessions.remove(&first_id).expect("first session owner");
        shutdown.cancel();
        drop(inbound);
        timeout(Duration::from_secs(2), task)
            .await
            .expect("cancelled session cleanup deadline")
            .expect("cancelled session joins");
        let third = timeout(Duration::from_secs(2), enqueue_events.recv())
            .await
            .expect("released process bytes admit the third response")
            .expect("third enqueue event");
        assert_ne!(third, first);
        assert_ne!(third, second);

        for (_, (shutdown, inbound, task)) in sessions {
            shutdown.cancel();
            drop(inbound);
            timeout(Duration::from_secs(2), task)
                .await
                .expect("session cleanup deadline")
                .expect("session joins");
        }
    }

    #[tokio::test]
    async fn response_larger_than_the_connection_budget_fails_the_session_closed() {
        let response = Arc::new("x".repeat(2 * 1024));
        let (enqueued, mut enqueue_events) = mpsc::unbounded_channel();
        let mut registry = RpcRegistry::empty();
        registry.register_guarded_unary(
            "test.oversizedResponse",
            move |_request, _cancellation| {
                let response = Arc::clone(&response);
                let enqueued = enqueued.clone();
                async move {
                    RpcUnaryResult::guarded(
                        Ok(json!({ "value": response.as_str() })),
                        EnqueueNotification(enqueued),
                    )
                }
            },
        );
        let (inbound_sender, inbound_receiver) = mpsc::channel(1);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            BlockedSocketSink::default(),
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            Some(RpcOutboundBudget::new(
                RpcOutboundProcessBudget::new(4 * 1024),
                1024,
            )),
        ));
        inbound_sender
            .send(request_frame(&["1"], "test.oversizedResponse"))
            .await
            .expect("send oversized response request");

        timeout(Duration::from_secs(1), shutdown.cancelled())
            .await
            .expect("impossible outbound admission closes the session");
        assert!(enqueue_events.try_recv().is_err());
        drop(inbound_sender);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("oversized response cleanup deadline")
            .expect("session joins");
    }

    #[tokio::test(start_paused = true)]
    async fn byte_and_queue_admission_share_one_five_second_deadline() {
        let process = RpcOutboundProcessBudget::new(1024);
        let process_blocker = process.try_acquire(1024).expect("hold process capacity");
        let (sender, _receiver) = mpsc::channel(1);
        sender
            .try_send(RpcOutboundFrame {
                payload: RpcOutboundPayload::Plain(ServerMessage::Pong),
                _budget: None,
            })
            .expect("fill response queue");
        let outbound = RpcOutboundQueue {
            sender,
            budget: Some(RpcOutboundBudget::new(process.clone(), 1024)),
        };
        let shutdown = CancellationToken::new();
        let send = tokio::spawn(async move {
            send_server_message(&outbound, &shutdown, ServerMessage::Pong).await
        });

        tokio::time::advance(Duration::from_secs(4)).await;
        drop(process_blocker);
        tokio::task::yield_now().await;
        assert!(
            !send.is_finished(),
            "queue admission still owns the final second"
        );
        tokio::time::advance(Duration::from_millis(999)).await;
        tokio::task::yield_now().await;
        assert!(!send.is_finished(), "the shared deadline has not elapsed");
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(send.await.expect("send task joins"), Err(()));
    }

    #[tokio::test]
    async fn unary_rpc_failures_are_persisted_for_restart_diagnostics() {
        let directory = tempfile::tempdir().expect("temporary diagnostics directory");
        let trace_path = directory.path().join("server.trace.ndjson");
        let diagnostics = TraceDiagnosticsStore::new(trace_path.clone());
        let mut registry = RpcRegistry::with_trace_diagnostics(diagnostics);
        registry.register_unary("git.createWorktree", |_request, _cancellation| async {
            Err(json!({
                "_tag": "GitCommandError",
                "detail": "fatal: bad config line 3 in .gitmodules"
            }))
        });
        let request = RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: "git.createWorktree".to_owned(),
            payload: json!({}),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        };
        let RpcMethod::Unary(handler) = registry.get("git.createWorktree").expect("handler") else {
            panic!("expected unary handler");
        };

        handler(
            request,
            RpcSessionContext::unauthenticated(),
            CancellationToken::new(),
        )
        .await
        .result
        .expect_err("fixture RPC fails");

        let after_restart = TraceDiagnosticsStore::new(trace_path).read();
        assert_eq!(after_restart["failureCount"], 1);
        assert_eq!(
            after_restart["latestFailures"][0]["cause"],
            "fatal: bad config line 3 in .gitmodules"
        );
    }
}
