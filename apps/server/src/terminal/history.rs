use std::collections::VecDeque;

const DEQUE_SHRINK_OCCUPANCY_DENOMINATOR: usize = 4;

/// ConPTY alt-screen TUIs redraw with cursor movement instead of newlines, so
/// a line limit alone leaves retention unbounded in bytes. One mebibyte keeps
/// ample replay headroom above the 512 KiB client transcript cap.
const DEFAULT_BYTE_LIMIT: usize = 1_048_576;

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
}

/// A run of retained output between two byte offsets of everything ever written.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HistoryWindow {
    pub(crate) text: String,
    pub(crate) start: u64,
    pub(crate) end: u64,
    /// The requested offset is no longer retained (evicted, cleared, or from an earlier
    /// session), so the window starts at the oldest retained byte instead.
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
        }
    }

    pub(crate) fn line_limit(&self) -> usize {
        self.line_limit
    }

    pub(crate) fn total_bytes_written(&self) -> u64 {
        self.total_bytes_written
    }

    /// The offset of the oldest retained byte.
    fn oldest(&self) -> u64 {
        self.total_bytes_written - self.total_bytes as u64
    }

    /// At most `max_chars` characters of retained output from offset `from`. An offset no
    /// longer retained, or past the end, starts at the oldest retained byte and reports
    /// `dropped`; one inside a character starts at the next character.
    pub(crate) fn read_window(&self, from: u64, max_chars: usize) -> HistoryWindow {
        let oldest = self.oldest();
        let dropped = from < oldest || from > self.total_bytes_written;
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
        let text: String = pieces.into_iter().rev().collect();
        HistoryWindow {
            start: self.total_bytes_written - text.len() as u64,
            end: self.total_bytes_written,
            text,
            dropped: false,
        }
    }

    pub(crate) fn push(&mut self, data: &str) {
        self.total_bytes_written += data.len() as u64;
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
    use super::TerminalHistory;

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
        let all = history.read_window(0, 100);
        assert_eq!(
            (all.text.as_str(), all.start, all.end),
            ("one\ntwö\n", 0, 9)
        );
        assert!(!all.dropped);
        let rest = history.read_window(4, 100);
        assert_eq!((rest.text.as_str(), rest.start, rest.end), ("twö\n", 4, 9));
        // At most `max_chars` characters, ending on a character boundary.
        let page = history.read_window(4, 3);
        assert_eq!((page.text.as_str(), page.end), ("twö", 8));
        // Nothing new past the end.
        let caught_up = history.read_window(9, 100);
        assert_eq!(
            (caught_up.text.as_str(), caught_up.start, caught_up.end),
            ("", 9, 9)
        );
        // A cursor inside a character starts at the next one.
        let inside = history.read_window(7, 100);
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
        let window = history.read_window(cursor, 10);
        assert!(window.dropped);
        let oldest = history.total_bytes_written() - history.snapshot().len() as u64;
        assert_eq!(window.start, oldest);
        assert_eq!(window.text, "x".repeat(10));
        // Clearing keeps the count, so an old cursor is dropped, never reused.
        history.clear();
        let after = history.total_bytes_written();
        let cleared = history.read_window(cursor, 10);
        assert!(cleared.dropped);
        assert_eq!(
            (cleared.start, cleared.end, cleared.text.as_str()),
            (after, after, "")
        );
        history.push("new");
        assert_eq!(history.read_window(after, 10).text, "new");
    }

    #[test]
    fn a_cursor_past_the_end_is_dropped_and_starts_at_the_oldest_byte() {
        // A restarted terminal has a new history, so an old session's cursor can lie ahead.
        let mut history = TerminalHistory::new(100);
        history.push("fresh");
        let window = history.read_window(1_000, 100);
        assert!(window.dropped);
        assert_eq!((window.start, window.text.as_str()), (0, "fresh"));
    }

    #[test]
    fn the_tail_is_the_last_characters_and_ends_at_the_total() {
        let mut history = TerminalHistory::new(100);
        history.push("abc\n");
        history.push("déf");
        let tail = history.tail(4);
        assert_eq!((tail.text.as_str(), tail.start, tail.end), ("\ndéf", 3, 8));
        assert!(!tail.dropped);
        let all = history.tail(100);
        assert_eq!((all.text.as_str(), all.start), ("abc\ndéf", 0));
    }
}
