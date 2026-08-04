use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
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
