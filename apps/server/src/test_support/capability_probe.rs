use std::{future::Future, path::PathBuf};

use super::{
    ISOLATING_AND_NO_OP_CASES, TestSandbox,
    appimage_environment::{assert_child_environment, check_inherited_environment},
    run_on_current_thread,
};

pub(crate) fn check_capability_probe_appimage_environment<F, R>(test_name: &str, run_probe: F)
where
    F: FnOnce(PathBuf, Vec<String>) -> R,
    R: Future<Output = Result<(bool, String), String>>,
{
    check_inherited_environment(test_name, ISOLATING_AND_NO_OP_CASES, |expected| {
        let sandbox = TestSandbox::new("capability-appimage-environment");
        let output_path = sandbox.path("environment");
        let executable = sandbox.executable_script(
            "capability-probe",
            "/usr/bin/env -0 > \"$1\"\nprintf 'probe completed'",
            "",
        );
        let (success, stdout) = run_on_current_thread(run_probe(
            executable,
            vec![output_path.to_string_lossy().into_owned()],
        ))
        .expect("system capability probe");
        assert!(success);
        assert_eq!(stdout, "probe completed");
        assert_child_environment(
            &std::fs::read(output_path).expect("probe child environment"),
            expected,
        );
    });
}
