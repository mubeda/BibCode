use std::{
    any::Any,
    collections::{HashMap, VecDeque},
    future::Future,
    io,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{FutureExt, Sink, SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use super::{
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

#[derive(Clone)]
pub(crate) struct RpcOutboundBudget {
    process: RpcOutboundProcessBudget,
    connection: Arc<WeightedByteBudget>,
    connection_capacity: usize,
}

impl RpcOutboundBudget {
    pub(crate) fn new(process: RpcOutboundProcessBudget, connection_capacity: usize) -> Self {
        Self {
            process,
            connection: Arc::new(WeightedByteBudget::new(connection_capacity)),
            connection_capacity,
        }
    }

    async fn acquire(&self, bytes: usize, deadline: Instant) -> Result<RpcOutboundBytePermit, ()> {
        let connection = Arc::clone(&self.connection)
            .acquire(bytes, deadline)
            .await
            .ok_or(())?;
        let process = self.process.acquire(bytes, deadline).await?;
        Ok(RpcOutboundBytePermit {
            process,
            connection,
        })
    }

    fn try_acquire(&self, bytes: usize) -> Result<RpcOutboundBytePermit, ()> {
        let connection = Arc::clone(&self.connection).try_acquire(bytes).ok_or(())?;
        let process = self.process.try_acquire(bytes)?;
        Ok(RpcOutboundBytePermit {
            process,
            connection,
        })
    }
}

#[derive(Clone)]
pub(crate) struct RpcOutboundProcessBudget {
    inner: Arc<WeightedByteBudget>,
}

pub(crate) struct WeightedByteBudget {
    capacity: usize,
    state: Mutex<WeightedByteBudgetState>,
}

struct WeightedByteBudgetState {
    available: usize,
    next_waiter_id: u64,
    waiters: VecDeque<WeightedByteWaiter>,
}

struct WeightedByteWaiter {
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
    sender: oneshot::Sender<()>,
}

pub(crate) struct WeightedByteGrant {
    inner: Arc<WeightedByteBudget>,
    bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WeightedByteAcquireError {
    Oversized,
    Cancelled,
    Deadline,
}

struct WeightedByteWaiterGuard {
    inner: Arc<WeightedByteBudget>,
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
    active: bool,
}

impl RpcOutboundProcessBudget {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(WeightedByteBudget::new(capacity)),
        }
    }

    async fn acquire(&self, bytes: usize, deadline: Instant) -> Result<WeightedByteGrant, ()> {
        Arc::clone(&self.inner)
            .acquire(bytes, deadline)
            .await
            .ok_or(())
    }

    fn try_acquire(&self, bytes: usize) -> Result<WeightedByteGrant, ()> {
        Arc::clone(&self.inner).try_acquire(bytes).ok_or(())
    }
}

impl WeightedByteBudget {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(WeightedByteBudgetState {
                available: capacity,
                next_waiter_id: 0,
                waiters: VecDeque::new(),
            }),
        }
    }

    pub(crate) async fn acquire(
        self: Arc<Self>,
        bytes: usize,
        deadline: Instant,
    ) -> Option<WeightedByteGrant> {
        let (receiver, mut guard) = Arc::clone(&self).enqueue(bytes).ok()?;
        timeout_at(deadline, receiver).await.ok()?.ok()?;
        guard.active = false;
        Some(WeightedByteGrant { inner: self, bytes })
    }

    pub(crate) async fn acquire_cancellable(
        self: Arc<Self>,
        bytes: usize,
        cancellation: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<WeightedByteGrant, WeightedByteAcquireError> {
        let (receiver, mut guard) = Arc::clone(&self).enqueue(bytes)?;
        match deadline {
            Some(deadline) => {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(WeightedByteAcquireError::Cancelled);
                    }
                    result = timeout_at(deadline, receiver) => {
                        result
                            .map_err(|_| WeightedByteAcquireError::Deadline)?
                            .map_err(|_| WeightedByteAcquireError::Cancelled)?;
                    }
                }
            }
            None => {
                tokio::select! {
                    () = cancellation.cancelled() => {
                        return Err(WeightedByteAcquireError::Cancelled);
                    }
                    result = receiver => {
                        result.map_err(|_| WeightedByteAcquireError::Cancelled)?;
                    }
                }
            }
        }
        guard.active = false;
        Ok(WeightedByteGrant { inner: self, bytes })
    }

    fn enqueue(
        self: Arc<Self>,
        bytes: usize,
    ) -> Result<(oneshot::Receiver<()>, WeightedByteWaiterGuard), WeightedByteAcquireError> {
        if bytes > self.capacity {
            return Err(WeightedByteAcquireError::Oversized);
        }
        let mut state = self.state.lock().expect("weighted byte budget lock");
        let id = state.next_waiter_id;
        state.next_waiter_id = state.next_waiter_id.wrapping_add(1);
        let (sender, receiver) = oneshot::channel();
        let granted = Arc::new(AtomicBool::new(false));
        state.waiters.push_back(WeightedByteWaiter {
            id,
            bytes,
            granted: Arc::clone(&granted),
            sender,
        });
        grant_weighted_byte_waiters(&mut state);
        drop(state);
        Ok((
            receiver,
            WeightedByteWaiterGuard {
                inner: self,
                id,
                bytes,
                granted,
                active: true,
            },
        ))
    }

    pub(crate) fn try_acquire(self: Arc<Self>, bytes: usize) -> Option<WeightedByteGrant> {
        if bytes > self.capacity {
            return None;
        }
        let mut state = self.state.lock().ok()?;
        if !state.waiters.is_empty() || state.available < bytes {
            return None;
        }
        state.available -= bytes;
        drop(state);
        Some(WeightedByteGrant { inner: self, bytes })
    }
}

