pub(crate) fn bibcode_env_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name)
}

pub(crate) fn bibcode_env_string(name: &str) -> Option<String> {
    bibcode_env_var(name).and_then(|value| value.into_string().ok())
}
