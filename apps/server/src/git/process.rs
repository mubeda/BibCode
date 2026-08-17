use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use thiserror::Error;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::process::supervised::{
    SupervisedOverflow, SupervisedRunError, SupervisedRunRequest, SupervisedStreamOutput,
    run_supervised,
};

const TRUNCATION_MARKER: &str = "\n\n[truncated]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputPolicy {
    Truncate,
    Error,
}

#[derive(Clone, Debug)]
pub struct ProcessRequest {
    pub operation: String,
    pub command: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub output_policy: OutputPolicy,
    pub append_truncation_marker: bool,
    pub allow_non_zero_exit: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("failed to spawn {command} for {operation}")]
    Spawn {
        operation: String,
        command: String,
        source: std::io::Error,
    },
    #[error("failed to access {stream} for {operation}")]
    Pipe {
        operation: String,
        stream: &'static str,
    },
    #[error("failed to read {stream} for {operation}")]
    Read {
        operation: String,
        stream: &'static str,
        source: std::io::Error,
    },
    #[error("failed to write process stdin for {operation}")]
    Stdin {
        operation: String,
        source: std::io::Error,
    },
    #[error("{operation} timed out after {timeout_ms}ms")]
    Timeout { operation: String, timeout_ms: u128 },
    #[error("{operation} was cancelled")]
    Cancelled { operation: String },
    #[error("{operation} output exceeded {max_bytes} bytes on {stream}")]
    OutputLimit {
        operation: String,
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    #[error("{operation} exited with code {exit_code}")]
    NonZeroExit {
        operation: String,
        exit_code: i32,
        stdout_length: usize,
        stderr_length: usize,
        stdout: Box<str>,
        stderr: Box<str>,
    },
    #[error("{operation} completed without an exit code")]
    MissingExitCode { operation: String },
    #[error("failed to wait for {operation}")]
    Wait {
        operation: String,
        source: std::io::Error,
    },
}

impl ProcessError {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessRunner;

impl ProcessRunner {
    pub async fn run(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_with_environment(request, cancellation, false)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn run_with_clean_environment_for_test(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_with_environment(request, cancellation, true).await
    }

    async fn run_with_environment(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
        clear_environment: bool,
    ) -> Result<ProcessOutput, ProcessError> {
        let command_label = request.command.to_string_lossy().into_owned();
        let mut command = Command::new(&request.command);
        if clear_environment {
            command.env_clear();
        }
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .envs(request.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = run_supervised(
            SupervisedRunRequest {
                command,
                stdin: request.stdin.clone(),
                timeout: request.timeout,
                cleanup_timeout: Duration::from_secs(2),
                max_output_bytes: request.max_output_bytes,
                overflow: match request.output_policy {
                    OutputPolicy::Truncate => SupervisedOverflow::Truncate,
                    OutputPolicy::Error => SupervisedOverflow::Error,
                },
            },
            cancellation,
        )
        .await
        .map_err(|error| map_supervised_error(error, &request, command_label))?;

        let exit_code = match output.status.code() {
            Some(exit_code) => exit_code,
            None => {
                return Err(ProcessError::MissingExitCode {
                    operation: request.operation.clone(),
                });
            }
        };
        let stdout_length = output.stdout.observed_bytes;
        let stderr_length = output.stderr.observed_bytes;
        let stdout_truncated = output.stdout.truncated();
        let stderr_truncated = output.stderr.truncated();
        let stdout = render(output.stdout, request.append_truncation_marker);
        let stderr = render(output.stderr, request.append_truncation_marker);
        if exit_code != 0 && !request.allow_non_zero_exit {
            return Err(ProcessError::NonZeroExit {
                operation: request.operation,
                exit_code,
                stdout_length,
                stderr_length,
                stdout: stdout.into(),
                stderr: stderr.into(),
            });
        }
        Ok(ProcessOutput {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
        })
    }
}

fn map_supervised_error(
    error: SupervisedRunError,
    request: &ProcessRequest,
    command: String,
) -> ProcessError {
    let operation = request.operation.clone();
    match error {
        SupervisedRunError::Spawn(source) => ProcessError::Spawn {
            operation,
            command,
            source,
        },
        SupervisedRunError::Pipe { stream } => ProcessError::Pipe { operation, stream },
        SupervisedRunError::Stdin(source) => ProcessError::Stdin { operation, source },
        SupervisedRunError::Read { stream, source } => ProcessError::Read {
            operation,
            stream,
            source,
        },
        SupervisedRunError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        } => ProcessError::OutputLimit {
            operation,
            stream,
            max_bytes,
            observed_bytes,
        },
        SupervisedRunError::Timeout => ProcessError::Timeout {
            operation,
            timeout_ms: request.timeout.as_millis(),
        },
        SupervisedRunError::Cancelled => ProcessError::Cancelled { operation },
        SupervisedRunError::Wait(source) => ProcessError::Wait { operation, source },
    }
}

fn render(output: SupervisedStreamOutput, append_marker: bool) -> String {
    let truncated = output.truncated();
    let mut rendered = String::from_utf8_lossy(&output.bytes).into_owned();
    if truncated && append_marker {
        rendered.push_str(TRUNCATION_MARKER);
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestSandbox;

    fn fixture_request(sandbox: &TestSandbox, operation: &str, command: PathBuf) -> ProcessRequest {
        ProcessRequest {
            operation: operation.to_owned(),
            command,
            args: Vec::new(),
            cwd: sandbox.root().to_path_buf(),
            env: sandbox
                .environment(std::iter::empty::<(String, String)>())
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            stdin: None,
            timeout: Duration::from_secs(30),
            max_output_bytes: 1024,
            output_policy: OutputPolicy::Truncate,
            append_truncation_marker: false,
            allow_non_zero_exit: false,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runner_uses_command_local_environment_for_parallel_children() {
        async fn run(label: &str) -> ProcessOutput {
            let sandbox = TestSandbox::new(label);
            let script = sandbox.executable_script(
                "print-label",
                "printf '%s' \"$FIXTURE_LABEL\"",
                "@echo off\r\n<nul set /p =%FIXTURE_LABEL%\r\nexit /b 0",
            );
            let mut request = fixture_request(&sandbox, "fixture-label", script);
            request.env = sandbox
                .environment([("FIXTURE_LABEL", label)])
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect();
            ProcessRunner
                .run(request, &CancellationToken::new())
                .await
                .expect("parallel git fixture process")
        }

        let (left, right) = tokio::join!(run("left"), run("right"));
        assert_eq!(left.stdout, "left");
        assert_eq!(right.stdout, "right");
    }
}
