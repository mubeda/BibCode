//! Agent mail for an AI Terminal. A message is stored in the terminal generation's mailbox, never
//! typed: the server types only [`POINTER_LINE`], once per period in which the terminal's agent
//! waits for a prompt and no person typed, and the agent then fetches its mail itself.

use std::{
    collections::{HashMap, HashSet},
    pin::Pin,
    sync::{Arc, Mutex as StdMutex, PoisonError},
    time::Duration,
};

use tokio::{
    sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::{
    AgentMessaging, AgentMessagingError, MessageOutcome,
    envelope::{EnvelopeInput, build_envelope},
    policy,
    store::{
        self, AgentMessageReason, AgentMessageRow, AgentMessageStatus, NewAgentMessage, SenderKind,
    },
    terminal_credential::{TerminalIdentity, parse_terminal_address},
};
use crate::{
    persistence::Database,
    terminal::{
        TerminalError, TerminalGeneration, TerminalManager, TerminalMetadataAttachment,
        TerminalSummary, WriteGuard, WriteWhenReady,
    },
};

/// How long one pointer write may take before the pointer gives it up. Only a terminal whose
/// program stopped reading input gets near it.
const POINTER_WRITE_LIMIT: Duration = Duration::from_secs(2);
/// How soon a terminal whose earlier input is still being written is tried again.
const BUSY_RETRY: Duration = Duration::from_millis(250);

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The terminal operations the pointer needs: the terminal manager, or a script in tests.
pub trait PointerTerminals: Send + Sync {
    fn write_when_ready<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
        generation: &'a TerminalGeneration,
        data: &'a str,
        still_wanted: WriteGuard,
    ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>>;
    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<TerminalGeneration>>;
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the hop ledger reads it for task 8.2's command")
    )]
    fn person_input_count<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<u64>>;
    fn thread_sessions<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Vec<TerminalSummary>>;
    fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment>;
}

impl PointerTerminals for TerminalManager {
    fn write_when_ready<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
        generation: &'a TerminalGeneration,
        data: &'a str,
        still_wanted: WriteGuard,
    ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>> {
        Box::pin(TerminalManager::write_when_ready(
            self,
            thread_id,
            terminal_id,
            generation,
            data,
            still_wanted,
        ))
    }

    fn live_generation<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<TerminalGeneration>> {
        Box::pin(TerminalManager::live_generation(
            self,
            thread_id,
            terminal_id,
        ))
    }

    fn person_input_count<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxFuture<'a, Option<u64>> {
        Box::pin(TerminalManager::person_input_count(
            self,
            thread_id,
            terminal_id,
        ))
    }

    fn thread_sessions<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Vec<TerminalSummary>> {
        Box::pin(TerminalManager::thread_sessions(self, thread_id))
    }

    fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment> {
        Box::pin(TerminalManager::subscribe_metadata(self))
    }
}

/// The only text the server ever types into a terminal (R17): it names no message, title or
/// sender.
pub const POINTER_LINE: &str =
    "BiBCode: you have new messages. Run `bibcode agent inbox` to read them.";
pub const POINTER_PASTE_OPEN: &str = "\u{1b}[200~";
pub const POINTER_PASTE_CLOSE: &str = "\u{1b}[201~";
pub const POINTER_SUBMIT: &str = "\r";

/// A terminal agent receives as `full-access` (R6).
pub(crate) const TERMINAL_RECIPIENT_MODE: &str = "full-access";

fn pointer_input() -> String {
    format!("{POINTER_PASTE_OPEN}{POINTER_LINE}{POINTER_PASTE_CLOSE}{POINTER_SUBMIT}")
}

fn generation_key(generation: &TerminalGeneration) -> String {
    format!("{}:{}", generation.boot, generation.process)
}

fn storage(
    context: &'static str,
) -> impl Fn(crate::persistence::PersistenceError) -> AgentMessagingError {
    move |error| {
        tracing::warn!(error = %error, "{context}");
        AgentMessagingError::Storage
    }
}

/// One message a terminal agent fetched: its id and the envelope it reads.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), expect(dead_code, reason = "task 8.2's command prints it"))]
pub struct InboxEntry {
    pub message_id: String,
    pub rendered: String,
}

/// Told `(thread id, terminal id, generation key)` once for every terminal generation that
/// ended with mail, read or not.
pub type GenerationEndSink = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

/// The hops one terminal generation fetched since a person last typed into it.
#[derive(Default)]
#[cfg_attr(not(test), expect(dead_code, reason = "task 8.2's command reads it"))]
struct HopLedger {
    inputs_seen: Option<u64>,
    highest: Option<u32>,
}

#[cfg_attr(not(test), expect(dead_code, reason = "task 8.2's command reads it"))]
impl HopLedger {
    /// Starts the chain again when the person input count changed since it was last seen.
    fn follow(&mut self, inputs: Option<u64>) {
        if self.inputs_seen != inputs {
            self.inputs_seen = inputs;
            self.highest = None;
        }
    }
}

/// `{address}#{generation key}`: one terminal process, for the hop ledger and the ended set.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "task 8.2's command reads the ledger")
)]
fn ledger_key(identity: &TerminalIdentity) -> String {
    format!("{}#{}", identity.address(), identity.generation_key())
}

/// Stores agent mail for AI Terminals and tells each terminal about it. Clones share one wake,
/// one hop ledger, one record of ended generations and the per-terminal exclusion.
#[derive(Clone)]
pub struct TerminalPointer {
    database: Database,
    terminals: Arc<dyn PointerTerminals>,
    wake: Arc<Notify>,
    // In memory: a terminal never outlives its server, and a restart ends every generation.
    hops: Arc<StdMutex<HashMap<String, HopLedger>>>,
    ended: Arc<StdMutex<HashSet<String>>>,
    generation_end: Option<GenerationEndSink>,
    /// One lock per terminal address: a pointer write, from the eligibility read until its mail
    /// is marked, excludes that terminal's inbox fetch, cancel and generation end.
    /// shortcut: entries are never removed, one per terminal that got mail in this server run;
    /// prune on generation end if terminals ever churn by the thousand.
    exclusions: Arc<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    /// The addresses with a pointer attempt running, and whether a pass skipped one meanwhile.
    in_flight: Arc<StdMutex<HashMap<String, bool>>>,
    /// The `{address}#{generation key}` ends a sweep started and that have not finished.
    ending: Arc<StdMutex<HashSet<String>>>,
}

impl TerminalPointer {
    pub fn new(database: Database, terminals: Arc<dyn PointerTerminals>) -> Self {
        Self {
            database,
            terminals,
            wake: Arc::new(Notify::new()),
            hops: Arc::default(),
            ended: Arc::default(),
            generation_end: None,
            exclusions: Arc::default(),
            in_flight: Arc::default(),
            ending: Arc::default(),
        }
    }

