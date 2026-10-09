//! Parsed `git --version` output for feature gating.

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct GitVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    /// `git merge-tree --write-tree`.
    pub const MERGE_TREE_WRITE: Self = Self {
        major: 2,
        minor: 38,
        patch: 0,
    };
    /// `git --attr-source` combined with merge-tree (2.43 fixed a crash).
    pub const MERGE_TREE_ATTR_SOURCE: Self = Self {
        major: 2,
        minor: 43,
        patch: 0,
    };

    #[must_use]
    pub fn parse(output: &str) -> Option<Self> {
        let token = output
            .trim()
            .strip_prefix("git version ")?
            .split_whitespace()
            .next()?;
        let mut parts = token.split('.');
        let mut number = |required: bool| -> Option<u32> {
            match parts.next() {
                Some(part) => {
                    let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
                    digits.parse().ok()
                }
                None if required => None,
                None => Some(0),
            }
        };
        Some(Self {
            major: number(true)?,
            minor: number(true)?,
            patch: number(false)?,
        })
    }
}

impl fmt::Display for GitVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[cfg(test)]
mod tests {
    use super::GitVersion;

    fn version(major: u32, minor: u32, patch: u32) -> GitVersion {
        GitVersion {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn parses_release_vendor_and_windows_builds() {
        assert_eq!(
            GitVersion::parse("git version 2.34.1\n"),
            Some(version(2, 34, 1))
        );
        assert_eq!(
            GitVersion::parse("git version 2.50.1 (Apple Git-155)"),
            Some(version(2, 50, 1))
        );
        assert_eq!(
            GitVersion::parse("git version 2.55.0.windows.1"),
            Some(version(2, 55, 0))
        );
        assert_eq!(
            GitVersion::parse("git version 2.38"),
            Some(version(2, 38, 0))
        );
    }

    #[test]
    fn rejects_unrecognised_output() {
        assert_eq!(GitVersion::parse(""), None);
        assert_eq!(GitVersion::parse("hub version 2.14.2"), None);
    }

    #[test]
    fn orders_against_feature_floors() {
        assert!(version(2, 34, 1) < GitVersion::MERGE_TREE_WRITE);
        assert!(version(2, 39, 5) >= GitVersion::MERGE_TREE_WRITE);
        assert!(version(2, 39, 5) < GitVersion::MERGE_TREE_ATTR_SOURCE);
        assert_eq!(version(2, 34, 1).to_string(), "2.34.1");
    }
}
