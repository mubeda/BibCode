#!/usr/bin/env bash
# Shared settings and helpers for the local GitLab test kit. Source it; do not run it.
# Every value below can be overridden from the environment.

NAME=${BIBCODE_TEST_GITLAB_NAME:-bibcode-test-gitlab}
PORT=${BIBCODE_TEST_GITLAB_PORT:-8929}
SSH_PORT=${BIBCODE_TEST_GITLAB_SSH_PORT:-2224}
STATE_DIR=${BIBCODE_TEST_GITLAB_STATE_DIR:-${TMPDIR:-/tmp}/bibcode-test-gitlab-state}
PROJECT=${BIBCODE_TEST_GITLAB_PROJECT:-root/sample-project}
RUNNER_TAG=bibcode-local
GITLAB_IMAGE=${BIBCODE_TEST_GITLAB_IMAGE:-gitlab/gitlab-ce:19.4.1-ce.0}
RUNNER_IMAGE=${BIBCODE_TEST_GITLAB_RUNNER_IMAGE:-gitlab/gitlab-runner:alpine-v19.4.0}
engine=${CONTAINER_ENGINE:-docker}

# down.sh removes everything named $NAME*, so refuse names that could match other resources.
case "$NAME" in
  bibcode-test-gitlab*) ;;
  *) printf 'BIBCODE_TEST_GITLAB_NAME must start with bibcode-test-gitlab: %s\n' "$NAME" >&2; exit 2 ;;
esac
case "$STATE_DIR" in
  *"$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent-repo)"/*)
    printf 'State dir must be outside the repository: %s\n' "$STATE_DIR" >&2; exit 2 ;;
esac

RUNNER_NAME=$NAME-runner
NET=$NAME-net
BASE_URL=http://localhost:$PORT
CREDS=$STATE_DIR/credentials.env
AUTH_HEADER=$STATE_DIR/auth-header   # "PRIVATE-TOKEN: ..." read by curl via -H @file, never printed
PROJECT_ENC=${PROJECT//\//%2F}

command -v "$engine" >/dev/null
command -v curl >/dev/null
command -v python3 >/dev/null
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

log() { printf '[%s] %s\n' "$(basename "$0")" "$*" >&2; }

# api METHOD PATH [curl args...] -> response body on stdout, fails on HTTP >= 400
api() {
  local method=$1 path=$2
  shift 2
  curl -fsS -X "$method" -H "@$AUTH_HEADER" "$@" "$BASE_URL/api/v4$path"
}

# json KEY: read one top-level key from JSON on stdin
json() { python3 -c 'import sys,json; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

token_works() { [[ -f "$AUTH_HEADER" ]] && api GET /user >/dev/null 2>&1; }

project_id() { api GET "/projects/$PROJECT_ENC" | json id; }
