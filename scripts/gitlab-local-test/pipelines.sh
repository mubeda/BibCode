#!/usr/bin/env bash
set -euo pipefail

# Trigger test pipelines on the seeded project and report ids and statuses.
# Usage: pipelines.sh
# Creates: one pipeline on main and one on bibcode-pipeline-test (both finish; the
# flaky-on-purpose job is allowed to fail), then one long-running pipeline
# (BIBCODE_LONG=1, ~2 min sleep job plus a manual job) that is left running.

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

token_works || { log "no working token; run up.sh and seed.sh first"; exit 1; }
pid=$(project_id)

create() { # create REF [KEY=VALUE]
  local body
  body=$(python3 -c 'import sys,json; r,kv=sys.argv[1],sys.argv[2]
d={"ref":r}
if kv: k,v=kv.split("=",1); d["variables"]=[{"key":k,"value":v,"variable_type":"env_var"}]
print(json.dumps(d))' "$1" "${2:-}")
  api POST "/projects/$pid/pipeline" -H 'Content-Type: application/json' --data "$body" | json id
}
status() { api GET "/projects/$pid/pipelines/$1" | json status; }

ids=("$(create main)" "$(create bibcode-pipeline-test)")
log "waiting for pipelines ${ids[*]}"
deadline=$((SECONDS + 600))
for id in "${ids[@]}"; do
  until [[ $(status "$id") =~ ^(success|failed|canceled|skipped|manual)$ ]]; do
    ((SECONDS < deadline)) || { log "timed out waiting for pipeline $id"; exit 1; }
    sleep 5
  done
done
long=$(create main BIBCODE_LONG=1)
ids+=("$long")
for id in "${ids[@]}"; do
  printf 'pipeline %s: %s (%s/%s/-/pipelines/%s)\n' "$id" "$(status "$id")" "$BASE_URL" "$PROJECT" "$id"
done
