use std::process::ExitCode;

#[cfg(not(windows))]
#[tokio::main]
async fn main() -> ExitCode {
    run_async().await
}

#[cfg(windows)]
fn main() -> ExitCode {
    if bibcode_server::service::windows_service_host_requested() {
        return match bibcode_server::service::run_windows_service_host() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("bibcode: {error}");
                ExitCode::FAILURE
            }
        };
    }
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(run_async()),
        Err(error) => {
            eprintln!("bibcode: failed to initialize the async runtime: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run_async() -> ExitCode {
    match bibcode_server::run_cli().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(bibcode_server::RunError::Cli(error)) => {
            let success = error.exit_code() == 0;
            if let Err(print_error) = error.print() {
                eprintln!("bibcode: failed to print command-line help: {print_error}");
                return ExitCode::FAILURE;
            }
            if success {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("bibcode: {error}");
            ExitCode::FAILURE
        }
    }
}
