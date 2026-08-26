use std::path::PathBuf;

use bibcode_server_packager::{
    PackagerError,
    archive::{ArchiveFormat, archive_directory},
    model::ArtifactManifest,
    stage::{StageInputs, stage_server},
    verify::verify_manifest_bytes,
};
use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "bibcode-server-packager")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Stage {
        #[arg(long)]
        binary: PathBuf,
        #[arg(long)]
        web_root: PathBuf,
        #[arg(long)]
        web_asset_manifest: PathBuf,
        #[arg(long)]
        install_layout: PathBuf,
        #[arg(long)]
        license: PathBuf,
        #[arg(long)]
        notices: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    Archive {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, value_enum)]
        format: CliArchiveFormat,
        #[arg(long, env = "SOURCE_DATE_EPOCH")]
        source_date_epoch: i64,
    },
    Manifest {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        allow_unsigned_test: bool,
    },
    Verify {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        allow_unsigned_test: bool,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CliArchiveFormat {
    Zip,
    TarGz,
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), PackagerError> {
    match cli.command {
        Command::Stage {
            binary,
            web_root,
            web_asset_manifest,
            install_layout,
            license,
            notices,
            output,
        } => stage_server(StageInputs {
            binary: &binary,
            web_root: &web_root,
            web_asset_manifest: &web_asset_manifest,
            install_layout: &install_layout,
            license: &license,
            notices: &notices,
            output: &output,
        }),
        Command::Archive {
            input,
            output,
            format,
            source_date_epoch,
        } => archive_directory(
            &input,
            &output,
            match format {
                CliArchiveFormat::Zip => ArchiveFormat::Zip,
                CliArchiveFormat::TarGz => ArchiveFormat::TarGz,
            },
            source_date_epoch,
        ),
        Command::Manifest {
            input,
            directory,
            output,
            allow_unsigned_test,
        } => {
            if output.exists() {
                return Err(PackagerError::UnsafePath(output.display().to_string()));
            }
            let bytes = std::fs::read(&input).map_err(|source| PackagerError::Io {
                operation: "read manifest draft",
                path: input,
                source,
            })?;
            let mut manifest = verify_manifest_bytes(&bytes, &directory, allow_unsigned_test)?;
            sort_manifest(&mut manifest);
            let mut encoded = serde_json::to_vec_pretty(&manifest)
                .map_err(|error| PackagerError::Manifest(error.to_string()))?;
            encoded.push(b'\n');
            std::fs::write(&output, encoded).map_err(|source| PackagerError::Io {
                operation: "write finalized manifest",
                path: output,
                source,
            })
        }
        Command::Verify {
            manifest,
            directory,
            allow_unsigned_test,
        } => {
            let bytes = std::fs::read(&manifest).map_err(|source| PackagerError::Io {
                operation: "read artifact manifest",
                path: manifest,
                source,
            })?;
            verify_manifest_bytes(&bytes, &directory, allow_unsigned_test).map(|_| ())
        }
    }
}

fn sort_manifest(manifest: &mut ArtifactManifest) {
    manifest.required_matrix.sort();
    manifest.artifacts.sort_by(|left, right| {
        left.requirement().cmp(&right.requirement()).then_with(|| {
            left.download_name
                .as_bytes()
                .cmp(right.download_name.as_bytes())
        })
    });
}