    /// Holds `address`'s exclusion: no pointer write, fetch, cancel or generation end of that
    /// terminal runs while it is held.
    pub(crate) async fn exclusive(&self, address: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .exclusions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(address.to_owned())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "task 9.3 supplies the generation-end sink")
    )]
    pub fn with_generation_end_sink(mut self, sink: GenerationEndSink) -> Self {
        self.generation_end = Some(sink);
        self
    }

    pub(crate) fn terminals(&self) -> &Arc<dyn PointerTerminals> {
        &self.terminals
    }

    /// Stores `new` in `recipient`'s mailbox: one row bound to its generation, with no turn
    /// queue entry. An agent's message obeys the mode ceiling (the terminal receives as
    /// `full-access`) and the rate and backlog limits, and is held while messaging is off; a
    /// person's request is exempt from all three.
    pub(crate) async fn accept(
        &self,
        messaging: &AgentMessaging,
        mut new: NewAgentMessage,
        recipient: &TerminalIdentity,
    ) -> Result<(), AgentMessagingError> {
        let agent = new.sender_kind == SenderKind::Agent;
        if agent {
            let sender_mode = new.sender_runtime_mode.clone().unwrap_or_default();
            if !policy::ceiling_allows(&sender_mode, TERMINAL_RECIPIENT_MODE) {
                return Err(AgentMessagingError::ModeCeiling {
                    sender: sender_mode,
                    recipient: TERMINAL_RECIPIENT_MODE.to_owned(),
                });
            }
        }
        new.recipient_address = recipient.address();
        new.recipient_terminal_generation = Some(recipient.generation_key());
        new.delivery_command_id = None;
        new.delivery_message_id = None;
        (new.status, new.reason) = if agent && !messaging.is_enabled() {
            (
                AgentMessageStatus::Held,
                Some(AgentMessageReason::MessagingOff),
            )
        } else {
            (AgentMessageStatus::Queued, None)
        };
        let limits = policy::AdmissionLimits::now();
        let refused = self
            .database
            .call(move |connection| {
                let tx = connection.transaction()?;
                if let Err(refusal) = policy::enforce_limits(&tx, &new, &limits)? {
                    return Ok(Some(refusal));
                }
                store::insert_message(&tx, &new)?;
                tx.commit()?;
                Ok(None)
            })
            .await
            .map_err(storage("a terminal's agent message was not stored"))?;
        match refused {
            Some(policy::LimitRefusal::Rate) => return Err(AgentMessagingError::RateLimit),
            Some(policy::LimitRefusal::Backlog) => return Err(AgentMessagingError::BacklogLimit),
            None => {}
        }
        // A generation that ended while the row was stored would leave it waiting for nobody.
        let live = self
            .terminals
            .live_generation(&recipient.thread_id, &recipient.terminal_id)
            .await;
        if live.as_ref() != Some(&recipient.generation) {
            self.end_generation(
                messaging,
                &recipient.thread_id,
                &recipient.terminal_id,
                &recipient.generation_key(),
            )
            .await;
        }
        self.wake.notify_one();
        Ok(())
    }

    /// Pastes the pointer into each terminal whose agent waits for a prompt while its live
    /// generation has `queued` mail, and marks that mail `delivered`; ends the generations no
    /// process holds any more; until `shutdown`. It rescans on every terminal metadata change,
    /// every new message and every change of the setting, so a lost event only delays it. It
    /// never pastes for a `held` row. Each terminal's write runs in its own bounded task, so a
    /// terminal that stopped reading input holds up no other terminal, sweep or shutdown.
    pub(crate) fn start(
        &self,
        messaging: AgentMessaging,
        shutdown: CancellationToken,
    ) -> JoinHandle<()> {
        let pointer = self.clone();
        tokio::spawn(async move {
            let mut metadata = pointer.terminals.subscribe_metadata().await;
            let mut enabled = messaging.enabled.clone();
            let (mut setting_open, mut metadata_open) = (true, true);
            pointer.follow_setting(&messaging, &shutdown).await;
            loop {
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = async {
                        pointer.sweep_ended(&messaging, &shutdown).await;
                        pointer.paste_waiting(&messaging, &shutdown).await;
                    } => {}
                }
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    changed = enabled.changed(), if setting_open => {
                        setting_open = changed.is_ok();
                        pointer.follow_setting(&messaging, &shutdown).await;
                    }
                    () = pointer.wake.notified() => {}
                    event = metadata.recv(), if metadata_open => metadata_open = event.is_some(),
                }
            }
        })
    }

    /// Holds or releases each terminal's agent mail for the setting's current value, under that
    /// terminal's exclusion, so a pointer write that read the mail as eligible finishes before
    /// its mail changes. Each terminal follows in its own task, which reads the setting once it
    /// holds the exclusion, so one terminal's stuck write delays no other terminal and a later
    /// value always wins.
    async fn follow_setting(&self, messaging: &AgentMessaging, shutdown: &CancellationToken) {
        let addresses = match self
            .database
            .call(|connection| super::delivery::list_terminals_following_setting(connection))
            .await
        {
            Ok(addresses) => addresses,
            Err(error) => {
                tracing::warn!(error = %error, "terminal agent messages did not follow the setting");
                return;
            }
        };
        for address in addresses {
            let (pointer, messaging, shutdown) =
                (self.clone(), messaging.clone(), shutdown.clone());
            tokio::spawn(async move {
                let _exclusive = tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    exclusive = pointer.exclusive(&address) => exclusive,
                };
                let enabled = messaging.is_enabled();
                if let Err(error) = pointer
                    .database
                    .call(move |connection| {
                        super::delivery::follow_setting_for_terminal(
                            connection,
                            &address,
                            enabled,
                            &crate::mcp::control::now_iso(),
                        )
                    })
                    .await
                {
                    tracing::warn!(error = %error, "terminal agent messages did not follow the setting");
                }
                pointer.wake.notify_one();
            });
        }
    }

    /// One pass of [`Self::start`]: starts a pointer attempt for each terminal with `queued` mail
    /// that has none running. A terminal skipped because one runs is tried again by that attempt.
    async fn paste_waiting(&self, messaging: &AgentMessaging, shutdown: &CancellationToken) {
        let enabled = messaging.is_enabled();
        let waiting = match self
            .database
            .call(move |connection| store::list_queued_terminal_mail(connection, enabled))
            .await
        {
            Ok(waiting) => waiting,
            Err(error) => {
                tracing::warn!(error = %error, "terminal mail could not be read");
                return;
            }
        };
        let mut addresses: Vec<String> = Vec::new();
        for row in waiting {
            if !addresses.contains(&row.recipient_address) {
                addresses.push(row.recipient_address);
            }
        }
        for address in addresses {
            {
                let mut in_flight = self
                    .in_flight
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if let Some(skipped) = in_flight.get_mut(&address) {
                    *skipped = true;
                    continue;
                }
                in_flight.insert(address.clone(), false);
            }
            let (pointer, messaging, shutdown) =
                (self.clone(), messaging.clone(), shutdown.clone());
            tokio::spawn(async move {
                loop {
                    let busy = tokio::select! {
                        biased;
                        () = shutdown.cancelled() => false,
                        busy = pointer.try_terminal(&messaging, &address) => busy,
                    };
                    if busy {
                        tokio::select! {
                            biased;
                            () = shutdown.cancelled() => {}
                            () = tokio::time::sleep(BUSY_RETRY) => continue,
                        }
                    }
                    let mut in_flight = pointer
                        .in_flight
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    // A pass skipped this terminal meanwhile, so something changed: try it again,
                    // and only it, so attempts on several terminals never wake each other.
                    if !shutdown.is_cancelled() && in_flight.get(&address) == Some(&true) {
                        in_flight.insert(address.clone(), false);
                        continue;
                    }
                    in_flight.remove(&address);
                    return;
                }
            });
        }
    }

    /// One pointer attempt for `address`: under its exclusion, rereads the mail its live
    /// generation can fetch, types the pointer only if the terminal grants the write permit at
    /// the moment of the write, and marks that mail `delivered` only then. True when earlier
    /// input was still pending, so the terminal is tried again soon.
    async fn try_terminal(&self, messaging: &AgentMessaging, address: &str) -> bool {
        let Some((thread_id, terminal_id)) = parse_terminal_address(address) else {
            return false;
        };
        let Some(generation) = self
            .terminals
            .live_generation(&thread_id, &terminal_id)
            .await
        else {
            return false;
        };
        let _exclusive = self.exclusive(address).await;
        let (lookup, key) = (address.to_owned(), generation_key(&generation));
        let enabled = messaging.is_enabled();
        let eligible = match self
            .database
            .call(move |connection| {
                store::eligible_terminal_mail(connection, &lookup, &key, enabled)
            })
            .await
        {
            Ok(eligible) => eligible,
            Err(error) => {
                tracing::warn!(error = %error, "terminal mail could not be read");
                return false;
            }
        };
        if eligible.is_empty() {
            return false;
        }
        // A person's request stays eligible while messaging is off; an agent's message does not.
        let person = eligible
            .iter()
            .any(|message| message.sender_kind == SenderKind::Person);
        let setting = messaging.enabled.clone();
        let still_wanted: WriteGuard = Box::new(move || person || *setting.borrow());
        let written = tokio::time::timeout(
            POINTER_WRITE_LIMIT,
            self.terminals.write_when_ready(
                &thread_id,
                &terminal_id,
                &generation,
                &pointer_input(),
                still_wanted,
            ),
        )
        .await;
        match written {
            Ok(Ok(WriteWhenReady::Written)) => {}
            Ok(Ok(WriteWhenReady::Busy)) => return true,
            Ok(Ok(WriteWhenReady::NotReady | WriteWhenReady::GenerationChanged)) => return false,
            Ok(Err(error)) => {
                tracing::debug!(error = %error, "the pointer was not typed");
                return false;
            }
            Err(_) => {
                tracing::warn!("a terminal did not take the pointer in time");
                return false;
            }
        }
        let ids: Vec<String> = eligible
            .into_iter()
            .map(|message| message.message_id)
            .collect();
        let now = crate::mcp::control::now_iso();
        match self
            .database
            .call(move |connection| store::deliver_queued(connection, &ids, &now))
            .await
        {
            Ok(delivered) => self.report(messaging, &delivered, "delivered", None).await,
            Err(error) => {
                tracing::warn!(error = %error, "terminal mail was not marked delivered")
            }
        }
        false
    }

    /// Ends each terminal generation with open mail that no process holds now, those of an
    /// earlier boot included. Each end runs in its own task, because it waits for its terminal's
    /// exclusion, which a stuck pointer write holds for up to [`POINTER_WRITE_LIMIT`].
    async fn sweep_ended(&self, messaging: &AgentMessaging, shutdown: &CancellationToken) {
        let generations = match self
            .database
            .call(|connection| store::list_open_terminal_generations(connection))
            .await
        {
            Ok(generations) => generations,
            Err(error) => {
                tracing::warn!(error = %error, "terminal mail could not be read");
                return;
            }
        };
        for (address, key) in generations {
            if self
                .ended
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&format!("{address}#{key}"))
            {
                continue;
            }
            let Some((thread_id, terminal_id)) = parse_terminal_address(&address) else {
                continue;
            };
            let live = self
                .terminals
                .live_generation(&thread_id, &terminal_id)
                .await;
            if live.as_ref().map(generation_key).as_deref() == Some(key.as_str()) {
                continue;
            }
            let ending = format!("{address}#{key}");
            if !self
                .ending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(ending.clone())
            {
                continue;
            }
            let (pointer, messaging, shutdown) =
                (self.clone(), messaging.clone(), shutdown.clone());
            tokio::spawn(async move {
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => {}
                    () = pointer.end_generation(&messaging, &thread_id, &terminal_id, &key) => {}
                }
                pointer
                    .ending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&ending);
            });
        }
    }

    /// Fails the unconsumed mail of an ended generation with `recipient_gone` and records the end
    /// on its consumed mail, in one transaction under the terminal's exclusion; forgets its hop
    /// ledger and tells the generation-end sink, once per generation across restarts.
    async fn end_generation(
        &self,
        messaging: &AgentMessaging,
        thread_id: &str,
        terminal_id: &str,
        generation_key: &str,
    ) {
        let address = format!("terminal:{thread_id}/{terminal_id}");
        let _exclusive = self.exclusive(&address).await;
        // The recorded end and the sink run in a task of their own, so a shutdown that drops this
        // future cannot fall between them; a crash there loses the call, never repeats it.
        let (pointer, thread, terminal, key) = (
            self.clone(),
            thread_id.to_owned(),
            terminal_id.to_owned(),
            generation_key.to_owned(),
        );
        let recorded = tokio::spawn(async move {
            let (lookup, lookup_key) = (format!("terminal:{thread}/{terminal}"), key.clone());
            let (failed, read) = match pointer
                .database
                .call(move |connection| {
                    let tx = connection.transaction()?;
                    let ids = store::fail_unconsumed_for_generation(&tx, &lookup, &lookup_key)?;
                    let read = store::end_consumed_for_generation(&tx, &lookup, &lookup_key)?;
                    let mut rows = Vec::with_capacity(ids.len());
                    for id in ids {
                        rows.extend(store::get_message(&tx, &id)?);
                    }
                    tx.commit()?;
                    Ok((rows, read))
                })
                .await
            {
                Ok(ended) => ended,
                Err(error) => {
                    tracing::warn!(error = %error, "an ended terminal's mail was not failed");
                    return Vec::new();
                }
            };
            let ended = format!("terminal:{thread}/{terminal}#{key}");
            pointer
                .hops
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&ended);
            let first = pointer
                .ended
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(ended);
            // A generation whose end an earlier run recorded changes no row: not told again.
            if first
                && (!failed.is_empty() || read > 0)
                && let Some(sink) = &pointer.generation_end
            {
                sink(&thread, &terminal, &key);
            }
            failed
        });
        let Ok(failed) = recorded.await else {
            return;
        };
        for message in &failed {
            tracing::warn!(
                message_id = %message.message_id,
                reason = AgentMessageReason::RecipientGone.as_str(),
                "an agent message failed"
            );
        }
        self.report(
            messaging,
            &failed,
            "failed",
            Some(AgentMessageReason::RecipientGone),
        )
        .await;
    }

    /// Tells the outcome sink, if any, of each message's `outcome`, with ids and titles only.
    pub(crate) async fn report(
        &self,
        messaging: &AgentMessaging,
        messages: &[AgentMessageRow],
        outcome: &str,
        reason: Option<AgentMessageReason>,
    ) {
        let Some(outcomes) = &messaging.outcomes else {
            return;
        };
        for message in messages {
            let title = |description: super::SenderDescription| {
                Some(description.title).filter(|title| !title.is_empty())
            };
            outcomes(MessageOutcome {
                sender_address: message.sender_address.clone(),
                recipient_address: message.recipient_address.clone(),
                tool: "agent_message_delivery",
                outcome: outcome.to_owned(),
                message_id: Some(message.message_id.clone()),
                conversation_id: Some(message.conversation_id.clone()),
                hop: Some(message.hop),
                reason: reason.map(|reason| reason.as_str().to_owned()),
                sender_title: title(messaging.sender_description(&message.sender_address).await),
                recipient_title: title(
                    messaging
                        .sender_description(&message.recipient_address)
                        .await,
                ),
            });
        }
    }
}