impl WeightedByteGrant {
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    fn shrink_to(&mut self, bytes: usize) -> Result<(), ()> {
        if bytes > self.bytes {
            return Err(());
        }
        let released = self.bytes - bytes;
        self.bytes = bytes;
        release_weighted_bytes(Arc::clone(&self.inner), released);
        Ok(())
    }

    pub(crate) fn merge(&mut self, mut other: Self) -> Result<(), ()> {
        if !Arc::ptr_eq(&self.inner, &other.inner) {
            return Err(());
        }
        self.bytes = self.bytes.checked_add(other.bytes).ok_or(())?;
        other.bytes = 0;
        Ok(())
    }
}

impl Drop for WeightedByteGrant {
    fn drop(&mut self) {
        let bytes = std::mem::take(&mut self.bytes);
        release_weighted_bytes(Arc::clone(&self.inner), bytes);
    }
}

impl Drop for WeightedByteWaiterGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        cancel_weighted_byte_waiter(
            Arc::clone(&self.inner),
            self.id,
            self.bytes,
            Arc::clone(&self.granted),
        );
    }
}

fn grant_weighted_byte_waiters(state: &mut WeightedByteBudgetState) {
    loop {
        let Some(candidate) = state
            .waiters
            .iter()
            .position(|waiter| waiter.bytes <= state.available)
        else {
            return;
        };
        let waiter = state
            .waiters
            .remove(candidate)
            .expect("selected weighted waiter exists");
        state.available -= waiter.bytes;
        waiter.granted.store(true, Ordering::Release);
        if waiter.sender.send(()).is_err() {
            waiter.granted.store(false, Ordering::Release);
            state.available = state.available.saturating_add(waiter.bytes);
        }
    }
}

fn release_weighted_bytes(inner: Arc<WeightedByteBudget>, bytes: usize) {
    if bytes == 0 {
        return;
    }
    let mut state = inner.state.lock().expect("weighted byte budget lock");
    state.available = state.available.saturating_add(bytes).min(inner.capacity);
    grant_weighted_byte_waiters(&mut state);
}

fn cancel_weighted_byte_waiter(
    inner: Arc<WeightedByteBudget>,
    id: u64,
    bytes: usize,
    granted: Arc<AtomicBool>,
) {
    let mut state = inner.state.lock().expect("weighted byte budget lock");
    if let Some(index) = state.waiters.iter().position(|waiter| waiter.id == id) {
        state.waiters.remove(index);
    } else if granted.swap(false, Ordering::AcqRel) {
        state.available = state.available.saturating_add(bytes).min(inner.capacity);
    }
    grant_weighted_byte_waiters(&mut state);
}

pub(crate) struct RpcOutboundBytePermit {
    process: WeightedByteGrant,
    connection: WeightedByteGrant,
}

impl RpcOutboundBytePermit {
    fn shrink_to(&mut self, bytes: usize) -> Result<(), ()> {
        let current = self.process.bytes();
        if bytes > current || self.connection.bytes() != current {
            return Err(());
        }
        self.process.shrink_to(bytes)?;
        self.connection.shrink_to(bytes)?;
        Ok(())
    }
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

