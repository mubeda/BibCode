use std::collections::VecDeque;

const DEQUE_SHRINK_OCCUPANCY_DENOMINATOR: usize = 4;

/// How far before a tail's start `TerminalHistory::tail` looks for the escape that opens a
/// sequence the cut lands in.
// shortcut: a sequence whose ESC is further back than this (a 70,000-character OSC 52 clipboard
// payload, say) still leaks its tail into an attachment; scan back to a sequence boundary instead
// when long OSC payloads show up in attachments.
const ESCAPE_LOOKBACK_BYTES: usize = 4096;

/// ConPTY alt-screen TUIs redraw with cursor movement instead of newlines, so
/// a line limit alone leaves retention unbounded in bytes. One mebibyte keeps
/// ample replay headroom above the 512 KiB client transcript cap.
const DEFAULT_BYTE_LIMIT: usize = 1_048_576;

/// The cut a released client applies to an attach snapshot: `DEFAULT_MAX_TERMINAL_BUFFER_BYTES`
/// in `packages/client-runtime/src/state/terminalTranscript.ts` (pinned by a test). A history
/// retaining more replays only its last this-many bytes in that client.
const CLIENT_TRANSCRIPT_CUT_BYTES: usize = 512 * 1024;

const BRACKETED_PASTE_ENABLE_SEQUENCE: &str = "\x1b[?2004h";
const MAX_PENDING_ESCAPE_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ModeParseState {
    #[default]
    Ground,
    Esc,
    EscIntermediate,
    Osc,
    StringSeq,
    StringEsc,
    CsiStart,
    CsiParams,
    CsiBang,
    CsiDecPrivate {
        current_param: u32,
        in_subparam: bool,
        has_2004: bool,
    },
    CsiIgnore,
}

/// Streaming VT state machine aligned with xterm.js tracking DEC private mode `?2004h`/`?2004l`
/// (bracketed paste) across arbitrary chunk boundaries, including Unicode C1 CSI (`\u{009b}`),
/// multi-parameter DECSET/DECRST with colon subparameters (`\x1b[?1:2;2004h`), RIS (`\x1bc`),
/// and parameterized DECSTR (`\x1b[0!p` / `\x1b[!p`). Tracks any unfinished control sequence at
/// the end of the stream so mode restoration is inserted at a parser-safe boundary (#431).
#[derive(Clone, Debug, Default)]
struct BracketedPasteModeTracker {
    state: ModeParseState,
    enabled: bool,
    pending_byte_len: usize,
    pending_seq: String,
    pending_truncated: bool,
}

impl BracketedPasteModeTracker {
    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn pending_byte_len(&self) -> usize {
        if self.state == ModeParseState::Ground {
            0
        } else {
            self.pending_byte_len
        }
    }

    fn complete_pending_sequence(&self) -> Option<&str> {
        if self.state == ModeParseState::Ground || self.pending_truncated {
            None
        } else {
            Some(&self.pending_seq)
        }
    }

    fn feed(&mut self, text: &str) {
        for ch in text.chars() {
            self.step(ch);
        }
    }

    fn enter_ground(&mut self) {
        self.state = ModeParseState::Ground;
        self.pending_byte_len = 0;
        self.pending_seq.clear();
        self.pending_truncated = false;
    }

    fn begin_pending(&mut self, ch: char) {
        self.pending_byte_len = ch.len_utf8();
        self.pending_seq.clear();
        self.pending_seq.push(ch);
        self.pending_truncated = false;
    }

    fn append_pending(&mut self, ch: char) {
        let len = ch.len_utf8();
        self.pending_byte_len += len;
        if !self.pending_truncated && self.pending_seq.len() + len <= MAX_PENDING_ESCAPE_BYTES {
            self.pending_seq.push(ch);
        } else {
            self.pending_truncated = true;
        }
    }