/// The terminal agent's side: its inbox and its hop chain.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "task 8.2's `bibcode agent` command calls these")
)]
impl TerminalPointer {
    /// The mail of `identity`'s own generation, oldest first, rendered as envelopes; each
    /// returned row is `consumed` in the fetch. `queued` and `delivered` rows only, and an
    /// agent's message only while messaging is on and its ceiling holds, so a `held` row is never
    /// returned. Records the highest hop fetched for [`Self::terminal_trigger_hop`].
    pub(crate) async fn inbox(
        &self,
        messaging: &AgentMessaging,
        identity: &TerminalIdentity,
    ) -> Result<Vec<InboxEntry>, AgentMessagingError> {
        let (address, key) = (identity.address(), identity.generation_key());
        // Under the terminal's exclusion, so a generation end, a pointer write or a cancel never
        // interleaves with this fetch; an ended generation fetches nothing.
        let _exclusive = self.exclusive(&address).await;
        let live = self
            .terminals
            .live_generation(&identity.thread_id, &identity.terminal_id)
            .await;
        if live.as_ref() != Some(&identity.generation) {
            return Ok(Vec::new());
        }
        let enabled = messaging.is_enabled();
        let consumed = self
            .database
            .call(move |connection| {
                store::consume_for_generation(
                    connection,
                    &address,
                    &key,
                    enabled,
                    &crate::mcp::control::now_iso(),
                )
            })
            .await
            .map_err(storage("a terminal's inbox could not be read"))?;
        let inputs = self
            .terminals
            .person_input_count(&identity.thread_id, &identity.terminal_id)
            .await;
        {
            let mut hops = self.hops.lock().unwrap_or_else(PoisonError::into_inner);
            let ledger = hops.entry(ledger_key(identity)).or_default();
            ledger.follow(inputs);
            for message in &consumed {
                if message.sender_kind == SenderKind::Agent {
                    ledger.highest = ledger.highest.max(Some(message.hop));
                }
            }
        }
        let mut entries = Vec::with_capacity(consumed.len());
        for message in &consumed {
            let sender = messaging.sender_description(&message.sender_address).await;
            let label = match sender.title.trim() {
                "" => "Agent",
                title => title,
            };
            entries.push(InboxEntry {
                message_id: message.message_id.clone(),
                rendered: build_envelope(&EnvelopeInput {
                    sender_title: label,
                    provider: &sender.provider,
                    sender_address: &message.sender_address,
                    message_id: &message.message_id,
                    conversation_id: &message.conversation_id,
                    in_reply_to: message.in_reply_to.as_deref(),
                    text: &message.text,
                }),
            });
        }
        self.report(messaging, &consumed, "consumed", None).await;
        Ok(entries)
    }

    /// The highest hop `identity` fetched in its generation since a person last typed into it;
    /// `None` when none. Time never resets it (R14).
    pub(crate) async fn terminal_trigger_hop(&self, identity: &TerminalIdentity) -> Option<u32> {
        let inputs = self
            .terminals
            .person_input_count(&identity.thread_id, &identity.terminal_id)
            .await;
        let mut hops = self.hops.lock().unwrap_or_else(PoisonError::into_inner);
        let ledger = hops.get_mut(&ledger_key(identity))?;
        ledger.follow(inputs);
        ledger.highest
    }

    pub(crate) fn reset_hop(&self, identity: &TerminalIdentity) {
        self.hops
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&ledger_key(identity));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{collections::HashMap, sync::Mutex as StdMutex, time::Duration};

    use serde_json::json;
    use tokio::sync::{broadcast, watch};

    use super::*;
    use crate::{
        agent_messaging::{MessageReceipt, SendRequest, delivery::AgentMessageTracker},
        orchestration::OrchestrationCommand,
        production::mcp_tools_tests::Harness,
        terminal::{
            ProviderTerminalActivityLaunch, TerminalAgentStatus, TerminalAgentStatusState,
            TerminalLaunchCommand, TerminalMetadataEvent, TerminalRemovalReason, TerminalStatus,
        },
    };

    pub(crate) struct FakeTerminal {
        generation: Option<TerminalGeneration>,
        ai: bool,
        /// The launch driver kind of an AI Terminal.
        pub(crate) driver: &'static str,
        state: TerminalAgentStatusState,
        ready: bool,
        person_inputs: u64,
        attempts: usize,
        writes: Vec<String>,
    }

    /// Terminals whose readiness and generation the test sets; every write is recorded.
    pub(crate) struct Scripted {
        terminals: StdMutex<HashMap<(String, String), FakeTerminal>>,
        metadata: broadcast::Sender<TerminalMetadataEvent>,
        /// When set, a write to the named terminal that typed parks until released, as a slow PTY
        /// write does.
        gate: StdMutex<Option<(String, Arc<WriteGate>)>>,
        /// When set, the live-generation read after `skip` more reads parks until released.
        live_park: StdMutex<Option<(usize, Arc<WriteGate>)>>,
        /// When set, the next write parks before its guard runs.
        guard_park: StdMutex<Option<Arc<WriteGate>>>,
    }

    #[derive(Default)]
    struct WriteGate {
        written: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    fn key(thread_id: &str, terminal_id: &str) -> (String, String) {
        (thread_id.to_owned(), terminal_id.to_owned())
    }

    fn generation(process: u64) -> TerminalGeneration {
        TerminalGeneration {
            boot: "boot-1".to_owned(),
            process,
        }
    }

    impl Scripted {
        pub(crate) fn new() -> Arc<Self> {
            Arc::new(Self {
                terminals: StdMutex::new(HashMap::new()),
                metadata: broadcast::channel(256).0,
                gate: StdMutex::new(None),
                live_park: StdMutex::new(None),
                guard_park: StdMutex::new(None),
            })
        }

