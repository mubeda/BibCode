#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_cursor_release_dates_without_ordering_same_day_builds() {
        assert_eq!(
            advisory_status(
                VersionScheme::CursorRelease,
                Some("2026.06.19-20-24-33-653a7fb"),
                Some("2026.08.04-aaa8809"),
            ),
            "behind_latest"
        );
        assert_eq!(
            advisory_status(
                VersionScheme::CursorRelease,
                Some("2026.08.04-aaaa"),
                Some("2026.08.04-bbbb"),
            ),
            "unknown"
        );
        assert!(!version_advanced(
            VersionScheme::CursorRelease,
            Some("2026.08.04-aaaa"),
            Some("2026.08.04-bbbb"),
        ));
    }

    #[test]
    fn parses_matching_cursor_installer_release_identifiers() {
        let script = br#"DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.04-aaa8809/${OS}/${ARCH}/agent-cli-package.tar.gz"
FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.08.04-aaa8809""#;
        assert_eq!(
            parse_latest_response(LatestVersionSource::CursorInstaller, script),
            Ok("2026.08.04-aaa8809".to_owned())
        );
    }

    #[test]
    fn rejects_mismatched_cursor_installer_release_identifiers() {
        let script = br#"DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.04-aaa8809/${OS}/${ARCH}/agent-cli-package.tar.gz"
FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.08.05-bbb9910""#;
        assert_eq!(
            parse_latest_response(LatestVersionSource::CursorInstaller, script),
            Err(LatestVersionFailure::InvalidVersion)
        );
    }

    #[test]
    fn parses_npm_and_claude_channel_responses() {
        assert_eq!(
            parse_latest_response(
                LatestVersionSource::Npm("@openai/codex"),
                br#"{"version":"0.148.0"}"#,
            ),
            Ok("0.148.0".to_owned())
        );
        assert_eq!(
            parse_latest_response(
                LatestVersionSource::Claude(ClaudeReleaseChannel::Stable),
                b"2.1.220\n",
            ),
            Ok("2.1.220".to_owned())
        );
    }

    #[test]
    fn rejects_invalid_npm_and_claude_semver_responses() {
        assert_eq!(
            parse_latest_response(
                LatestVersionSource::Npm("@openai/codex"),
                br#"{"version":"not-a-version"}"#,
            ),
            Err(LatestVersionFailure::InvalidVersion)
        );
        assert_eq!(
            parse_latest_response(
                LatestVersionSource::Claude(ClaudeReleaseChannel::Stable),
                b"v2.1.220\n",
            ),
            Err(LatestVersionFailure::InvalidVersion)
        );
    }

    #[test]
    fn rejects_invalid_utf8_json_and_missing_npm_version() {
        assert_eq!(
            parse_latest_response(LatestVersionSource::Npm("@openai/codex"), &[0xff]),
            Err(LatestVersionFailure::InvalidUtf8)
        );
        assert_eq!(
            parse_latest_response(
                LatestVersionSource::Npm("@openai/codex"),
                br#"{"version": "0.148.0""#,
            ),
            Err(LatestVersionFailure::InvalidJson)
        );
        assert_eq!(
            parse_latest_response(LatestVersionSource::Npm("@openai/codex"), br#"{}"#),
            Err(LatestVersionFailure::MissingVersion)
        );
    }

    #[test]
    fn rejects_cursor_installer_identifiers_with_malformed_dates_or_suffixes() {
        for identifier in ["2026.08.04-", "2026.08.day-aaa8809", "2026.08-aaa8809"] {
            let script = format!(
                "DOWNLOAD_URL=\"https://downloads.cursor.com/lab/{identifier}/${{OS}}/${{ARCH}}/agent-cli-package.tar.gz\"\nFINAL_DIR=\"$HOME/.local/share/cursor-agent/versions/{identifier}\""
            );
            assert_eq!(
                parse_latest_response(LatestVersionSource::CursorInstaller, script.as_bytes()),
                Err(LatestVersionFailure::InvalidVersion),
                "{identifier}"
            );
        }
    }

    #[test]
    fn cursor_release_dates_require_exact_widths_and_real_gregorian_dates() {
        assert!(parse_cursor_release("2024.02.29-aaa8809").is_some());
        for identifier in [
            "26.08.04-aaa8809",
            "2026.8.04-aaa8809",
            "2026.08.4-aaa8809",
            "2026.00.04-aaa8809",
            "2026.13.04-aaa8809",
            "2026.02.29-aaa8809",
            "2026.04.31-aaa8809",
        ] {
            assert!(
                parse_cursor_release(identifier).is_none(),
                "accepted invalid Cursor release {identifier}"
            );
        }
    }
}
use std::cmp::Ordering;