    fn step(&mut self, ch: char) {
        // Anywhere transitions per VT500 / xterm.js EscapeSequenceParser.
        match ch {
            '\x18' | '\x1a' | '\u{009c}' => {
                self.enter_ground();
                return;
            }
            '\u{009b}' => {
                self.begin_pending(ch);
                self.state = ModeParseState::CsiStart;
                return;
            }
            '\u{009d}' => {
                self.begin_pending(ch);
                self.state = ModeParseState::Osc;
                return;
            }
            '\u{0090}' | '\u{0098}' | '\u{009e}' | '\u{009f}' => {
                self.begin_pending(ch);
                self.state = ModeParseState::StringSeq;
                return;
            }
            _ => {}
        }

        let code = ch as u32;
        match self.state {
            ModeParseState::Ground => {
                if ch == '\x1b' {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
            }
            ModeParseState::Esc => self.step_esc(ch),
            ModeParseState::EscIntermediate => {
                if ch == '\x1b' {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                } else if (0x20..=0x2f).contains(&code) {
                    self.append_pending(ch);
                } else {
                    self.enter_ground();
                }
            }
            ModeParseState::Osc => match ch {
                '\x07' => self.enter_ground(),
                '\x1b' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::StringEsc;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::StringSeq => match ch {
                '\x1b' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::StringEsc;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::StringEsc => match ch {
                '\\' => self.enter_ground(),
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                other => {
                    self.begin_pending('\x1b');
                    self.step_esc(other);
                }
            },
            ModeParseState::CsiStart => match ch {
                '?' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiDecPrivate {
                        current_param: 0,
                        in_subparam: false,
                        has_2004: false,
                    };
                }
                '!' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiBang;
                }
                '0'..='9' | ';' | ':' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiParams;
                }
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                _ if (0x40..=0x7e).contains(&code) => self.enter_ground(),
                _ if code >= 0x20 => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiIgnore;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::CsiParams => match ch {
                '0'..='9' | ';' | ':' => self.append_pending(ch),
                '!' => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiBang;
                }
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                _ if (0x40..=0x7e).contains(&code) => self.enter_ground(),
                _ if code >= 0x20 => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiIgnore;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::CsiBang => match ch {
                'p' => {
                    // DECSTR (`\x1b[!p` or `\x1b[0!p`) resets DEC private modes including ?2004.
                    self.enabled = false;
                    self.enter_ground();
                }
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                _ if (0x40..=0x7e).contains(&code) => self.enter_ground(),
                _ if code >= 0x20 => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiIgnore;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::CsiDecPrivate {
                mut current_param,
                mut in_subparam,
                mut has_2004,
            } => match ch {
                '0'..='9' => {
                    self.append_pending(ch);
                    if !in_subparam {
                        current_param = current_param
                            .saturating_mul(10)
                            .saturating_add(code - u32::from(b'0'));
                    }
                    self.state = ModeParseState::CsiDecPrivate {
                        current_param,
                        in_subparam,
                        has_2004,
                    };
                }
                ':' => {
                    self.append_pending(ch);
                    in_subparam = true;
                    self.state = ModeParseState::CsiDecPrivate {
                        current_param,
                        in_subparam,
                        has_2004,
                    };
                }
                ';' => {
                    self.append_pending(ch);
                    if current_param == 2004 {
                        has_2004 = true;
                    }
                    self.state = ModeParseState::CsiDecPrivate {
                        current_param: 0,
                        in_subparam: false,
                        has_2004,
                    };
                }
                'h' | 'l' => {
                    if has_2004 || current_param == 2004 {
                        self.enabled = ch == 'h';
                    }
                    self.enter_ground();
                }
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                _ if (0x40..=0x7e).contains(&code) => self.enter_ground(),
                _ if code >= 0x20 => {
                    self.append_pending(ch);
                    self.state = ModeParseState::CsiIgnore;
                }
                _ => self.append_pending(ch),
            },
            ModeParseState::CsiIgnore => match ch {
                '\x1b' => {
                    self.begin_pending(ch);
                    self.state = ModeParseState::Esc;
                }
                _ if (0x40..=0x7e).contains(&code) => self.enter_ground(),
                _ => self.append_pending(ch),
            },
        }
    }

    fn step_esc(&mut self, ch: char) {
        let code = ch as u32;
        match ch {
            'c' => {
                // RIS (`\x1bc`)
                self.enabled = false;
                self.enter_ground();
            }
            '[' => {
                self.append_pending(ch);
                self.state = ModeParseState::CsiStart;
            }
            ']' => {
                self.append_pending(ch);
                self.state = ModeParseState::Osc;
            }
            'P' | '_' | '^' | 'X' => {
                self.append_pending(ch);
                self.state = ModeParseState::StringSeq;
            }
            '\x1b' => {
                self.begin_pending(ch);
                self.state = ModeParseState::Esc;
            }
            _ if (0x20..=0x2f).contains(&code) => {
                self.append_pending(ch);
                self.state = ModeParseState::EscIntermediate;
            }
            _ => self.enter_ground(),
        }
    }
}

/// Why replaying a history may not rebuild the program's screen (#348).
#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LossyReplay {
    /// Output before the retained bytes was evicted or cleared.
    DiscardedPrefix,
    /// Everything is retained, but more than a released client keeps of a snapshot.
    OverClientCut,
}

#[cfg(unix)]
impl LossyReplay {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DiscardedPrefix => "discarded prefix",
            Self::OverClientCut => "over the client cut",
        }
    }
}

/// Bounded, chunked terminal scrollback.
///
/// Each push scans only the new data for line boundaries. Eviction advances an
/// offset through the oldest chunk, so retained text is not shifted on every
/// line. The front chunk is compacted only after its discarded prefix is at
/// least as large as its retained suffix, which bounds unused allocation while
/// keeping compaction work geometric.
#[derive(Debug)]
pub(crate) struct TerminalHistory {
    chunks: VecDeque<HistoryChunk>,
    total_lines: usize,
    line_limit: usize,
    total_bytes: usize,
    byte_limit: usize,
    /// Every byte ever pushed, eviction and clearing included: the end offset of the output,
    /// which a reader's cursor counts in.
    total_bytes_written: u64,
    /// Unique to this history in the process: a restarted or reopened terminal gets a new
    /// history whose offsets start again at 0, so a cursor names its history too.
    epoch: u64,
    /// Cross-platform DEC `?2004h`/`?2004l` state across evicted or cleared prefixes (#431).
    bracketed_paste: BracketedPasteModeTracker,
}

/// Hands out history epochs. It starts at a random value, so another server lifetime (a
/// restart, which reopens terminal ids) never hands out the epochs of this one.
static NEXT_EPOCH: std::sync::LazyLock<std::sync::atomic::AtomicU64> =
    std::sync::LazyLock::new(|| {
        std::sync::atomic::AtomicU64::new(uuid::Uuid::new_v4().as_u64_pair().0)
    });

/// A position in one history's output: its epoch and a byte offset into everything it was
/// ever given. Written `<epoch>:<offset>`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct HistoryCursor {
    pub(crate) epoch: u64,
    pub(crate) offset: u64,
}

impl HistoryCursor {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let (epoch, offset) = text.split_once(':')?;
        Some(Self {
            epoch: epoch.parse().ok()?,
            offset: offset.parse().ok()?,
        })
    }
}

impl std::fmt::Display for HistoryCursor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}:{}", self.epoch, self.offset)
    }
}

/// A run of retained output between two byte offsets of everything ever written.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HistoryWindow {
    pub(crate) text: String,
    /// The history the offsets count in.
    pub(crate) epoch: u64,
    pub(crate) start: u64,
    pub(crate) end: u64,
    /// The requested offset is no longer retained (evicted, cleared, or from another
    /// history), so the window starts at the oldest retained byte instead.
    pub(crate) dropped: bool,
}

#[derive(Debug)]
struct HistoryChunk {
    data: String,
    start: usize,
    newline_count: usize,
}

impl HistoryChunk {
    fn new(data: &str) -> Self {
        Self {
            data: data.to_owned(),
            start: 0,
            newline_count: count_newlines(data),
        }
    }