        /// A running Claude AI Terminal (a plain shell when `ai` is false), not ready.
        pub(crate) fn add(&self, thread_id: &str, terminal_id: &str, process: u64, ai: bool) {
            self.terminals.lock().unwrap().insert(
                key(thread_id, terminal_id),
                FakeTerminal {
                    generation: Some(generation(process)),
                    ai,
                    driver: "claudeAgent",
                    state: TerminalAgentStatusState::Working,
                    ready: false,
                    person_inputs: 0,
                    attempts: 0,
                    writes: Vec::new(),
                },
            );
        }

        fn summary(thread_id: &str, terminal_id: &str, terminal: &FakeTerminal) -> TerminalSummary {
            TerminalSummary {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
                cwd: "/".to_owned(),
                worktree_path: None,
                status: if terminal.generation.is_some() {
                    TerminalStatus::Running
                } else {
                    TerminalStatus::Exited
                },
                pid: Some(1),
                exit_code: None,
                exit_signal: None,
                console_theme: None,
                has_running_subprocess: false,
                label: format!("Claude {terminal_id}"),
                updated_at: "2026-11-14T00:00:00Z".to_owned(),
                center_panel: false,
                command: terminal.ai.then(|| TerminalLaunchCommand {
                    executable: "claude".to_owned(),
                    args: Vec::new(),
                    label: None,
                    activity: Some(ProviderTerminalActivityLaunch {
                        driver_kind: terminal.driver.to_owned(),
                        provider_instance_id: terminal.driver.to_owned(),
                    }),
                    env: None,
                }),
                agent_status: terminal.ai.then_some(TerminalAgentStatus {
                    state: terminal.state,
                    failed: false,
                    age_ms: None,
                    observed_at: None,
                    ready_for_prompt: terminal.ready,
                }),
            }
        }

        pub(crate) fn change(
            &self,
            thread_id: &str,
            terminal_id: &str,
            change: impl FnOnce(&mut FakeTerminal),
        ) {
            let summary = {
                let mut terminals = self.terminals.lock().unwrap();
                let terminal = terminals.get_mut(&key(thread_id, terminal_id)).unwrap();
                change(terminal);
                Self::summary(thread_id, terminal_id, terminal)
            };
            let _ = self.metadata.send(TerminalMetadataEvent::Upsert {
                terminal: Box::new(summary),
            });
        }

        pub(crate) fn set_state(
            &self,
            thread_id: &str,
            terminal_id: &str,
            state: TerminalAgentStatusState,
        ) {
            self.change(thread_id, terminal_id, |terminal| {
                terminal.state = state;
                terminal.ready = state == TerminalAgentStatusState::Done;
            });
        }

        pub(crate) fn set_ready(&self, thread_id: &str, terminal_id: &str) {
            self.set_state(thread_id, terminal_id, TerminalAgentStatusState::Done);
        }

        fn read<T>(
            &self,
            thread_id: &str,
            terminal_id: &str,
            read: impl FnOnce(&FakeTerminal) -> T,
        ) -> T {
            read(&self.terminals.lock().unwrap()[&key(thread_id, terminal_id)])
        }

        fn writes(&self, thread_id: &str, terminal_id: &str) -> Vec<String> {
            self.read(thread_id, terminal_id, |terminal| terminal.writes.clone())
        }

        fn attempts(&self, thread_id: &str, terminal_id: &str) -> usize {
            self.read(thread_id, terminal_id, |terminal| terminal.attempts)
        }

        /// A new process (`Some`) or none (`None`, an exit) now holds the terminal.
        pub(crate) fn set_generation(
            &self,
            thread_id: &str,
            terminal_id: &str,
            process: Option<u64>,
        ) {
            self.change(thread_id, terminal_id, |terminal| {
                terminal.generation = process.map(generation);
                terminal.ready = false;
            });
        }

        fn close(&self, thread_id: &str, terminal_id: &str) {
            self.terminals
                .lock()
                .unwrap()
                .remove(&key(thread_id, terminal_id));
            let _ = self.metadata.send(TerminalMetadataEvent::Remove {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
                reason: TerminalRemovalReason::Closed,
            });
        }

        fn person_types(&self, thread_id: &str, terminal_id: &str) {
            self.change(thread_id, terminal_id, |terminal| {
                terminal.person_inputs += 1;
            });
        }
    }

    impl PointerTerminals for Scripted {
        fn write_when_ready<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
            generation: &'a TerminalGeneration,
            data: &'a str,
            still_wanted: WriteGuard,
        ) -> BoxFuture<'a, Result<WriteWhenReady, TerminalError>> {
            let guard_park = self.guard_park.lock().unwrap().take();
            let gate = self
                .gate
                .lock()
                .unwrap()
                .clone()
                .filter(|(gated, _)| gated == terminal_id)
                .map(|(_, gate)| gate);
            Box::pin(async move {
                if let Some(park) = guard_park {
                    park.written.notify_one();
                    park.release.notified().await;
                }
                // The guard runs at the moment of the write, as the writer's thread runs it.
                let outcome = {
                    let mut terminals = self.terminals.lock().unwrap();
                    let terminal = terminals.get_mut(&key(thread_id, terminal_id)).unwrap();
                    terminal.attempts += 1;
                    if terminal.generation.as_ref() != Some(generation) {
                        WriteWhenReady::GenerationChanged
                    } else if !terminal.ready || !still_wanted() {
                        WriteWhenReady::NotReady
                    } else {
                        terminal.ready = false;
                        terminal.writes.push(data.to_owned());
                        WriteWhenReady::Written
                    }
                };
                if outcome == WriteWhenReady::Written
                    && let Some(gate) = gate
                {
                    gate.written.notify_one();
                    gate.release.notified().await;
                }
                Ok(outcome)
            })
        }

