//! Exact JSON sizes, counted without building the JSON.

use std::io;

use serde::Serialize;

/// The exact length of `value`'s compact JSON encoding, the same length
/// `serde_json::to_vec(value)` produces, counted without keeping the bytes. A
/// length that would overflow `usize` is an error.
pub(crate) fn encoded_json_len<T: Serialize + ?Sized>(
    value: &T,
) -> Result<usize, serde_json::Error> {
    let mut length = EncodedLength(0);
    serde_json::to_writer(&mut length, value)?;
    Ok(length.0)
}

/// Counts the bytes a serializer writes without keeping them.
struct EncodedLength(usize);

impl io::Write for EncodedLength {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::FileTooLarge,
                "encoded JSON is too large to count",
            )
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;

    use super::*;

    #[test]
    fn counts_exactly_the_bytes_serde_json_writes() {
        let values = [
            json!(null),
            json!({
                "text": "tab\t\"quote\" back\\slash \u{1} é 🙂",
                "numbers": [0, -1, 1.5, u64::MAX],
                "nested": { "empty": [], "flag": true },
            }),
            json!("x".repeat(100_000)),
        ];
        for value in values {
            assert_eq!(
                encoded_json_len(&value).expect("counted length"),
                serde_json::to_vec(&value).expect("encoded JSON").len()
            );
        }
    }

    #[test]
    fn a_length_past_usize_is_an_error_not_a_wrapped_or_saturated_count() {
        let mut length = EncodedLength(usize::MAX - 1);
        let error = length
            .write(b"ab")
            .expect_err("the count cannot pass usize::MAX");
        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge);
        assert_eq!(length.0, usize::MAX - 1, "a failed write adds nothing");
    }
}