    fn retained(&self) -> &str {
        &self.data[self.start..]
    }

    fn discard_through_newline(&mut self, count: usize) -> usize {
        debug_assert!(count > 0);
        debug_assert!(count <= self.newline_count);

        let cut = byte_index_after_nth_newline(self.retained(), count);
        self.start += cut;
        self.newline_count -= count;
        self.compact_if_geometric();
        cut
    }

    /// Discards at least `bytes` from the retained prefix, rounding the cut up
    /// to the next character boundary so retention never splits a code point.
    /// Returns the discarded byte and newline counts.
    fn discard_prefix_bytes(&mut self, bytes: usize) -> (usize, usize) {
        let retained = self.retained();
        let mut cut = bytes.min(retained.len());
        while cut < retained.len() && !retained.is_char_boundary(cut) {
            cut += 1;
        }
        let discarded_newlines = count_newlines(&retained[..cut]);
        self.start += cut;
        self.newline_count -= discarded_newlines;
        self.compact_if_geometric();
        (cut, discarded_newlines)
    }

    fn compact_if_geometric(&mut self) {
        let retained_len = self.data.len() - self.start;
        if self.start == 0 || self.start < retained_len {
            return;
        }

        if retained_len == 0 {
            self.data.clear();
        } else {
            self.data = self.data[self.start..].to_owned();
        }
        self.start = 0;
    }

    fn is_empty(&self) -> bool {
        self.retained().is_empty()
    }
}

impl TerminalHistory {
    pub(crate) fn new(line_limit: usize) -> Self {
        Self::with_byte_limit(line_limit, DEFAULT_BYTE_LIMIT)
    }

