#!/usr/bin/env bash
set -euo pipefail

# Unregister the runner, then stop and remove only the bibcode-test-gitlab* containers,
# volumes and network. Nothing else in Docker is touched.
# Usage: down.sh [--keep-volumes]
#   --keep-volumes  keep the named volumes (GitLab data) and the state dir for a later up.sh

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

keep=false
case "${1:-}" in
  "") ;;
  --keep-volumes) keep=true ;;
  *) printf 'Usage: %s [--keep-volumes]\n' "$0" >&2; exit 2 ;;
esac

rid_file=$STATE_DIR/runner-id
if [[ -f $rid_file ]] && token_works; then
  api DELETE "/runners/$(cat "$rid_file")" >/dev/null 2>&1 || true
fi
rm -f "$rid_file"

for c in "$RUNNER_NAME" "$NAME"; do
  "$engine" rm -f "$c" >/dev/null 2>&1 || true
done
"$engine" network rm "$NET" >/dev/null 2>&1 || true

if ! $keep; then
  for v in "$NAME-config" "$NAME-logs" "$NAME-data" "$RUNNER_NAME-config"; do
    "$engine" volume rm "$v" >/dev/null 2>&1 || true
  done
  # The token, glab config and seed copy belonged to the deleted instance; the generated
  # root password stays valid for the next first boot.
  rm -rf "$AUTH_HEADER" "$STATE_DIR/glab-config" "$STATE_DIR/seed-repo"
  sed -i.bak '/^GITLAB_ROOT_TOKEN=/d' "$CREDS" 2>/dev/null && rm -f "$CREDS.bak" || true
fi
$keep && log "removed containers; volumes kept" || log "removed containers and volumes"
