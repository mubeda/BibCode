//! The text form of timestamps the store compares as text.

/// The fallback for an instant outside years 0 to 9999.
const EPOCH: &str = "1970-01-01T00:00:00.000000000Z";

/// The one text form of a timestamp the store compares as text (`expires_at > ?`, `MAX`,
/// `ORDER BY`): RFC 3339 in UTC with exactly nine fraction digits. Text order is time order only
/// at a fixed width; the `time` crate's `Rfc3339` trims the fraction, so `…:00Z` would sort after
/// `…:00.001Z` (#362). Nine digits keep a clock value's nanoseconds, so rows written within one
/// millisecond still order. Against a 3-digit value (SQLite's `strftime('%f')`, a client's
/// `toISOString`) the order is off by under a millisecond.
pub fn format_timestamp(at: time::OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    if !(0..=9999).contains(&at.year()) {
        return EPOCH.to_owned();
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.nanosecond()
    )
}

/// Epoch milliseconds in the store's timestamp form; see [`format_timestamp`].
pub fn format_timestamp_ms(epoch_ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(epoch_ms) * 1_000_000)
        .map_or_else(|_| EPOCH.to_owned(), format_timestamp)
}

/// Now in the store's timestamp form; see [`format_timestamp`].
pub fn now_timestamp() -> String {
    format_timestamp(time::OffsetDateTime::now_utc())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-01-01T00:00:00Z, a whole second: the instant a trimmed fraction writes shortest.
    const SECOND_MS: i64 = 1_767_225_600_000;

    /// Instants one microsecond apart, trailing zeros included, keep their order as text.
    #[test]
    fn instants_a_microsecond_apart_sort_as_text_in_time_order() {
        let base = i128::from(SECOND_MS) * 1_000_000;
        let texts: Vec<String> = [0, 1_000, 2_000, 10_000, 100_000, 120_000, 121_000, 999_000]
            .into_iter()
            .map(|nanos| {
                format_timestamp(
                    time::OffsetDateTime::from_unix_timestamp_nanos(base + nanos).expect("instant"),
                )
            })
            .collect();
        for pair in texts.windows(2) {
            assert!(
                pair[0] < pair[1],
                "{} must sort before {}",
                pair[0],
                pair[1]
            );
        }
    }

    /// Every store formatter writes one width, so text order is time order across them.
    #[test]
    fn store_timestamps_sort_as_text_in_time_order() {
        let instants =
            [0, 1, 9, 10, 100, 120, 121, 999, 1_000, 1_001].map(|offset| SECOND_MS + offset);
        let texts: Vec<String> = instants.iter().map(|ms| format_timestamp_ms(*ms)).collect();
        for pair in texts.windows(2) {
            assert!(
                pair[0] < pair[1],
                "{} must sort before {}",
                pair[0],
                pair[1]
            );
        }
        let at = time::OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(SECOND_MS) * 1_000_000 + 120_456_789,
        )
        .expect("instant");
        assert_eq!(format_timestamp(at), "2026-01-01T00:00:00.120456789Z");
        assert_eq!(
            format_timestamp_ms(SECOND_MS + 120),
            "2026-01-01T00:00:00.120000000Z"
        );
        assert_eq!(
            time::OffsetDateTime::parse(
                &format_timestamp_ms(SECOND_MS + 120),
                &time::format_description::well_known::Rfc3339
            )
            .ok()
            .map(|at| at.unix_timestamp_nanos() / 1_000_000),
            Some(i128::from(SECOND_MS + 120))
        );
    }
}