    pub(crate) fn with_byte_limit(line_limit: usize, byte_limit: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_lines: 0,
            line_limit,
            total_bytes: 0,
            byte_limit,
            total_bytes_written: 0,
            epoch: NEXT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            bracketed_paste: BracketedPasteModeTracker::default(),
        }
    }

    /// The cursor at `offset` of this history.
    #[cfg(test)]
    pub(crate) fn at(&self, offset: u64) -> HistoryCursor {
        HistoryCursor {
            epoch: self.epoch,
            offset,
        }
    }

    pub(crate) fn line_limit(&self) -> usize {
        self.line_limit
    }

    pub(crate) fn total_bytes_written(&self) -> u64 {
        self.total_bytes_written
    }

    /// Whether output before the retained bytes is gone: evicted by a limit, or cleared.
    pub(crate) fn has_discarded_prefix(&self) -> bool {
        self.total_bytes_written > self.total_bytes as u64
    }

    /// Whether the program currently has DEC `?2004h` (bracketed paste mode) enabled.
    #[cfg(test)]
    pub(crate) fn bracketed_paste_enabled(&self) -> bool {
        self.bracketed_paste.is_enabled()
    }

    /// Whether a client replaying this history misses output, and why. O(1): counters only.
    #[cfg(unix)]
    pub(crate) fn lossy_replay(&self) -> Option<LossyReplay> {
        if self.has_discarded_prefix() {
            Some(LossyReplay::DiscardedPrefix)
        } else if self.total_bytes > CLIENT_TRANSCRIPT_CUT_BYTES {
            Some(LossyReplay::OverClientCut)
        } else {
            None
        }
    }

    /// The offset of the oldest retained byte.
    fn oldest(&self) -> u64 {
        self.total_bytes_written - self.total_bytes as u64
    }

    /// At most `max_chars` characters of retained output from `cursor`. A cursor of another
    /// history, or an offset no longer retained or past the end, starts at the oldest retained
    /// byte and reports `dropped`; one inside a character starts at the next character.
    pub(crate) fn read_window(&self, cursor: HistoryCursor, max_chars: usize) -> HistoryWindow {
        let from = cursor.offset;
        let oldest = self.oldest();
        let dropped =
            cursor.epoch != self.epoch || from < oldest || from > self.total_bytes_written;
        let mut skip = if dropped {
            0
        } else {
            usize::try_from(from - oldest).unwrap_or(usize::MAX)
        };
        let mut start = if dropped { oldest } else { from };
        let mut text = String::new();
        let mut remaining = max_chars;
        for chunk in &self.chunks {
            let retained = chunk.retained();
            if skip >= retained.len() {
                skip -= retained.len();
                continue;
            }
            let mut offset = skip;
            while !retained.is_char_boundary(offset) {
                offset += 1;
            }
            start += (offset - skip) as u64;
            skip = 0;
            let piece = &retained[offset..];
            let taken = piece
                .char_indices()
                .nth(remaining)
                .map_or(piece.len(), |(index, _)| index);
            text.push_str(&piece[..taken]);
            remaining -= piece[..taken].chars().count();
            if remaining == 0 {
                break;
            }
        }
        let end = start + text.len() as u64;
        HistoryWindow {
            text,
            epoch: self.epoch,
            start,
            end,
            dropped,
        }
    }

    /// The last `max_chars` characters of retained output, ending at the total.
    pub(crate) fn tail(&self, max_chars: usize) -> HistoryWindow {
        let mut pieces = Vec::new();
        let mut remaining = max_chars;
        for chunk in self.chunks.iter().rev() {
            if remaining == 0 {
                break;
            }
            let retained = chunk.retained();
            let cut = retained
                .char_indices()
                .rev()
                .nth(remaining.saturating_sub(1))
                .map_or(0, |(index, _)| index);
            let piece = &retained[cut..];
            remaining -= piece.chars().count().min(remaining);
            pieces.push(piece);
        }
        let mut text: String = pieces.into_iter().rev().collect();
        match self.cut_sequence_len(&text) {
            Ok(inside) => {
                text.drain(..inside);
            }
            // A sequence still arriving: the window starts at its ESC and holds it whole, so a
            // reader sees one unfinished escape, which it keeps its cursor before.
            Err(started) => {
                let cut = self.total_bytes - text.len();
                text.insert_str(0, &self.retained_range(cut - started, cut));
            }
        }
        HistoryWindow {
            epoch: self.epoch,
            start: self.total_bytes_written - text.len() as u64,
            end: self.total_bytes_written,
            text,
            dropped: false,
        }
    }

    /// How many leading bytes of `tail`, the end of the retained output, belong to an escape
    /// sequence that starts before it, so a reader never sees half a sequence as text. A
    /// sequence that has not ended yet is `Err` with how many bytes before `tail` it starts.
    fn cut_sequence_len(&self, tail: &str) -> Result<usize, usize> {
        let cut = self.total_bytes - tail.len();
        let before = self.retained_range(cut.saturating_sub(ESCAPE_LOOKBACK_BYTES), cut);
        let Some(escape) = before.rfind('\x1b') else {
            return Ok(0);
        };
        let started = before.len() - escape;
        let joined = [&before[escape..], tail].concat();
        crate::ansi::escape_end(joined.as_bytes(), 0)
            .map(|end| end.saturating_sub(started))
            .ok_or(started)
    }

    /// The retained bytes from `from` to `to`, counted from the oldest retained byte, widened
    /// at the start to a character boundary.
    fn retained_range(&self, from: usize, to: usize) -> String {
        let mut text = String::new();
        let mut offset = 0;
        for chunk in &self.chunks {
            let retained = chunk.retained();
            let (start, end) = (from.max(offset), to.min(offset + retained.len()));
            if start < end {
                let mut local = start - offset;
                while !retained.is_char_boundary(local) {
                    local += 1;
                }
                text.push_str(&retained[local..end - offset]);
            }
            offset += retained.len();
            if offset >= to {
                break;
            }
        }
        text
    }

    pub(crate) fn push(&mut self, data: &str) {
        self.total_bytes_written += data.len() as u64;
        self.bracketed_paste.feed(data);
        if self.line_limit == 0 || self.byte_limit == 0 {
            self.clear();
            return;
        }
        if data.is_empty() {
            return;
        }

        let chunk = HistoryChunk::new(data);
        self.total_lines += chunk.newline_count;
        self.total_bytes += data.len();
        self.chunks.push_back(chunk);
        self.evict();
    }

    pub(crate) fn clear(&mut self) {
        self.chunks = VecDeque::new();
        self.total_lines = 0;
        self.total_bytes = 0;
    }

    pub(crate) fn snapshot(&self) -> String {
        let capacity = self.chunks.iter().map(|chunk| chunk.retained().len()).sum();
        let mut snapshot = String::with_capacity(capacity);
        for chunk in &self.chunks {
            snapshot.push_str(chunk.retained());
        }
        snapshot
    }

    /// Snapshot for replaying into a terminal renderer. For a running session whose active
    /// `?2004h` sequence may have been evicted, cleared, or truncated past the client's 512 KiB
    /// buffer cap, inserts `\x1b[?2004h` at a parser-safe boundary BEFORE any trailing unfinished
    /// control sequence (and preserves that unfinished prefix across clears) so the next live
    /// delta completes it identically to an uninterrupted terminal (#431).
    pub(crate) fn snapshot_for_replay(&self, running: bool) -> String {
        let mut snapshot = self.snapshot();
        if !running {
            return snapshot;
        }
        let lossy = self.has_discarded_prefix() || self.total_bytes > CLIENT_TRANSCRIPT_CUT_BYTES;
        if !lossy {
            return snapshot;
        }
        let restore = if self.bracketed_paste.is_enabled() {
            BRACKETED_PASTE_ENABLE_SEQUENCE
        } else {
            ""
        };
        let pending_len = self.bracketed_paste.pending_byte_len();
        if pending_len > 0 {
            // When the entire unfinished control sequence is still retained at the tail of
            // `snapshot` (even if longer than MAX_PENDING_ESCAPE_BYTES, e.g. a 200+ char OSC),
            // insert `?2004h` at its exact boundary without duplicating or truncating it.
            if let Some(split) = snapshot.len().checked_sub(pending_len)
                && snapshot.is_char_boundary(split)
            {
                if !restore.is_empty() {
                    snapshot.insert_str(split, restore);
                }
                return snapshot;
            }
            // Otherwise the sequence opener was cleared or evicted: replay it only if untruncated
            // (replacing any retained suffix of the same sequence so nothing is duplicated).
            if let Some(pending) = self.bracketed_paste.complete_pending_sequence() {
                let mut rebuilt = String::with_capacity(restore.len() + pending.len());
                rebuilt.push_str(restore);
                rebuilt.push_str(pending);
                return rebuilt;
            }
            if !restore.is_empty() {
                snapshot.insert_str(0, restore);
            }
            return snapshot;
        }
        snapshot.push_str(restore);
        snapshot
    }

    fn evict(&mut self) {
        let chunks_before_eviction = self.chunks.len();
        while self.total_lines > self.line_limit {
            let overflow = self.total_lines - self.line_limit;
            let Some(front_lines) = self.chunks.front().map(|chunk| chunk.newline_count) else {
                break;
            };

            // If the cut falls after this chunk, its trailing partial line is
            // part of an evicted line too. If the cut lands on this chunk's
            // final newline, however, the trailing partial must be retained.
            if front_lines < overflow {
                let removed = self.chunks.pop_front().expect("front chunk exists");
                self.total_lines -= removed.newline_count;
                self.total_bytes -= removed.retained().len();
                continue;
            }

            let front = self.chunks.front_mut().expect("front chunk exists");
            let discarded_bytes = front.discard_through_newline(overflow);
            self.total_lines -= overflow;
            self.total_bytes -= discarded_bytes;
            if front.is_empty() {
                self.chunks.pop_front();
            }
        }
        while self.total_bytes > self.byte_limit {
            if self.chunks.len() > 1 {
                let removed = self.chunks.pop_front().expect("front chunk exists");
                self.total_lines -= removed.newline_count;
                self.total_bytes -= removed.retained().len();
                continue;
            }
            let Some(front) = self.chunks.front_mut() else {
                break;
            };
            let overflow_bytes = self.total_bytes - self.byte_limit;
            let (discarded_bytes, discarded_newlines) = front.discard_prefix_bytes(overflow_bytes);
            self.total_lines -= discarded_newlines;
            self.total_bytes -= discarded_bytes;
            if front.is_empty() {
                self.chunks.pop_front();
            }
            break;
        }
        self.compact_chunk_slots_after_eviction(chunks_before_eviction);
    }

    fn compact_chunk_slots_after_eviction(&mut self, chunks_before_eviction: usize) {
        if self.chunks.len() == chunks_before_eviction {
            return;
        }
        if self.chunks.is_empty() {
            self.chunks = VecDeque::new();
            return;
        }
        // Shrinking only at quarter occupancy leaves a full growth step of
        // hysteresis after `shrink_to_fit`: a steady push may grow the deque
        // to twice the live length, but the following eviction will not
        // immediately shrink it again.
        if self.chunks.len() <= self.chunks.capacity() / DEQUE_SHRINK_OCCUPANCY_DENOMINATOR {
            self.chunks.shrink_to_fit();
        }
    }
}

