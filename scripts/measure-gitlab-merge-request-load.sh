#!/usr/bin/env bash
# Re-run the GitLab merge-request load harness.
# Usage: scripts/measure-gitlab-merge-request-load.sh [rtt-ms] [runs]
# Prints HARNESS_JSON and writes the same document to
# ${BIBCODE_GITLAB_HARNESS_REPORT:-/tmp/bibcode-gitlab-mr-load.json}.
set -euo pipefail
cd "$(dirname "$0")/.."
export BIBCODE_GITLAB_HARNESS_RTT_MS="${1:-200}"
export BIBCODE_GITLAB_HARNESS_RUNS="${2:-5}"
exec cargo test -j 2 -p bibcode-server --test pull_requests_gitlab_load_harness -- --nocapture --test-threads=1
