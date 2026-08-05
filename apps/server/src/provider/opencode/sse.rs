use serde_json::Value;

pub(crate) const OPENCODE_SSE_BUFFER_LIMIT: usize = 1024 * 1024;
pub(crate) const OPENCODE_SSE_EVENT_LIMIT: usize = 256 * 1024;
const MAX_BOUNDARY_PREFIX_LENGTH: usize = 3;

fn frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

#[derive(Debug, Default)]
pub(crate) struct OpenCodeSseDecoder {
    buffer: Vec<u8>,
    discarding_oversized_frame: bool,
}

impl OpenCodeSseDecoder {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self
            .buffer
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > OPENCODE_SSE_BUFFER_LIMIT)
        {
            self.buffer.clear();
            self.discarding_oversized_frame = true;
            return Err("OpenCode SSE buffer exceeded its bound".to_owned());
        }
        self.buffer.extend_from_slice(chunk);
        Ok(())
    }

    pub(crate) fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    pub(crate) fn discard_event(&mut self) -> Result<bool, String> {
        if self.discarding_oversized_frame {
            let Some((index, delimiter)) = frame_boundary(&self.buffer) else {
                self.compact_discard_prefix();
                return Ok(false);
            };
            self.buffer.drain(..index + delimiter);
            self.discarding_oversized_frame = false;
            return Ok(true);
        }

        let Some((index, delimiter)) = frame_boundary(&self.buffer) else {
            if self.buffer.len() <= OPENCODE_SSE_EVENT_LIMIT {
                return Ok(false);
            }
            self.discarding_oversized_frame = true;
            self.compact_discard_prefix();
            return Err("OpenCode SSE event exceeded its bound".to_owned());
        };
        self.buffer.drain(..index + delimiter);
        if index > OPENCODE_SSE_EVENT_LIMIT {
            return Err("OpenCode SSE event exceeded its bound".to_owned());
        }
        Ok(true)
    }

    pub(crate) fn take_data(&mut self) -> Result<Option<Vec<u8>>, String> {
        if self.discarding_oversized_frame {
            let Some((index, delimiter)) = frame_boundary(&self.buffer) else {
                self.compact_discard_prefix();
                return Ok(None);
            };
            self.buffer.drain(..index + delimiter);
            self.discarding_oversized_frame = false;
            return Ok(None);
        }

        let Some((index, delimiter)) = frame_boundary(&self.buffer) else {
            if self.buffer.len() <= OPENCODE_SSE_EVENT_LIMIT {
                return Ok(None);
            }
            self.discarding_oversized_frame = true;
            self.compact_discard_prefix();
            return Err("OpenCode SSE event exceeded its bound".to_owned());
        };
        if index > OPENCODE_SSE_EVENT_LIMIT {
            self.buffer.drain(..index + delimiter);
            return Err("OpenCode SSE event exceeded its bound".to_owned());
        }
        let data = (|| {
            let text = std::str::from_utf8(&self.buffer[..index])
                .map_err(|_| "OpenCode SSE event was not UTF-8")?;
            let mut data = Vec::new();
            for line in text.lines() {
                if let Some(value) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push(b'\n');
                    }
                    data.extend_from_slice(value.trim_start().as_bytes());
                }
            }
            Ok::<_, String>(data)
        })();
        self.buffer.drain(..index + delimiter);
        let data = data?;
        if data.is_empty() {
            return Ok(None);
        }
        Ok(Some(data))
    }

    pub(crate) fn take_event(&mut self) -> Result<Option<Value>, String> {
        let Some(data) = self.take_data()? else {
            return Ok(None);
        };
        serde_json::from_slice(&data)
            .map(Some)
            .map_err(|_| "OpenCode SSE data was invalid JSON".to_owned())
    }

    fn compact_discard_prefix(&mut self) {
        if self.buffer.len() <= MAX_BOUNDARY_PREFIX_LENGTH {
            return;
        }
        let retained_start = self.buffer.len() - MAX_BOUNDARY_PREFIX_LENGTH;
        self.buffer.copy_within(retained_start.., 0);
        self.buffer.truncate(MAX_BOUNDARY_PREFIX_LENGTH);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoder_with(chunk: &[u8]) -> OpenCodeSseDecoder {
        let mut decoder = OpenCodeSseDecoder::default();
        decoder.push(chunk).expect("bounded SSE chunk");
        decoder
    }

    #[test]
    fn raw_data_can_be_discarded_without_decode_or_payload_copy() {
        let mut decoder = decoder_with(
            b"data: {this is deliberately not JSON}\n\n\
              data: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
        );

        assert!(decoder.discard_event().expect("bounded raw discard"));
        assert_eq!(
            serde_json::from_slice::<Value>(
                &decoder.take_data().expect("connected frame").expect("data"),
            )
            .expect("connected JSON")["type"],
            "server.connected",
        );
    }

    #[test]
    fn parser_accepts_lf_crlf_and_split_multibyte_frames() {
        let mut decoder =
            decoder_with(b"event: message\r\ndata: {\"type\":\"server.connected\"}\r\n\r\n");
        assert_eq!(
            decoder
                .take_event()
                .expect("CRLF frame")
                .expect("CRLF event")["type"],
            "server.connected"
        );

        let encoded = "data: {\"type\":\"message.updated\",\"label\":\"café\"}\n\n".as_bytes();
        let split = encoded
            .windows("é".len())
            .position(|window| window == "é".as_bytes())
            .expect("multibyte marker")
            + 1;
        decoder
            .push(&encoded[..split])
            .expect("partial frame chunk");
        assert_eq!(decoder.take_event().expect("partial frame"), None);
        decoder
            .push(&encoded[split..])
            .expect("remaining frame chunk");
        assert_eq!(
            decoder
                .take_event()
                .expect("split UTF-8 frame")
                .expect("split UTF-8 event")["label"],
            "café"
        );

        decoder
            .push(b"data: {\"type\":\"session.status\"}\n\n")
            .expect("LF frame chunk");
        assert_eq!(
            decoder.take_event().expect("LF frame").expect("LF event")["type"],
            "session.status"
        );
    }

    #[test]
    fn parser_rejects_oversized_and_delimiter_free_frames() {
        let delimiter_free = vec![b'x'; OPENCODE_SSE_EVENT_LIMIT + 1];
        let mut decoder = decoder_with(&delimiter_free);
        assert!(decoder.take_event().is_err());

        let mut oversized = vec![b'x'; OPENCODE_SSE_EVENT_LIMIT + 1];
        oversized.extend_from_slice(b"\r\n\r\n");
        let mut decoder = decoder_with(&oversized);
        assert!(decoder.take_event().is_err());
    }

    #[test]
    fn parser_discards_a_split_oversized_frame_through_its_boundary() {
        let oversized = vec![b'x'; OPENCODE_SSE_EVENT_LIMIT + 1];
        let mut decoder = decoder_with(&oversized);
        assert!(decoder.take_event().is_err());
        assert!(
            decoder.buffered_len() <= MAX_BOUNDARY_PREFIX_LENGTH,
            "discard state must remain bounded while awaiting the frame boundary"
        );

        decoder
            .push(
                b"data: {\"type\":\"question.asked\"}\n\
                  \ndata: {\"type\":\"server.connected\"}\n\n",
            )
            .expect("successor chunk");
        assert_eq!(
            decoder.take_event().expect("discarded oversized frame"),
            None
        );
        assert_eq!(
            decoder
                .take_event()
                .expect("valid successor frame")
                .expect("successor event")["type"],
            "server.connected"
        );
    }

    #[test]
    fn parser_resynchronizes_after_a_malformed_frame() {
        let mut decoder =
            decoder_with(b"data: not-json\n\ndata: {\"type\":\"server.connected\"}\n\n");
        assert!(decoder.take_event().is_err());
        assert_eq!(
            decoder
                .take_event()
                .expect("valid successor frame")
                .expect("successor event")["type"],
            "server.connected"
        );
    }
}
