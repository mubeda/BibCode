use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    // The open-url shim, or the Windows `bibcode-open-url.exe` alias: before clap, whose
    // environment-backed options a session may carry, and before any data-root work.
    let args = std::env::args_os().collect::<Vec<_>>();
    if let Some(url) = bibcode_server::open_url::open_url_invocation(&args) {
        std::process::exit(bibcode_server::open_url::run_open_url(&url).await);
    }
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
