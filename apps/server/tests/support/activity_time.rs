use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) fn recent_activity_anchor() -> OffsetDateTime {
    OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .expect("valid current timestamp")
        - Duration::minutes(10)
}

pub(crate) fn activity_timestamp(anchor: OffsetDateTime, offset: Duration) -> String {
    (anchor + offset)
        .format(&Rfc3339)
        .expect("RFC 3339 activity timestamp")
}
