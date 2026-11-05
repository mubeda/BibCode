/// A run of output with CSI, OSC and other escape sequences removed, and the bytes of an
/// unterminated sequence at its end, which a later page reads whole.
pub(crate) fn strip_escapes(text: &str) -> (String, usize) {
    let bytes = text.as_bytes();
    let mut clean = String::with_capacity(text.len());
    let mut index = 0;
    let mut kept_from = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            index += 1;
            continue;
        }
        clean.push_str(&text[kept_from..index]);
        let Some(end) = escape_end(bytes, index) else {
            return (clean, bytes.len() - index);
        };
        index = end;
        kept_from = end;
    }
    clean.push_str(&text[kept_from..]);
    (clean, 0)
}

/// The index just past the escape sequence that starts at `start` (an ESC), or `None` when
/// the text ends inside it.
pub(crate) fn escape_end(bytes: &[u8], start: usize) -> Option<usize> {
    let kind = *bytes.get(start + 1)?;
    match kind {
        // CSI: parameters and intermediates, then a final byte.
        b'[' => (start + 2..bytes.len())
            .find(|&index| (0x40..=0x7e).contains(&bytes[index]))
            .map(|index| index + 1),
        // OSC, DCS, SOS, PM and APC strings end at BEL (OSC) or ST (ESC \).
        b']' | b'P' | b'X' | b'^' | b'_' => {
            let mut index = start + 2;
            while index < bytes.len() {
                match bytes[index] {
                    0x07 if kind == b']' => return Some(index + 1),
                    0x1b if bytes.get(index + 1) == Some(&b'\\') => return Some(index + 2),
                    0x1b if index + 1 == bytes.len() => return None,
                    _ => index += 1,
                }
            }
            None
        }
        // Any other: intermediates, then one final byte (ESC 7, ESC ( B, ESC =). Without a
        // final byte only the ESC and its intermediates go.
        _ => (start + 1..bytes.len())
            .find(|&index| !(0x20..=0x2f).contains(&bytes[index]))
            .map(|index| {
                if (0x30..=0x7e).contains(&bytes[index]) {
                    index + 1
                } else {
                    index
                }
            }),
    }
}