        fn live_generation<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
        ) -> BoxFuture<'a, Option<TerminalGeneration>> {
            let live = self
                .terminals
                .lock()
                .unwrap()
                .get(&key(thread_id, terminal_id))
                .and_then(|terminal| terminal.generation.clone());
            let park = {
                let mut armed = self.live_park.lock().unwrap();
                match armed.as_mut() {
                    Some((0, _)) => armed.take().map(|(_, gate)| gate),
                    Some((skip, _)) => {
                        *skip -= 1;
                        None
                    }
                    None => None,
                }
            };
            Box::pin(async move {
                if let Some(park) = park {
                    park.written.notify_one();
                    park.release.notified().await;
                }
                live
            })
        }

        fn person_input_count<'a>(
            &'a self,
            thread_id: &'a str,
            terminal_id: &'a str,
        ) -> BoxFuture<'a, Option<u64>> {
            let count = self
                .terminals
                .lock()
                .unwrap()
                .get(&key(thread_id, terminal_id))
                .map(|terminal| terminal.person_inputs);
            Box::pin(std::future::ready(count))
        }

        fn thread_sessions<'a>(
            &'a self,
            thread_id: &'a str,
        ) -> BoxFuture<'a, Vec<TerminalSummary>> {
            let listed = self
                .terminals
                .lock()
                .unwrap()
                .iter()
                .filter(|((thread, _), _)| thread == thread_id)
                .map(|((thread, terminal_id), terminal)| {
                    Self::summary(thread, terminal_id, terminal)
                })
                .collect();
            Box::pin(std::future::ready(listed))
        }

        fn subscribe_metadata(&self) -> BoxFuture<'_, TerminalMetadataAttachment> {
            let attachment =
                TerminalMetadataAttachment::for_test(Vec::new(), self.metadata.subscribe());
            Box::pin(std::future::ready(attachment))
        }
    }

    const CREATED_AT: &str = "2026-11-14T00:00:00.000Z";
    const BODY: &str = "zebra-body-that-must-never-be-typed";

    struct Fixture {
        harness: Harness,
        terminals: Arc<Scripted>,
        pointer: TerminalPointer,
        enabled: watch::Sender<bool>,
        messaging: AgentMessaging,
        outcomes: Arc<StdMutex<Vec<MessageOutcome>>>,
        /// What the generation-end sink was told, in order.
        ended: Arc<StdMutex<Vec<(String, String, String)>>>,
        stop: CancellationToken,
        _other_project: tempfile::TempDir,
    }

    async fn dispatch(harness: &Harness, value: serde_json::Value) {
        let command: OrchestrationCommand = serde_json::from_value(value).expect("command");
        harness.engine.dispatch(command).await.expect("dispatched");
    }

    /// Threads `a`, `c` (full access), `q` (approval required) and the terminals' owner `t` in
    /// project `p1`, and `x` in project `p2`; the Claude AI Terminal `t/term-1` runs.
    async fn fixture() -> Fixture {
        let harness = Harness::new().await;
        let other_project = tempfile::tempdir().expect("second project folder");
        dispatch(
            &harness,
            json!({
                "type": "project.create", "commandId": "project-create-p2", "projectId": "p2",
                "title": "Other project", "workspaceRoot": other_project.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            }),
        )
        .await;
        for (thread_id, project_id, title, mode) in [
            ("a", "p1", "Sender thread", "full-access"),
            ("c", "p1", "Second sender", "full-access"),
            ("q", "p1", "Careful thread", "approval-required"),
            ("t", "p1", "Terminal host", "full-access"),
            ("x", "p2", "Other project thread", "full-access"),
        ] {
            dispatch(
                &harness,
                json!({
                    "type": "thread.create", "commandId": format!("create-{thread_id}"),
                    "threadId": thread_id, "projectId": project_id, "title": title,
                    "modelSelection": { "instanceId": "codex", "model": "model" },
                    "runtimeMode": mode, "createdAt": CREATED_AT,
                }),
            )
            .await;
        }
        let terminals = Scripted::new();
        terminals.add("t", "term-1", 1, true);
        let ended = Arc::new(StdMutex::new(Vec::new()));
        let ended_sink = ended.clone();
        let pointer = TerminalPointer::new(
            harness.engine.repositories().database().clone(),
            terminals.clone(),
        )
        .with_generation_end_sink(Arc::new(
            move |thread_id, terminal_id, generation_key| {
                ended_sink.lock().unwrap().push((
                    thread_id.to_owned(),
                    terminal_id.to_owned(),
                    generation_key.to_owned(),
                ));
            },
        ));
        let (enabled, receiver) = watch::channel(true);
        let outcomes = Arc::new(StdMutex::new(Vec::new()));
        let sink = outcomes.clone();
        let messaging = AgentMessaging::new(harness.engine.clone(), receiver)
            .with_terminals(pointer.clone())
            .with_outcomes(Arc::new(move |outcome| sink.lock().unwrap().push(outcome)));
        Fixture {
            harness,
            terminals,
            pointer,
            enabled,
            messaging,
            outcomes,
            ended,
            stop: CancellationToken::new(),
            _other_project: other_project,
        }
    }

    impl Fixture {
        fn start(&self) -> JoinHandle<()> {
            self.pointer
                .start(self.messaging.clone(), self.stop.clone())
        }

        async fn send(&self, from: &str, to: &str) -> Result<MessageReceipt, AgentMessagingError> {
            self.messaging
                .send(
                    from,
                    SendRequest {
                        to: to.to_owned(),
                        text: BODY.to_owned(),
                        client_request_id: None,
                    },
                )
                .await
        }

        async fn row(&self, message_id: &str) -> AgentMessageRow {
            let message_id = message_id.to_owned();
            self.harness
                .engine
                .repositories()
                .database()
                .call(move |connection| store::get_message(connection, &message_id))
                .await
                .unwrap()
                .expect("stored")
        }

        async fn until_status(
            &self,
            message_id: &str,
            status: AgentMessageStatus,
        ) -> AgentMessageRow {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let row = self.row(message_id).await;
                    if row.status == status {
                        return row;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("message reaches {}", status.as_str()))
        }

        /// Every outcome reported so far, once one of them is `outcome`.
        async fn until_outcome(&self, outcome: &str) -> Vec<MessageOutcome> {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let outcomes = self.outcomes.lock().unwrap().clone();
                    if outcomes.iter().any(|reported| reported.outcome == outcome) {
                        return outcomes;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("an outcome {outcome} is reported"))
        }

        /// Waits until the pointer asked `t/terminal_id` to be typed into `count` times.
        async fn until_attempts(&self, terminal_id: &str, count: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.terminals.attempts("t", terminal_id) < count {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the pointer tried the terminal");
        }

        fn identity(&self, terminal_id: &str) -> TerminalIdentity {
            TerminalIdentity {
                environment_id: "local".to_owned(),
                thread_id: "t".to_owned(),
                terminal_id: terminal_id.to_owned(),
                generation: self
                    .terminals
                    .read("t", terminal_id, |terminal| terminal.generation.clone())
                    .unwrap(),
            }
        }

        /// Stores a message from `sender_address` straight through `accept`.
        async fn accept_from(
            &self,
            sender_address: &str,
            sender_kind: SenderKind,
            terminal_id: &str,
        ) -> Result<(), AgentMessagingError> {
            self.accept_at_hop(sender_address, sender_kind, terminal_id, 1)
                .await
                .map(drop)
        }

        /// [`Self::accept_from`] at `hop`; returns the message id.
        async fn accept_at_hop(
            &self,
            sender_address: &str,
            sender_kind: SenderKind,
            terminal_id: &str,
            hop: u32,
        ) -> Result<String, AgentMessagingError> {
            let identity = self.identity(terminal_id);
            let message_id = uuid::Uuid::new_v4().to_string();
            self.pointer
                .accept(
                    &self.messaging,
                    NewAgentMessage {
                        message_id: message_id.clone(),
                        conversation_id: uuid::Uuid::new_v4().to_string(),
                        sender_address: sender_address.to_owned(),
                        sender_kind,
                        recipient_address: String::new(),
                        in_reply_to: None,
                        hop,
                        text: BODY.to_owned(),
                        status: AgentMessageStatus::Accepted,
                        reason: None,
                        accepted_at: crate::mcp::control::now_iso(),
                        sender_runtime_mode: (sender_kind == SenderKind::Agent)
                            .then(|| "full-access".to_owned()),
                        recipient_terminal_generation: None,
                        send_request_id: None,
                        client_request_id: None,
                        delivery_command_id: None,
                        delivery_message_id: None,
                    },
                    &identity,
                )
                .await
                .map(|()| message_id)
        }

        async fn inbox(&self, terminal_id: &str) -> Vec<InboxEntry> {
            self.pointer
                .inbox(&self.messaging, &self.identity(terminal_id))
                .await
                .expect("the inbox answers")
        }

        async fn trigger_hop(&self, terminal_id: &str) -> Option<u32> {
            self.pointer
                .terminal_trigger_hop(&self.identity(terminal_id))
                .await
        }

        async fn shutdown(self) {
            self.stop.cancel();
            self.harness.shutdown().await;
        }
    }

    fn pointer_bytes() -> String {
        [
            POINTER_PASTE_OPEN,
            POINTER_LINE,
            POINTER_PASTE_CLOSE,
            POINTER_SUBMIT,
        ]
        .concat()
    }

    #[tokio::test]
    async fn a_ready_terminal_gets_one_pointer_line_and_the_message_becomes_delivered() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        assert_eq!(receipt.status, AgentMessageStatus::Queued);
        let row = fixture.row(&receipt.message_id).await;
        assert_eq!(row.status, AgentMessageStatus::Queued);
        assert_eq!(row.recipient_address, "terminal:t/term-1");
        assert_eq!(
            row.recipient_terminal_generation.as_deref(),
            Some("boot-1:1")
        );
        assert_eq!(
            row.delivery_command_id, None,
            "a terminal row has no queue entry"
        );
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1"), [pointer_bytes()]);
        assert_eq!(
            pointer_bytes(),
            "\u{1b}[200~BiBCode: you have new messages. Run `bibcode agent inbox` to read them.\u{1b}[201~\r"
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_busy_blocked_waiting_or_unobservable_terminal_gets_nothing_typed() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        let mut attempts = fixture.terminals.attempts("t", "term-1");
        for state in [
            TerminalAgentStatusState::Working,
            TerminalAgentStatusState::Blocked,
            TerminalAgentStatusState::Waiting,
            TerminalAgentStatusState::Unavailable,
        ] {
            fixture.terminals.set_state("t", "term-1", state);
            attempts += 1;
            fixture.until_attempts("term-1", attempts).await;
            assert_eq!(
                fixture.row(&receipt.message_id).await.status,
                AgentMessageStatus::Queued,
                "{state:?}"
            );
        }
        assert!(fixture.terminals.writes("t", "term-1").is_empty());
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn two_messages_in_one_ready_period_share_one_pointer() {
        let fixture = fixture().await;
        fixture.start();
        let first = fixture.send("a", "terminal:t/term-1").await.unwrap();
        let second = fixture.send("c", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&first.message_id, AgentMessageStatus::Delivered)
            .await;
        fixture
            .until_status(&second.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 1);
        // The ready period ended with the pointer: the next message waits for the next one.
        let attempts = fixture.terminals.attempts("t", "term-1");
        let third = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.until_attempts("term-1", attempts + 1).await;
        assert_eq!(
            fixture.row(&third.message_id).await.status,
            AgentMessageStatus::Queued
        );
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&third.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 2);
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_terminal_receives_as_full_access() {
        let fixture = fixture().await;
        assert_eq!(
            fixture.send("q", "terminal:t/term-1").await,
            Err(AgentMessagingError::ModeCeiling {
                sender: "approval-required".to_owned(),
                recipient: "full-access".to_owned(),
            })
        );
        assert_eq!(
            fixture.send("a", "terminal:t/term-1").await.unwrap().status,
            AgentMessageStatus::Queued
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_chat_agent_reaches_only_a_live_ai_terminal_of_its_project() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "shell", 2, false);
        fixture.terminals.add("t", "ended", 3, true);
        fixture
            .terminals
            .change("t", "ended", |terminal| terminal.generation = None);
        for (from, to) in [
            ("x", "terminal:t/term-1"),
            ("a", "terminal:t/shell"),
            ("a", "terminal:t/ended"),
            ("a", "terminal:t/missing"),
            ("a", "terminal:nobody/term-1"),
        ] {
            assert_eq!(
                fixture.send(from, to).await,
                Err(AgentMessagingError::UnknownRecipient),
                "{from} to {to}"
            );
        }
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_chat_tracker_never_touches_terminal_rows_and_the_messaging_off_reconcile_holds_them()
     {
        let fixture = fixture().await;
        let tracker = CancellationToken::new();
        AgentMessageTracker::start(
            fixture.harness.engine.clone(),
            None,
            fixture.enabled.subscribe(),
            tracker.clone(),
        );
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.enabled.send(true).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Queued,
            "the tracker's reconciliation leaves a terminal row alone"
        );
        fixture.enabled.send(false).unwrap();
        let held = fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Held)
            .await;
        assert_eq!(held.reason, Some(AgentMessageReason::MessagingOff));
        fixture.terminals.set_ready("t", "term-1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            fixture.terminals.writes("t", "term-1").is_empty(),
            "no pointer for a held row"
        );
        fixture.enabled.send(true).unwrap();
        let delivered = fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(delivered.reason, None);
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 1);
        tracker.cancel();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_rows_obey_the_rate_and_backlog_limits() {
        let fixture = fixture().await;
        for terminal_id in ["term-2", "term-3", "term-4", "term-5"] {
            fixture.terminals.add("t", terminal_id, 1, true);
        }
        // A chat sender: 30 messages in the window, then the rate refuses the 31st.
        for index in 0..30 {
            let to = if index < 15 {
                "terminal:t/term-1"
            } else {
                "terminal:t/term-2"
            };
            fixture.send("a", to).await.unwrap();
        }
        assert_eq!(
            fixture.send("a", "terminal:t/term-3").await,
            Err(AgentMessagingError::RateLimit)
        );
        // term-1 holds 15 unread: five more fill its backlog.
        for _ in 0..5 {
            fixture.send("c", "terminal:t/term-1").await.unwrap();
        }
        assert_eq!(
            fixture.send("c", "terminal:t/term-1").await,
            Err(AgentMessagingError::BacklogLimit)
        );
        // A person's requests are never refused and never count.
        for _ in 0..25 {
            fixture
                .accept_from("thread:a", SenderKind::Person, "term-3")
                .await
                .unwrap();
        }
        fixture.send("c", "terminal:t/term-3").await.unwrap();
        // A terminal sender obeys the same limits.
        let sender = "terminal:t/term-9";
        for _ in 0..20 {
            fixture
                .accept_from(sender, SenderKind::Agent, "term-4")
                .await
                .unwrap();
        }
        assert_eq!(
            fixture
                .accept_from(sender, SenderKind::Agent, "term-4")
                .await,
            Err(AgentMessagingError::BacklogLimit)
        );
        for _ in 0..10 {
            fixture
                .accept_from(sender, SenderKind::Agent, "term-5")
                .await
                .unwrap();
        }
        assert_eq!(
            fixture
                .accept_from(sender, SenderKind::Agent, "term-5")
                .await,
            Err(AgentMessagingError::RateLimit)
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_pointer_task_stops_before_profiler_teardown() {
        let fixture = fixture().await;
        let task = fixture.start();
        // The quiesce sequence cancels this token before the profiler's teardown.
        fixture.stop.cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("the pointer task stops on its token")
            .expect("the pointer task did not panic");
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_delivery_reaches_the_activity_log_without_text() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        let outcomes = fixture.until_outcome("delivered").await;
        let delivered: Vec<_> = outcomes
            .iter()
            .filter(|outcome| outcome.outcome == "delivered")
            .collect();
        assert_eq!(
            delivered,
            [&MessageOutcome {
                sender_address: "thread:a".to_owned(),
                recipient_address: "terminal:t/term-1".to_owned(),
                tool: "agent_message_delivery",
                outcome: "delivered".to_owned(),
                message_id: Some(receipt.message_id.clone()),
                conversation_id: Some(receipt.conversation_id.clone()),
                hop: Some(1),
                reason: None,
                sender_title: Some("Sender thread".to_owned()),
                recipient_title: Some("Claude term-1".to_owned()),
            }]
        );
        assert!(!format!("{outcomes:?}").contains(BODY));
        fixture.shutdown().await;
    }

    /// An agent message stored as is, bypassing `accept`, for `t/terminal_id`'s generation
    /// `generation_key`.
    async fn insert_raw(
        fixture: &Fixture,
        terminal_id: &str,
        generation_key: &str,
        mode: &str,
    ) -> String {
        let message_id = uuid::Uuid::new_v4().to_string();
        let new = NewAgentMessage {
            message_id: message_id.clone(),
            conversation_id: uuid::Uuid::new_v4().to_string(),
            sender_address: "thread:a".to_owned(),
            sender_kind: SenderKind::Agent,
            recipient_address: format!("terminal:t/{terminal_id}"),
            in_reply_to: None,
            hop: 1,
            text: BODY.to_owned(),
            status: AgentMessageStatus::Queued,
            reason: None,
            accepted_at: crate::mcp::control::now_iso(),
            sender_runtime_mode: Some(mode.to_owned()),
            recipient_terminal_generation: Some(generation_key.to_owned()),
            send_request_id: None,
            client_request_id: None,
            delivery_command_id: None,
            delivery_message_id: None,
        };
        fixture
            .harness
            .engine
            .repositories()
            .database()
            .call(move |connection| {
                let tx = connection.transaction()?;
                store::insert_message(&tx, &new)?;
                tx.commit()?;
                Ok(())
            })
            .await
            .unwrap();
        message_id
    }

    fn ids(entries: &[InboxEntry]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| entry.message_id.as_str())
            .collect()
    }

    #[tokio::test]
    async fn inbox_consumes_what_it_returns_and_prints_the_envelope() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        let entries = fixture.inbox("term-1").await;
        assert_eq!(ids(&entries), [receipt.message_id.as_str()]);
        assert_eq!(
            entries[0].rendered,
            super::super::envelope::build_envelope(&super::super::envelope::EnvelopeInput {
                sender_title: "Sender thread",
                provider: "codex",
                sender_address: "thread:a",
                message_id: &receipt.message_id,
                conversation_id: &receipt.conversation_id,
                in_reply_to: None,
                text: BODY,
            })
        );
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Consumed
        );
        assert!(fixture.inbox("term-1").await.is_empty());
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn an_unready_terminal_can_still_fetch_a_queued_message() {
        let fixture = fixture().await;
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        assert_eq!(
            ids(&fixture.inbox("term-1").await),
            [receipt.message_id.as_str()]
        );
        assert!(fixture.terminals.writes("t", "term-1").is_empty());
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Consumed
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_message_for_another_generation_is_never_returned_by_inbox() {
        let fixture = fixture().await;
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.start();
        fixture.terminals.set_generation("t", "term-1", Some(2));
        let failed = fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Failed)
            .await;
        assert_eq!(failed.reason, Some(AgentMessageReason::RecipientGone));
        assert!(fixture.inbox("term-1").await.is_empty());
        // A row of the old generation that is still waiting is never handed to the new one.
        let stale = insert_raw(&fixture, "term-1", "boot-1:1", "full-access").await;
        assert!(fixture.inbox("term-1").await.is_empty());
        assert_ne!(
            fixture.row(&stale).await.status,
            AgentMessageStatus::Consumed
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn inbox_returns_no_agent_message_while_messaging_is_off_and_returns_it_after_it_is_turned_on()
     {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.enabled.send(false).unwrap();
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Held)
            .await;
        let person = fixture
            .accept_at_hop("thread:a", SenderKind::Person, "term-1", 1)
            .await
            .unwrap();
        assert_eq!(ids(&fixture.inbox("term-1").await), [person.as_str()]);
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Held
        );
        fixture.enabled.send(true).unwrap();
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Queued)
            .await;
        let person = fixture
            .accept_at_hop("thread:a", SenderKind::Person, "term-1", 1)
            .await
            .unwrap();
        assert_eq!(
            ids(&fixture.inbox("term-1").await),
            [receipt.message_id.as_str(), person.as_str()]
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn inbox_skips_a_row_whose_ceiling_no_longer_holds() {
        let fixture = fixture().await;
        let below = insert_raw(&fixture, "term-1", "boot-1:1", "auto-accept-edits").await;
        assert!(fixture.inbox("term-1").await.is_empty());
        assert_eq!(fixture.row(&below).await.status, AgentMessageStatus::Queued);
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_closed_terminal_fails_its_unconsumed_messages() {
        let fixture = fixture().await;
        type Ending = fn(&Scripted, &str);
        let endings: [(&str, Ending); 4] = [
            ("term-close", |terminals, id| terminals.close("t", id)),
            ("term-exit", |terminals, id| {
                terminals.set_generation("t", id, None);
            }),
            ("term-restart", |terminals, id| {
                terminals.set_generation("t", id, Some(2));
            }),
            ("term-replace", |terminals, id| {
                terminals.set_generation("t", id, Some(9));
            }),
        ];
        fixture.start();
        for (terminal_id, end) in endings {
            fixture.terminals.add("t", terminal_id, 1, true);
            let read = fixture
                .send("a", &format!("terminal:t/{terminal_id}"))
                .await
                .unwrap();
            assert_eq!(fixture.inbox(terminal_id).await.len(), 1);
            let unread = fixture
                .send("c", &format!("terminal:t/{terminal_id}"))
                .await
                .unwrap();
            end(&fixture.terminals, terminal_id);
            let failed = fixture
                .until_status(&unread.message_id, AgentMessageStatus::Failed)
                .await;
            assert_eq!(
                failed.reason,
                Some(AgentMessageReason::RecipientGone),
                "{terminal_id}"
            );
            assert_eq!(
                fixture.row(&read.message_id).await.status,
                AgentMessageStatus::Consumed,
                "{terminal_id}"
            );
        }
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_server_restart_fails_terminal_messages_of_the_earlier_boot() {
        let fixture = fixture().await;
        let earlier = insert_raw(&fixture, "term-1", "boot-0:1", "full-access").await;
        fixture.start();
        let failed = fixture
            .until_status(&earlier, AgentMessageStatus::Failed)
            .await;
        assert_eq!(failed.reason, Some(AgentMessageReason::RecipientGone));
        // The sink hears of the end after the rows failed.
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.ended.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the end of the earlier boot's generation is reported");
        assert_eq!(
            fixture.ended.lock().unwrap().clone(),
            [("t".to_owned(), "term-1".to_owned(), "boot-0:1".to_owned())]
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_generation_end_sink_is_called_once_per_ended_generation_even_with_no_unconsumed_row()
     {
        let fixture = fixture().await;
        fixture.send("a", "terminal:t/term-1").await.unwrap();
        assert_eq!(fixture.inbox("term-1").await.len(), 1);
        fixture.start();
        fixture.terminals.set_generation("t", "term-1", None);
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.ended.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the end of the generation is reported");
        for _ in 0..3 {
            fixture
                .terminals
                .set_state("t", "term-1", TerminalAgentStatusState::Working);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            fixture.ended.lock().unwrap().clone(),
            [("t".to_owned(), "term-1".to_owned(), "boot-1:1".to_owned())]
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_slow_exchange_does_not_reset_itself() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "term-2", 1, true);
        // The other terminal's agent answered an hour later: no person typed in between.
        fixture
            .accept_at_hop("terminal:t/term-2", SenderKind::Agent, "term-1", 8)
            .await
            .unwrap();
        assert_eq!(fixture.inbox("term-1").await.len(), 1);
        assert_eq!(fixture.trigger_hop("term-1").await, Some(8));
        assert_eq!(
            policy::next_hop(fixture.trigger_hop("term-1").await),
            Err(AgentMessagingError::HopLimit)
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn two_terminals_cannot_ping_pong() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "term-2", 1, true);
        let (mut from, mut to) = ("term-2", "term-1");
        let mut hop = 1;
        loop {
            fixture
                .accept_at_hop(&format!("terminal:t/{from}"), SenderKind::Agent, to, hop)
                .await
                .unwrap();
            assert_eq!(fixture.inbox(to).await.len(), 1);
            match policy::next_hop(fixture.trigger_hop(to).await) {
                Ok(next) => hop = next,
                Err(error) => {
                    assert_eq!(error, AgentMessagingError::HopLimit);
                    break;
                }
            }
            (from, to) = (to, from);
        }
        assert_eq!(hop, 8, "the eighth hop is the last");
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn a_person_typing_resets_the_chain() {
        let fixture = fixture().await;
        fixture
            .accept_at_hop("terminal:t/term-2", SenderKind::Agent, "term-1", 8)
            .await
            .unwrap();
        fixture.inbox("term-1").await;
        assert_eq!(fixture.trigger_hop("term-1").await, Some(8));
        fixture.terminals.person_types("t", "term-1");
        assert_eq!(fixture.trigger_hop("term-1").await, None);
        assert_eq!(policy::next_hop(fixture.trigger_hop("term-1").await), Ok(1));
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_trigger_hop_is_the_highest_fetched_hop_since_the_last_input() {
        let fixture = fixture().await;
        assert_eq!(fixture.trigger_hop("term-1").await, None);
        for hop in [3, 5, 2] {
            fixture
                .accept_at_hop("terminal:t/term-2", SenderKind::Agent, "term-1", hop)
                .await
                .unwrap();
        }
        fixture.inbox("term-1").await;
        assert_eq!(fixture.trigger_hop("term-1").await, Some(5));
        fixture.terminals.person_types("t", "term-1");
        fixture
            .accept_at_hop("terminal:t/term-2", SenderKind::Agent, "term-1", 2)
            .await
            .unwrap();
        fixture.inbox("term-1").await;
        assert_eq!(fixture.trigger_hop("term-1").await, Some(2));
        fixture.pointer.reset_hop(&fixture.identity("term-1"));
        assert_eq!(fixture.trigger_hop("term-1").await, None);
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn cancelling_a_delivered_unfetched_message_removes_it_from_the_inbox() {
        let fixture = fixture().await;
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(
            fixture.messaging.cancel("a", &receipt.message_id).await,
            Ok(AgentMessageStatus::Cancelled)
        );
        assert!(fixture.inbox("term-1").await.is_empty());
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Cancelled
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn cancelling_a_consumed_message_fails_saying_it_was_already_delivered() {
        let fixture = fixture().await;
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.inbox("term-1").await;
        let error = fixture
            .messaging
            .cancel("a", &receipt.message_id)
            .await
            .unwrap_err();
        assert_eq!(error, AgentMessagingError::NotCancellable);
        assert!(error.message().contains("already delivered"));
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Consumed
        );
        fixture.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancel_racing_an_inbox_fetch_has_exactly_one_winner() {
        let fixture = fixture().await;
        let (mut cancelled, mut fetched) = (0, 0);
        for round in 0..50 {
            // Two senders keep each under the rate limit.
            let sender = if round % 2 == 0 { "a" } else { "c" };
            let receipt = fixture.send(sender, "terminal:t/term-1").await.unwrap();
            let (cancel, entries) = tokio::join!(
                fixture.messaging.cancel(sender, &receipt.message_id),
                fixture.inbox("term-1"),
            );
            let status = fixture.row(&receipt.message_id).await.status;
            match cancel {
                Ok(AgentMessageStatus::Cancelled) => {
                    assert!(entries.is_empty(), "round {round}: cancelled and fetched");
                    assert_eq!(status, AgentMessageStatus::Cancelled, "round {round}");
                    cancelled += 1;
                }
                Err(AgentMessagingError::NotCancellable) => {
                    assert_eq!(
                        ids(&entries),
                        [receipt.message_id.as_str()],
                        "round {round}"
                    );
                    assert_eq!(status, AgentMessageStatus::Consumed, "round {round}");
                    fetched += 1;
                }
                other => panic!("round {round}: unexpected cancel result {other:?}"),
            }
        }
        assert_eq!(cancelled + fetched, 50);
        fixture.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fetch_or_a_cancel_waits_for_a_pointer_write_in_progress() {
        for cancel in [false, true] {
            let fixture = Arc::new(fixture().await);
            let gate = Arc::new(WriteGate::default());
            *fixture.terminals.gate.lock().unwrap() = Some(("term-1".to_owned(), gate.clone()));
            fixture.start();
            let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
            fixture.terminals.set_ready("t", "term-1");
            // The pointer is typed and its attempt has not marked the mail yet.
            tokio::time::timeout(Duration::from_secs(5), gate.written.notified())
                .await
                .expect("the pointer is typed");
            let racer = tokio::spawn({
                let fixture = fixture.clone();
                let message_id = receipt.message_id.clone();
                async move {
                    if cancel {
                        assert_eq!(
                            fixture.messaging.cancel("a", &message_id).await,
                            Ok(AgentMessageStatus::Cancelled)
                        );
                    } else {
                        assert_eq!(ids(&fixture.inbox("term-1").await), [message_id.as_str()]);
                    }
                }
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(
                !racer.is_finished(),
                "cancel {cancel}: it ran inside the write"
            );
            gate.release.notify_one();
            racer.await.unwrap();
            let expected = if cancel {
                AgentMessageStatus::Cancelled
            } else {
                AgentMessageStatus::Consumed
            };
            assert_eq!(
                fixture.row(&receipt.message_id).await.status,
                expected,
                "cancel {cancel}"
            );
            assert_eq!(
                fixture
                    .outcomes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|outcome| outcome.outcome == "delivered"
                        && outcome.message_id.as_deref() == Some(&receipt.message_id))
                    .count(),
                1,
                "cancel {cancel}: delivered once, before the racer"
            );
            assert!(
                !ids(&fixture.inbox("term-1").await).contains(&receipt.message_id.as_str()),
                "cancel {cancel}"
            );
            let Ok(fixture) = Arc::try_unwrap(fixture) else {
                panic!("the racer released the fixture");
            };
            fixture.shutdown().await;
        }
    }

    #[tokio::test]
    async fn the_production_wiring_reports_terminal_outcomes_through_the_sink() {
        let fixture = fixture().await;
        let outcomes = Arc::new(StdMutex::new(Vec::<MessageOutcome>::new()));
        let sink = outcomes.clone();
        let pointer = TerminalPointer::new(
            fixture.harness.engine.repositories().database().clone(),
            fixture.terminals.clone(),
        );
        let stop = CancellationToken::new();
        let messaging = crate::production::runtime::start_terminal_messaging(
            AgentMessaging::new(fixture.harness.engine.clone(), fixture.enabled.subscribe()),
            &pointer,
            Some(Arc::new(move |outcome| sink.lock().unwrap().push(outcome))),
            stop.clone(),
        );
        let send = |from: &'static str| {
            messaging.send(
                from,
                SendRequest {
                    to: "terminal:t/term-1".to_owned(),
                    text: BODY.to_owned(),
                    client_request_id: None,
                },
            )
        };
        let reported = |outcome: &'static str, message_id: String| {
            let outcomes = outcomes.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !outcomes.lock().unwrap().iter().any(|reported| {
                        reported.outcome == outcome
                            && reported.message_id.as_deref() == Some(&message_id)
                    }) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap_or_else(|_| panic!("the sink hears {outcome}"));
            }
        };
        let delivered = send("a").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        reported("delivered", delivered.message_id).await;
        let failed = send("c").await.unwrap();
        fixture.terminals.set_generation("t", "term-1", None);
        reported("failed", failed.message_id).await;
        stop.cancel();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn mail_that_stops_being_eligible_before_the_write_gets_no_pointer() {
        let mut typed = Vec::new();
        for change in ["cancel", "fetch", "messaging off"] {
            let fixture = fixture().await;
            fixture.start();
            let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
            fixture.until_attempts("term-1", 1).await;
            // The pass's ended-generation sweep reads the live generation first; the pointer's
            // own read after it parks, once it has read the waiting mail.
            let park = Arc::new(WriteGate::default());
            *fixture.terminals.live_park.lock().unwrap() = Some((1, park.clone()));
            fixture.terminals.set_ready("t", "term-1");
            tokio::time::timeout(Duration::from_secs(5), park.written.notified())
                .await
                .expect("the pointer read the waiting mail");
            match change {
                "cancel" => assert_eq!(
                    fixture.messaging.cancel("a", &receipt.message_id).await,
                    Ok(AgentMessageStatus::Cancelled)
                ),
                "fetch" => assert_eq!(
                    ids(&fixture.inbox("term-1").await),
                    [receipt.message_id.as_str()]
                ),
                _ => fixture.enabled.send(false).unwrap(),
            }
            park.release.notify_one();
            tokio::time::sleep(Duration::from_millis(200)).await;
            if !fixture.terminals.writes("t", "term-1").is_empty() {
                typed.push(change);
            }
            fixture.shutdown().await;
        }
        assert!(
            typed.is_empty(),
            "a pointer was typed for mail nobody can fetch after: {typed:?}"
        );
    }

    #[tokio::test]
    async fn the_setting_is_read_again_at_the_moment_of_the_write() {
        for person in [false, true] {
            let fixture = fixture().await;
            fixture.start();
            if person {
                fixture
                    .accept_from("thread:a", SenderKind::Person, "term-1")
                    .await
                    .unwrap();
            } else {
                fixture.send("a", "terminal:t/term-1").await.unwrap();
            }
            fixture.until_attempts("term-1", 1).await;
            let park = Arc::new(WriteGate::default());
            *fixture.terminals.guard_park.lock().unwrap() = Some(park.clone());
            fixture.terminals.set_ready("t", "term-1");
            tokio::time::timeout(Duration::from_secs(5), park.written.notified())
                .await
                .expect("the pointer write reached the terminal");
            fixture.enabled.send(false).unwrap();
            park.release.notify_one();
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_eq!(
                fixture.terminals.writes("t", "term-1").len(),
                usize::from(person),
                "person {person}: a person's request is announced while messaging is off, an \
                 agent's message is not"
            );
            fixture.shutdown().await;
        }
    }

    #[tokio::test]
    async fn pointer_attempts_settle_after_a_burst_of_events() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "term-2", 1, true);
        fixture.start();
        fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.send("a", "terminal:t/term-2").await.unwrap();
        for _ in 0..20 {
            for terminal_id in ["term-1", "term-2"] {
                fixture
                    .terminals
                    .set_state("t", terminal_id, TerminalAgentStatusState::Working);
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let settled = (
            fixture.terminals.attempts("t", "term-1"),
            fixture.terminals.attempts("t", "term-2"),
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            (
                fixture.terminals.attempts("t", "term-1"),
                fixture.terminals.attempts("t", "term-2"),
            ),
            settled,
            "attempts on terminals that are not ready keep waking each other"
        );
        fixture.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_terminal_whose_input_is_stuck_holds_up_no_other_terminal() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "term-2", 1, true);
        fixture.terminals.add("t", "term-3", 1, true);
        let gate = Arc::new(WriteGate::default());
        *fixture.terminals.gate.lock().unwrap() = Some(("term-1".to_owned(), gate.clone()));
        let task = fixture.start();
        fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        tokio::time::timeout(Duration::from_secs(5), gate.written.notified())
            .await
            .expect("term-1's write is stuck");
        let other = fixture.send("c", "terminal:t/term-2").await.unwrap();
        let ended = fixture.send("c", "terminal:t/term-3").await.unwrap();
        fixture.terminals.set_ready("t", "term-2");
        fixture
            .until_status(&other.message_id, AgentMessageStatus::Delivered)
            .await;
        fixture.terminals.set_generation("t", "term-3", None);
        fixture
            .until_status(&ended.message_id, AgentMessageStatus::Failed)
            .await;
        fixture.stop.cancel();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("the pointer task stops while a write is stuck")
            .expect("the pointer task did not panic");
        gate.release.notify_one();
        fixture.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ending_a_terminal_whose_write_is_stuck_delays_no_other_terminal() {
        let fixture = fixture().await;
        fixture.terminals.add("t", "term-2", 1, true);
        let gate = Arc::new(WriteGate::default());
        *fixture.terminals.gate.lock().unwrap() = Some(("term-1".to_owned(), gate.clone()));
        fixture.start();
        fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.terminals.set_ready("t", "term-1");
        tokio::time::timeout(Duration::from_secs(5), gate.written.notified())
            .await
            .expect("term-1's write is stuck");
        // Its end waits for the stuck write's exclusion.
        fixture.terminals.set_generation("t", "term-1", None);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let other = fixture.send("c", "terminal:t/term-2").await.unwrap();
        fixture.terminals.set_ready("t", "term-2");
        // Well inside the stuck write's own limit.
        tokio::time::timeout(Duration::from_secs(1), async {
            while fixture.row(&other.message_id).await.status != AgentMessageStatus::Delivered {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("term-2 got its pointer while term-1's end waited");
        gate.release.notify_one();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_setting_holds_no_mail_while_a_pointer_write_holds_its_terminal() {
        let fixture = fixture().await;
        // The chat tracker follows the setting too; it must leave this terminal's mail alone.
        let tracker = CancellationToken::new();
        AgentMessageTracker::start(
            fixture.harness.engine.clone(),
            None,
            fixture.enabled.subscribe(),
            tracker.clone(),
        );
        fixture.start();
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.until_attempts("term-1", 1).await;
        let park = Arc::new(WriteGate::default());
        *fixture.terminals.guard_park.lock().unwrap() = Some(park.clone());
        fixture.terminals.set_ready("t", "term-1");
        tokio::time::timeout(Duration::from_secs(5), park.written.notified())
            .await
            .expect("the pointer write reached the terminal");
        fixture.enabled.send(false).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Queued,
            "the mail changed under a pointer write that read it as eligible"
        );
        fixture.enabled.send(true).unwrap();
        park.release.notify_one();
        fixture
            .until_status(&receipt.message_id, AgentMessageStatus::Delivered)
            .await;
        assert_eq!(fixture.terminals.writes("t", "term-1").len(), 1);
        tracker.cancel();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn an_ended_generation_cannot_fetch_its_mail() {
        let fixture = fixture().await;
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        let old = fixture.identity("term-1");
        fixture.terminals.set_generation("t", "term-1", Some(2));
        let fetched = fixture
            .pointer
            .inbox(&fixture.messaging, &old)
            .await
            .unwrap_or_default();
        assert!(fetched.is_empty(), "the old generation fetched its mail");
        assert_ne!(
            fixture.row(&receipt.message_id).await.status,
            AgentMessageStatus::Consumed
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn the_generation_end_sink_is_not_called_again_after_a_server_restart() {
        let fixture = fixture().await;
        fixture.send("a", "terminal:t/term-1").await.unwrap();
        assert_eq!(fixture.inbox("term-1").await.len(), 1);
        fixture.start();
        fixture.terminals.set_generation("t", "term-1", None);
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.ended.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the end of the generation is reported");
        fixture.stop.cancel();
        // A restarted server: a new pointer, with nothing in memory, over the same store.
        let ended = fixture.ended.clone();
        let restarted = TerminalPointer::new(
            fixture.harness.engine.repositories().database().clone(),
            fixture.terminals.clone(),
        )
        .with_generation_end_sink(Arc::new(
            move |thread_id, terminal_id, generation_key| {
                ended.lock().unwrap().push((
                    thread_id.to_owned(),
                    terminal_id.to_owned(),
                    generation_key.to_owned(),
                ));
            },
        ));
        let stop = CancellationToken::new();
        restarted.start(fixture.messaging.clone(), stop.clone());
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.cancel();
        assert_eq!(
            fixture.ended.lock().unwrap().clone(),
            [("t".to_owned(), "term-1".to_owned(), "boot-1:1".to_owned())]
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_failure_reaches_the_activity_log_without_text() {
        let fixture = fixture().await;
        let receipt = fixture.send("a", "terminal:t/term-1").await.unwrap();
        fixture.start();
        fixture.terminals.set_generation("t", "term-1", None);
        let outcomes = fixture.until_outcome("failed").await;
        let failed: Vec<_> = outcomes
            .iter()
            .filter(|outcome| outcome.outcome == "failed")
            .collect();
        assert_eq!(
            failed,
            [&MessageOutcome {
                sender_address: "thread:a".to_owned(),
                recipient_address: "terminal:t/term-1".to_owned(),
                tool: "agent_message_delivery",
                outcome: "failed".to_owned(),
                message_id: Some(receipt.message_id.clone()),
                conversation_id: Some(receipt.conversation_id.clone()),
                hop: Some(1),
                reason: Some("recipient_gone".to_owned()),
                sender_title: Some("Sender thread".to_owned()),
                recipient_title: Some("Claude term-1".to_owned()),
            }]
        );
        assert!(!format!("{outcomes:?}").contains(BODY));
        fixture.shutdown().await;
    }
}
