use std::ffi::OsString;

fn read_with(
    canonical_name: &str,
    legacy_name: &str,
    read: impl Fn(&str) -> Option<OsString>,
) -> Option<OsString> {
    read(canonical_name).or_else(|| read(legacy_name))
}

pub(crate) fn bibcode_env_var(canonical_name: &str, legacy_name: &str) -> Option<OsString> {
    read_with(canonical_name, legacy_name, |name| std::env::var_os(name))
}

pub(crate) fn bibcode_env_string(canonical_name: &str, legacy_name: &str) -> Option<String> {
    bibcode_env_var(canonical_name, legacy_name).and_then(|value| value.into_string().ok())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn canonical_environment_values_precede_legacy_values() {
        let values = BTreeMap::from([
            ("BIBCODE_PORT", OsString::from("1")),
            ("T4CODE_PORT", OsString::from("2")),
        ]);
        assert_eq!(
            read_with("BIBCODE_PORT", "T4CODE_PORT", |name| values.get(name).cloned()),
            Some(OsString::from("1"))
        );
        assert_eq!(
            read_with("BIBCODE_HOME", "T4CODE_HOME", |name| values.get(name).cloned()),
            None
        );
    }
}