    fn try_send(&self, message: ServerMessage) -> Result<(), ()> {
        let (payload, budget) = if let Some(budget) = &self.budget {
            let bytes = encoded_server_message_len(&message).map_err(|_| ())?;
            let permit = budget.try_acquire(bytes)?;
            let encoded = serde_json::to_string(&message).map_err(|_| ())?;
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
    for (_, request) in in_flight {
        let _ = request.task.await;
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
                if let Some(auth) = dispatch.session.auth.as_ref() {
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
            let _ = send_server_message(
                &outbound,
                &session_shutdown,
                ServerMessage::interrupt(request_id),
            ).await;
            return;
        }
        result = handler(request, context, cancellation.clone()) => result,
    };
    let RpcUnaryResult {
        result,
        enqueue_guard,
    } = result;
    let response = match result {
        Ok(value) => ServerMessage::success(request_id, Some(value)),
        Err(error) => ServerMessage::failure(request_id, error),
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
        if let Ok(permit) =
            reserve_server_message(&outbound, &session_shutdown, encoded_len_bound).await
        {
            enqueue_guard.enqueue(permit, response);
        }
    } else {
        let _ = send_server_message(&outbound, &session_shutdown, response).await;
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
                let _ = send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::interrupt(request_id),
                ).await;
                return;
            }
            item = stream.recv() => item,
        };
        let Some(item) = item else {
            let _ = send_server_message(
                &outbound,
                &session_shutdown,
                ServerMessage::success(request_id, None),
            )
            .await;
            return;
        };
        match item {
            Err(error) => {
                let _ = send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::failure(request_id, error),
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
                    return;
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        let _ = send_server_message(
                            &outbound,
                            &session_shutdown,
                            ServerMessage::interrupt(request_id),
                        ).await;
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
                let _ = outbound.try_send(ServerMessage::interrupt(request_id));
                return;
            }
            changed = stream.changed() => {
                if changed.is_err() {
                    let _ = send_latest_stream_message(
                        &outbound,
                        &session_shutdown,
                        &cancellation,
                        ServerMessage::success(request_id, None),
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
                let _ = send_latest_stream_message(
                    &outbound,
                    &session_shutdown,
                    &cancellation,
                    ServerMessage::failure(request_id, error),
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
                    return;
                }
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        let _ = outbound.try_send(ServerMessage::interrupt(request_id));
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
        let bytes = encoded_server_message_len(&message).map_err(|_| ())?;
        let budget = outbound
            .acquire_budget(session_shutdown, bytes, deadline)
            .await?;
        let encoded = serde_json::to_string(&message).map_err(|_| ())?;
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
    use futures_util::stream;
    use std::{
        convert::Infallible,
        pin::Pin,
        task::{Context, Poll},
    };

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

    #[tokio::test(start_paused = true)]
    async fn outbound_process_budget_admits_a_large_waiter_after_sufficient_release() {
        let budget = RpcOutboundProcessBudget::new(10);
        let blocker = budget.try_acquire(8).expect("initial process bytes");
        let large_budget = budget.clone();
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;

        let small = budget
            .acquire(2, Instant::now() + Duration::from_secs(10))
            .await
            .expect("small fitting waiter bypasses the blocked large waiter");
        assert!(!large.is_finished());
        drop(small);
        drop(blocker);

        let large = large
            .await
            .expect("large waiter task")
            .expect("large waiter makes progress after release");
        assert_eq!(large.bytes(), 8);
    }

    #[tokio::test(start_paused = true)]
    async fn fit_first_budget_does_not_block_small_waiters_behind_an_aged_large_waiter() {
        let budget = RpcOutboundProcessBudget::new(10);
        let blocker = budget.try_acquire(8).expect("initial process bytes");
        let large_budget = budget.clone();
        let large = tokio::spawn(async move {
            large_budget
                .acquire(8, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;

        let small_budget = budget.clone();
        let small = tokio::spawn(async move {
            small_budget
                .acquire(2, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            small.is_finished(),
            "a fitting small waiter must not be blocked by an aged large waiter"
        );

        let small = small
            .await
            .expect("small waiter task")
            .expect("small waiter uses currently available capacity");
        assert_eq!(small.bytes(), 2);
        assert!(!large.is_finished());

        drop(small);
        drop(blocker);
        let large = large
            .await
            .expect("large waiter task")
            .expect("large waiter makes progress after sufficient release");
        assert_eq!(large.bytes(), 8);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_weighted_waiter_is_removed_and_capacity_is_refunded_once() {
        let budget = RpcOutboundProcessBudget::new(10);
        let blocker = budget.try_acquire(10).expect("initial process bytes");
        let waiting_budget = budget.clone();
        let waiting = tokio::spawn(async move {
            waiting_budget
                .acquire(10, Instant::now() + Duration::from_secs(10))
                .await
        });
        tokio::task::yield_now().await;
        waiting.abort();
        assert!(matches!(waiting.await, Err(error) if error.is_cancelled()));

        drop(blocker);
        let recovered = budget
            .try_acquire(10)
            .expect("cancelled waiter does not retain process bytes");
        assert_eq!(recovered.bytes(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn outbound_connection_wait_uses_the_same_absolute_deadline_as_process_wait() {
        let budget = RpcOutboundBudget::new(RpcOutboundProcessBudget::new(10), 1);
        let blocker = budget.try_acquire(1).expect("initial connection byte");
        let waiting_budget = budget.clone();
        let waiting = tokio::spawn(async move {
            waiting_budget
                .acquire(1, Instant::now() + Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;

        assert!(
            waiting.is_finished(),
            "connection-tier admission must observe the shared absolute deadline"
        );
        assert!(waiting.await.expect("connection waiter task").is_err());
        drop(blocker);
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
