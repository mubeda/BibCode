#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export BIBCODE_GITLAB_HARNESS_RTT_MS="${1:-200}"
export BIBCODE_GITLAB_HARNESS_RUNS="${2:-5}"
exec cargo test -j 2 -p bibcode-server --test pull_requests_gitlab_load_harness -- --include-ignored --nocapture --test-threads=1
