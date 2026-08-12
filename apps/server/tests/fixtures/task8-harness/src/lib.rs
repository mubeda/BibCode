#[path = "../../../../src/crypto.rs"]
mod crypto;
#[allow(dead_code)]
pub mod activity;
#[path = "../../../../src/diagnostics/mod.rs"]
pub mod diagnostics;
#[allow(dead_code)]
pub mod persistence;
#[path = "../../../../src/process/mod.rs"]
#[allow(dead_code)]
pub mod process;
#[allow(dead_code)]
pub mod provider_terminal;
#[cfg(test)]
#[allow(dead_code)]
#[path = "../../../../src/test_support/mod.rs"]
pub(crate) mod test_support;
#[allow(dead_code, unused_imports)]
#[path = "../../../../src/terminal/mod.rs"]
pub mod terminal;

#[must_use]
pub fn redact_sensitive_text(input: &str) -> String {
    diagnostics::redact_sensitive_text(input)
}

pub async fn exercise_native_cleanup_for_harness(root_pid: u32) -> bool {
    diagnostics::NativeProcessSampler::default()
        .cleanup_descendants(root_pid)
        .await
        .is_ok()
}