fn count_newlines(data: &str) -> usize {
    data.as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
}

/// Byte index just after the `count`-th newline.
///
/// A newline is one UTF-8 byte, so the returned index is always a character
/// boundary. Callers guarantee that the requested newline exists.
fn byte_index_after_nth_newline(data: &str, count: usize) -> usize {
    let mut remaining = count;
    for (index, byte) in data.bytes().enumerate() {
        if byte != b'\n' {
            continue;
        }
        remaining -= 1;
        if remaining == 0 {
            return index + 1;
        }
    }
    unreachable!("requested newline must exist")
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::LossyReplay;
    use super::{CLIENT_TRANSCRIPT_CUT_BYTES, HistoryCursor, TerminalHistory};

    fn legacy_push(history: &mut String, data: &str, line_limit: usize) {
        history.push_str(data);
        if line_limit == 0 {
            history.clear();
            return;
        }
        let line_count = history
            .as_bytes()
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
        if line_count <= line_limit {
            return;
        }
        let mut lines_to_remove = line_count - line_limit;
        let truncate_at = history
            .char_indices()
            .find_map(|(index, character)| {
                if character != '\n' {
                    return None;
                }
                lines_to_remove -= 1;
                (lines_to_remove == 0).then_some(index + character.len_utf8())
            })
            .unwrap_or(0);
        history.drain(..truncate_at);
    }

    #[test]
    fn matches_the_legacy_line_drain_behavior() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nthree\n");
        history.push("four\n");
        assert_eq!(history.snapshot(), "three\nfour\n");
    }

    #[test]
    fn preserves_a_partial_line_when_its_chunk_also_contains_the_evicted_line() {
        let mut history = TerminalHistory::new(1);
        history.push("old\nprompt ");
        history.push("new\n");
        assert_eq!(history.snapshot(), "prompt new\n");
    }

    #[test]
    fn recognizes_line_boundaries_split_across_pushes() {
        let mut history = TerminalHistory::new(2);
        history.push("one");
        history.push("\ntw");
        history.push("o\nthr");
        history.push("ee\nprompt");
        assert_eq!(history.snapshot(), "two\nthree\nprompt");
    }

    #[test]
    fn preserves_crlf_bytes_while_counting_lf_boundaries() {
        let mut history = TerminalHistory::new(1);
        history.push("old\r\nprompt ");
        history.push("next\r");
        history.push("\n");
        assert_eq!(history.snapshot(), "prompt next\r\n");
    }

    #[test]
    fn keeps_multibyte_characters_intact_across_eviction() {
        let mut history = TerminalHistory::new(1);
        history.push("héllo\n");
        history.push("wörld");
        history.push(" 🌍\n");
        assert_eq!(history.snapshot(), "wörld 🌍\n");
    }

    #[test]
    fn newline_free_output_is_bounded_by_the_byte_limit() {
        let mut history = TerminalHistory::with_byte_limit(5_000, 1_024);
        let chunk = "x".repeat(64);
        for _ in 0..100 {
            history.push(&chunk);
        }
        let snapshot = history.snapshot();
        assert!(
            snapshot.len() <= 1_024,
            "snapshot retained {} bytes",
            snapshot.len()
        );
        assert!(snapshot.ends_with(&chunk));
    }

    #[test]
    fn byte_eviction_discards_prefixes_at_character_boundaries() {
        let mut history = TerminalHistory::with_byte_limit(5_000, 32);
        history.push(&"é".repeat(40));
        let snapshot = history.snapshot();
        assert!(
            snapshot.len() <= 32,
            "snapshot retained {} bytes",
            snapshot.len()
        );
        assert!(!snapshot.is_empty());
        assert!(snapshot.chars().all(|character| character == 'é'));
    }

    #[test]
    fn byte_eviction_keeps_line_accounting_consistent() {
        let mut history = TerminalHistory::with_byte_limit(2, 10);
        history.push("aaaa\n");
        history.push("bbbb\n");
        history.push("c\n");
        // Byte eviction removed "aaaa\n" and its newline; the remaining two
        // lines fit the line limit, so nothing else may be discarded.
        assert_eq!(history.snapshot(), "bbbb\nc\n");
    }

    #[test]
    fn empty_input_is_a_no_op() {
        let mut history = TerminalHistory::new(1);
        history.push("prompt ");
        history.push("");
        assert_eq!(history.snapshot(), "prompt ");
    }

    #[test]
    fn zero_limit_never_retains_output() {
        let mut history = TerminalHistory::new(0);
        history.push("ignored\nprompt");
        assert!(history.snapshot().is_empty());
        assert_eq!(history.line_limit(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_complete_history_under_the_client_cut_replays_without_loss() {
        let mut history = TerminalHistory::new(5_000);
        assert_eq!(history.lossy_replay(), None);
        history.push(&"x".repeat(CLIENT_TRANSCRIPT_CUT_BYTES));
        assert!(!history.has_discarded_prefix());
        assert_eq!(history.lossy_replay(), None);
    }

    #[cfg(unix)]
    #[test]
    fn eviction_and_clearing_leave_a_discarded_prefix() {
        let mut evicted = TerminalHistory::new(2);
        evicted.push("one\ntwo\nthree\n");
        assert!(evicted.has_discarded_prefix());
        assert_eq!(evicted.lossy_replay(), Some(LossyReplay::DiscardedPrefix));

        let mut by_bytes = TerminalHistory::with_byte_limit(5_000, 4);
        by_bytes.push("abcdef");
        assert_eq!(by_bytes.lossy_replay(), Some(LossyReplay::DiscardedPrefix));

        let mut cleared = TerminalHistory::new(5_000);
        cleared.clear();
        assert_eq!(cleared.lossy_replay(), None, "nothing was ever written");
        cleared.push("prompt");
        cleared.clear();
        cleared.push("fresh");
        assert_eq!(cleared.lossy_replay(), Some(LossyReplay::DiscardedPrefix));
    }

    #[cfg(unix)]
    #[test]
    fn a_complete_history_over_the_client_cut_is_lossy_for_a_released_client() {
        let mut history = TerminalHistory::new(5_000);
        history.push(&"x".repeat(CLIENT_TRANSCRIPT_CUT_BYTES + 1));
        assert!(!history.has_discarded_prefix());
        assert_eq!(history.lossy_replay(), Some(LossyReplay::OverClientCut));
    }

    /// The server's cut must track the client's: a change to either breaks this.
    #[cfg(unix)]
    #[test]
    fn the_client_cut_matches_the_client_transcript_default() {
        let client =
            include_str!("../../../../packages/client-runtime/src/state/terminalTranscript.ts");
        assert!(
            client.contains("export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;"),
            "the client transcript default changed; update CLIENT_TRANSCRIPT_CUT_BYTES"
        );
        assert_eq!(CLIENT_TRANSCRIPT_CUT_BYTES, 512 * 1024);
    }

    #[test]
    fn clear_discards_output_without_changing_the_limit() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nprompt");
        history.clear();
        assert!(history.snapshot().is_empty());
        assert_eq!(history.line_limit(), 2);

        history.push("fresh\n");
        assert_eq!(history.snapshot(), "fresh\n");
    }

    #[test]
    fn evicts_whole_chunks_before_trimming_a_prefix() {
        let mut history = TerminalHistory::new(3);
        history.push("a\n");
        history.push("b\n");
        history.push("c\n");
        history.push("d\ne\n");
        assert_eq!(history.snapshot(), "c\nd\ne\n");
    }

    #[test]
    fn trims_a_prefix_within_a_single_large_chunk() {
        let mut history = TerminalHistory::new(2);
        history.push("l1\nl2\nl3\nl4\n");
        assert_eq!(history.snapshot(), "l3\nl4\n");
    }

    #[test]
    fn preserves_five_thousand_line_semantics_over_many_pushes() {
        let mut history = TerminalHistory::new(5_000);
        for index in 0..10_000 {
            history.push(&format!("line-{index}\n"));
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot.matches('\n').count(), 5_000);
        assert!(snapshot.starts_with("line-5000\n"));
        assert!(snapshot.ends_with("line-9999\n"));
    }

    #[test]
    fn releases_peak_deque_capacity_after_mass_eviction_and_clear() {
        let mut history = TerminalHistory::new(1);
        for _ in 0..4_096 {
            history.push("x");
        }
        history.push("\n");
        let peak_capacity = history.chunks.capacity();
        assert!(peak_capacity >= 4_096);

        history.push("z\n");
        assert_eq!(history.snapshot(), "z\n");
        assert!(
            history.chunks.capacity() <= 8,
            "mass eviction retained capacity {} from peak {peak_capacity}",
            history.chunks.capacity()
        );

        history.clear();
        assert_eq!(history.chunks.capacity(), 0);
        history.push("fresh\n");
        assert_eq!(history.snapshot(), "fresh\n");
        assert!(history.chunks.capacity() <= 8);
    }

    #[test]
    fn steady_state_eviction_preserves_deque_capacity_hysteresis() {
        let mut history = TerminalHistory::new(1_024);
        for _ in 0..1_024 {
            history.push("x\n");
        }

        history.push("y\n");
        let steady_capacity = history.chunks.capacity();
        assert_eq!(history.chunks.len(), 1_024);
        assert!(
            steady_capacity > history.chunks.len(),
            "eviction shrank the deque back to a full allocation"
        );

        for _ in 0..128 {
            history.push("z\n");
            assert_eq!(history.chunks.len(), 1_024);
            assert_eq!(
                history.chunks.capacity(),
                steady_capacity,
                "steady push/evict cycle changed deque capacity"
            );
        }
    }

    #[test]
    fn matches_the_reference_model_across_deterministic_chunkings() {
        let chunkings = [
            vec!["α\r\nbravo\ncharlie🙂\nΔpartial"],
            vec![
                "α", "\r", "\n", "br", "avo\nch", "arlie", "🙂", "\nΔ", "partial",
            ],
            vec!["", "α\r", "\nbravo", "\ncharlie🙂", "\n", "Δpartial", ""],
        ];

        for line_limit in 0..=4 {
            for chunks in &chunkings {
                let mut expected = String::new();
                let mut actual = TerminalHistory::new(line_limit);
                for chunk in chunks {
                    legacy_push(&mut expected, chunk, line_limit);
                    actual.push(chunk);
                    assert_eq!(
                        actual.snapshot(),
                        expected,
                        "line_limit={line_limit}, chunk={chunk:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_window_reads_forward_from_a_cursor_and_counts_every_byte_written() {
        let mut history = TerminalHistory::new(100);
        history.push("one\n");
        history.push("twö\n");
        assert_eq!(history.total_bytes_written(), 9);
        let all = history.read_window(history.at(0), 100);
        assert_eq!(
            (all.text.as_str(), all.start, all.end),
            ("one\ntwö\n", 0, 9)
        );
        assert!(!all.dropped);
        let rest = history.read_window(history.at(4), 100);
        assert_eq!((rest.text.as_str(), rest.start, rest.end), ("twö\n", 4, 9));
        // At most `max_chars` characters, ending on a character boundary.
        let page = history.read_window(history.at(4), 3);
        assert_eq!((page.text.as_str(), page.end), ("twö", 8));
        // Nothing new past the end.
        let caught_up = history.read_window(history.at(9), 100);
        assert_eq!(
            (caught_up.text.as_str(), caught_up.start, caught_up.end),
            ("", 9, 9)
        );
        // A cursor inside a character starts at the next one.
        let inside = history.read_window(history.at(7), 100);
        assert_eq!((inside.text.as_str(), inside.start), ("\n", 8));
    }

    #[test]
    fn an_evicted_cursor_reports_dropped_and_starts_at_the_oldest_retained_byte() {
        let mut history = TerminalHistory::new(5_000);
        history.push("first\n");
        let cursor = history.total_bytes_written();
        let block = "x".repeat(64 * 1024);
        for _ in 0..17 {
            history.push(&block);
        }
        assert!(history.total_bytes_written() > 1_048_576 + cursor);
        let window = history.read_window(history.at(cursor), 10);
        assert!(window.dropped);
        let oldest = history.total_bytes_written() - history.snapshot().len() as u64;
        assert_eq!(window.start, oldest);
        assert_eq!(window.text, "x".repeat(10));
        // Clearing keeps the count, so an old cursor is dropped, never reused.
        history.clear();
        let after = history.total_bytes_written();
        let cleared = history.read_window(history.at(cursor), 10);
        assert!(cleared.dropped);
        assert_eq!(
            (cleared.start, cleared.end, cleared.text.as_str()),
            (after, after, "")
        );
        history.push("new");
        assert_eq!(history.read_window(history.at(after), 10).text, "new");
    }

    #[test]
    fn a_cursor_past_the_end_is_dropped_and_starts_at_the_oldest_byte() {
        let mut history = TerminalHistory::new(100);
        history.push("fresh");
        let window = history.read_window(history.at(1_000), 100);
        assert!(window.dropped);
        assert_eq!((window.start, window.text.as_str()), (0, "fresh"));
    }

    /// Two server lifetimes never hand out the same epoch, so a cursor kept across a restart
    /// cannot match a reopened terminal's history (#139 slice T review, round 3). Each phase
    /// runs in a process of its own and writes its first epoch to a file.
    #[test]
    fn epochs_differ_across_server_lifetimes() {
        const NAME: &str = "terminal::history::tests::epochs_differ_across_server_lifetimes";
        const FILE: &str = "BIBCODE_TEST_EPOCH_FILE";
        for phase in ["first", "second"] {
            if let Some(child) = crate::test_support::reexec::enter(NAME, phase) {
                let epoch = TerminalHistory::new(1).at(0).epoch;
                std::fs::write(std::env::var(FILE).expect("epoch file"), epoch.to_string())
                    .expect("epoch written");
                child.complete();
                return;
            }
        }
        let directory = tempfile::tempdir().expect("epoch directory");
        let epochs: Vec<String> = ["first", "second"]
            .into_iter()
            .map(|phase| {
                let file = directory.path().join(phase);
                crate::test_support::reexec::run(NAME, phase, None, |command| {
                    command.env(FILE, &file);
                });
                std::fs::read_to_string(file).expect("epoch read")
            })
            .collect();
        assert_ne!(epochs[0], epochs[1]);
    }

    #[test]
    fn a_cursor_from_another_history_is_dropped_even_inside_its_range() {
        // A restarted or reopened terminal has a new history whose offsets start again at 0,
        // so an earlier session's cursor can land inside the new range.
        let mut before = TerminalHistory::new(100);
        before.push("old\n");
        let stale = before.at(before.total_bytes_written());
        let mut after = TerminalHistory::new(100);
        after.push("new output\n");
        assert_ne!(stale.epoch, after.at(0).epoch);
        let window = after.read_window(stale, 100);
        assert!(window.dropped);
        assert_eq!((window.start, window.text.as_str()), (0, "new output\n"));
        assert_eq!(window.epoch, after.at(0).epoch);
        // A cursor round-trips through its text form.
        let cursor = after.at(window.end);
        assert_eq!(HistoryCursor::parse(&cursor.to_string()), Some(cursor));
        assert_eq!(HistoryCursor::parse("12"), None);
        assert_eq!(HistoryCursor::parse("a:1"), None);
    }

    #[test]
    fn the_tail_is_the_last_characters_and_ends_at_the_total() {
        let mut history = TerminalHistory::new(100);
        history.push("abc\n");
        history.push("déf");
        let tail = history.tail(4);
        assert_eq!((tail.text.as_str(), tail.start, tail.end), ("\ndéf", 3, 8));
        assert!(!tail.dropped);
        assert_eq!(tail.epoch, history.at(0).epoch);
        let all = history.tail(100);
        assert_eq!((all.text.as_str(), all.start), ("abc\ndéf", 0));
    }

    #[test]
    fn the_tail_never_starts_inside_an_escape_sequence() {
        let mut history = TerminalHistory::new(100);
        history.push("old\x1b[38;2;");
        history.push("255;0;0mred\x1b]0;a title\x07done");
        // Each limit cuts inside a sequence: the colour, then the title.
        for (limit, expected) in [(24, "red\x1b]0;a title\x07done"), (10, "done")] {
            let tail = history.tail(limit);
            assert_eq!(tail.text, expected, "a tail of {limit}");
            assert_eq!(tail.start, tail.end - tail.text.len() as u64);
        }
        let plain = crate::send_requests::service::plain_tail(&history.tail(24).text, true, 100);
        assert_eq!(plain.text, "reddone");
    }

    #[test]
    fn bracketed_paste_mode_survives_eviction_clear_and_over_client_cut_while_respecting_resets() {
        let mut history = TerminalHistory::with_byte_limit(4, 64);
        // Chunk-split multi-parameter DECSET enabling ?2004h, plus OSC strings (BEL and ST).
        history.push("\x1b[?1049;");
        history.push("2004;1004h");
        history.push("\x1b]0;title [?2004l ignored\x07");
        history.push("\x1b]2;st title [?2004l\x1b\\");
        history.push("1\n2\n3\n4\n5\n6\n");
        assert!(history.bracketed_paste_enabled());
        assert!(history.snapshot_for_replay(true).ends_with("\x1b[?2004h"));
        // Exited sessions must not inject ?2004h.
        assert!(!history.snapshot_for_replay(false).ends_with("\x1b[?2004h"));

        // Clear keeps ?2004h active for a running session.
        history.clear();
        assert_eq!(history.snapshot_for_replay(true), "\x1b[?2004h");
        assert_eq!(history.snapshot_for_replay(false), "");

        // DECRQM query (?2004$p) must NOT disable ?2004h.
        history.push("\x1b[?2004$p");
        assert!(history.bracketed_paste_enabled());

        // DECSTR (\x1b[!p) disables ?2004h.
        history.push("\x1b[!p");
        assert!(!history.bracketed_paste_enabled());
        assert!(!history.snapshot_for_replay(true).ends_with("\x1b[?2004h"));

        // Re-enable with leading zero (?02004h), then RIS (\x1bc) disables it.
        history.push("\x1b[?02004h");
        assert!(history.bracketed_paste_enabled());
        history.push("\x1bc");
        assert!(!history.bracketed_paste_enabled());

        // Re-enable, then DECRST (?2004l) disables it.
        history.push("\x1b[?2004h");
        assert!(history.bracketed_paste_enabled());
        history.push("\x1b[?1000;2004l");
        assert!(!history.bracketed_paste_enabled());

        // Over-512 KiB retained history (no server eviction yet) appends ?2004h at the end so
        // clients applying the 512 KiB suffix cut still enable bracketed paste on replay.
        let mut large = TerminalHistory::with_byte_limit(100_000, 1024 * 1024);
        large.push("\x1b[?2004h");
        large.push(&"x".repeat(CLIENT_TRANSCRIPT_CUT_BYTES + 1024));
        assert!(!large.has_discarded_prefix());
        assert!(large.snapshot_for_replay(true).ends_with("\x1b[?2004h"));

        // Xterm parser parity: C1 CSI (`\u{009b}?2004h`), colon subparameter (`\x1b[?1:2;2004h`),
        // parameterized DECSTR (`\x1b[0!p`), and mid-sequence replay / clear boundaries.
        let mut c1 = TerminalHistory::with_byte_limit(4, 32);
        c1.push("\u{009b}?2004h");
        c1.push(&"a".repeat(64));
        assert!(c1.bracketed_paste_enabled());
        assert!(c1.snapshot_for_replay(true).ends_with("\x1b[?2004h"));

        let mut subparam = TerminalHistory::with_byte_limit(4, 32);
        subparam.push("\x1b[?1:2;2004h");
        subparam.push(&"b".repeat(64));
        assert!(subparam.bracketed_paste_enabled());
        assert!(subparam.snapshot_for_replay(true).ends_with("\x1b[?2004h"));
        subparam.push("\x1b[0!p");
        subparam.push(&"c".repeat(64));
        assert!(!subparam.bracketed_paste_enabled());
        assert!(!subparam.snapshot_for_replay(true).ends_with("\x1b[?2004h"));

        let mut mid_disable = TerminalHistory::with_byte_limit(4, 32);
        mid_disable.push("\x1b[?2004h");
        mid_disable.push(&"d".repeat(64));
        mid_disable.push("\x1b[?20");
        assert!(
            mid_disable
                .snapshot_for_replay(true)
                .ends_with("\x1b[?2004h\x1b[?20")
        );

        let mut mid_enable_clear = TerminalHistory::with_byte_limit(4, 32);
        mid_enable_clear.push("\x1b[?20");
        mid_enable_clear.clear();
        assert_eq!(mid_enable_clear.snapshot_for_replay(true), "\x1b[?20");

        // Long (>128 byte) unfinished OSC sequence after eviction inserts `?2004h` at the exact
        // sequence boundary without duplicating or truncating the OSC opener.
        let long_osc = format!("\x1b]0;{}", "t".repeat(200));
        let mut long_with_mode = TerminalHistory::with_byte_limit(100, 512);
        long_with_mode.push("\x1b[?2004h");
        long_with_mode.push(&"x".repeat(400));
        long_with_mode.push(&long_osc);
        let long_snap = long_with_mode.snapshot_for_replay(true);
        assert!(long_snap.ends_with(&format!("\x1b[?2004h{long_osc}")));
        assert_eq!(long_snap.matches("\x1b]0;").count(), 1);

        let mut long_without_mode = TerminalHistory::with_byte_limit(100, 512);
        long_without_mode.push(&"x".repeat(400));
        long_without_mode.push(&long_osc);
        let long_no_mode_snap = long_without_mode.snapshot_for_replay(true);
        assert!(long_no_mode_snap.ends_with(&long_osc));
        assert_eq!(long_no_mode_snap.matches("\x1b]0;").count(), 1);

        // Unfinished OSC larger than the entire history byte limit restores `?2004h` at the start
        // without appending a truncated duplicate OSC opener.
        let mut oversized_osc = TerminalHistory::with_byte_limit(100, 64);
        oversized_osc.push("\x1b[?2004h");
        oversized_osc.push(&long_osc);
        let oversized_snap = oversized_osc.snapshot_for_replay(true);
        assert!(oversized_snap.starts_with("\x1b[?2004h"));
        assert!(!oversized_snap.contains("\x1b]0;"));
    }
}