use time::{Date, Month};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum ClaudeReleaseChannel {
    Stable,
    Latest,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum LatestVersionSource {
    Npm(&'static str),
    Claude(ClaudeReleaseChannel),
    CursorInstaller,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VersionScheme {
    Semver,
    CursorRelease,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LatestVersionFailure {
    InvalidUrl,
    Request,
    HttpStatus,
    ResponseTooLarge,
    InvalidUtf8,
    InvalidJson,
    MissingVersion,
    InvalidVersion,
}

impl LatestVersionFailure {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUrl => "invalid_url",
            Self::Request => "request",
            Self::HttpStatus => "http_status",
            Self::ResponseTooLarge => "response_too_large",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::InvalidJson => "invalid_json",
            Self::MissingVersion => "missing_version",
            Self::InvalidVersion => "invalid_version",
        }
    }
}

pub(super) fn parse_latest_response(
    source: LatestVersionSource,
    response: &[u8],
) -> Result<String, LatestVersionFailure> {
    let response = std::str::from_utf8(response).map_err(|_| LatestVersionFailure::InvalidUtf8)?;
    match source {
        LatestVersionSource::Npm(_) => {
            let response = serde_json::from_str::<serde_json::Value>(response)
                .map_err(|_| LatestVersionFailure::InvalidJson)?;
            let version = response
                .get("version")
                .and_then(serde_json::Value::as_str)
                .ok_or(LatestVersionFailure::MissingVersion)?;
            parse_semver_response(version)
        }
        LatestVersionSource::Claude(_) => parse_semver_response(response),
        LatestVersionSource::CursorInstaller => parse_cursor_installer_response(response),
    }
}

pub(super) fn advisory_status(
    scheme: VersionScheme,
    current: Option<&str>,
    latest: Option<&str>,
) -> &'static str {
    match compare_versions(scheme, current, latest) {
        Some(Ordering::Less) => "behind_latest",
        Some(Ordering::Equal | Ordering::Greater) => "current",
        None => "unknown",
    }
}

pub(super) fn version_advanced(
    scheme: VersionScheme,
    before: Option<&str>,
    after: Option<&str>,
) -> bool {
    matches!(
        compare_versions(scheme, before, after),
        Some(Ordering::Less)
    )
}

fn compare_versions(
    scheme: VersionScheme,
    current: Option<&str>,
    latest: Option<&str>,
) -> Option<Ordering> {
    match scheme {
        VersionScheme::Semver => Some(parse_version(current?)?.cmp(&parse_version(latest?)?)),
        VersionScheme::CursorRelease => {
            let current = current?;
            let latest = latest?;
            let ordering = parse_cursor_release(current)?
                .date
                .cmp(&parse_cursor_release(latest)?.date);
            (ordering != Ordering::Equal || current == latest).then_some(ordering)
        }
    }
}

fn parse_semver_response(value: &str) -> Result<String, LatestVersionFailure> {
    let value = value.trim();
    semver::Version::parse(value).map_err(|_| LatestVersionFailure::InvalidVersion)?;
    Ok(value.to_owned())
}

fn parse_cursor_installer_response(value: &str) -> Result<String, LatestVersionFailure> {
    let mut download_identifier = None;
    let mut final_identifier = None;
    for line in value.lines() {
        if let Some(value) = line.strip_prefix("DOWNLOAD_URL=") {
            download_identifier = extract_identifier(value, "/lab/");
        } else if let Some(value) = line.strip_prefix("FINAL_DIR=") {
            final_identifier = extract_identifier(value, "/versions/");
        }
    }
    let identifier = download_identifier
        .filter(|identifier| final_identifier == Some(*identifier))
        .ok_or(LatestVersionFailure::InvalidVersion)?;
    parse_cursor_release(identifier).ok_or(LatestVersionFailure::InvalidVersion)?;
    Ok(identifier.to_owned())
}

fn extract_identifier<'a>(value: &'a str, marker: &str) -> Option<&'a str> {
    value.split_once(marker)?.1.split(['/', '"']).next()
}

struct CursorRelease {
    date: Date,
}

fn parse_cursor_release(value: &str) -> Option<CursorRelease> {
    let (date, suffix) = value.split_once('-')?;
    if suffix.is_empty() {
        return None;
    }
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'.'
        || bytes[7] != b'.'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 4 | 7) && !byte.is_ascii_digit())
    {
        return None;
    }
    let year = date[0..4].parse::<i32>().ok()?;
    let month = Month::try_from(date[5..7].parse::<u8>().ok()?).ok()?;
    let day = date[8..10].parse::<u8>().ok()?;
    Some(CursorRelease {
        date: Date::from_calendar_date(year, month, day).ok()?,
    })
}

fn parse_version(value: &str) -> Option<semver::Version> {
    value
        .split_whitespace()
        .map(|part| {
            part.trim_matches(|character: char| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
            })
        })
        .find_map(|candidate| semver::Version::parse(candidate.trim_start_matches('v')).ok())
}
