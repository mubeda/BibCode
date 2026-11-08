#!/usr/bin/env bash
set -euo pipefail

# Start (or reuse) the local GitLab CE and runner containers and wait until healthy.
# Usage: up.sh
# Env:   BIBCODE_TEST_GITLAB_PORT (8929)  BIBCODE_TEST_GITLAB_SSH_PORT (2224)
#        BIBCODE_TEST_GITLAB_STATE_DIR (${TMPDIR:-/tmp}/bibcode-test-gitlab-state; never the repo)
#        BIBCODE_TEST_GITLAB_NAME (bibcode-test-gitlab)  BIBCODE_TEST_GITLAB_IMAGE / _RUNNER_IMAGE
# Ports bind to 127.0.0.1 only. Credentials are generated on first run into
# $STATE_DIR/credentials.env (chmod 600) and are never printed.

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

start=$SECONDS
exists() { "$engine" container inspect "$1" >/dev/null 2>&1; }
running() { [[ $("$engine" container inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }

if [[ ! -f "$CREDS" ]]; then
  (umask 077; printf 'GITLAB_ROOT_PASSWORD=%sAa1\n' "$(openssl rand -base64 24 | tr -dc A-Za-z0-9)" >"$CREDS")
fi
chmod 600 "$CREDS"
# shellcheck disable=SC1090
. "$CREDS"

"$engine" network inspect "$NET" >/dev/null 2>&1 || "$engine" network create "$NET" >/dev/null

if ! exists "$NAME"; then
  log "creating $NAME from $GITLAB_IMAGE (first boot takes several minutes)"
  "$engine" run -d --name "$NAME" --hostname localhost --network "$NET" \
    -p "127.0.0.1:$PORT:$PORT" -p "127.0.0.1:$SSH_PORT:22" --shm-size 256m \
    -v "$NAME-config:/etc/gitlab" -v "$NAME-logs:/var/log/gitlab" -v "$NAME-data:/var/opt/gitlab" \
    -e GITLAB_ROOT_PASSWORD="$GITLAB_ROOT_PASSWORD" \
    -e GITLAB_OMNIBUS_CONFIG="external_url 'http://localhost:$PORT'; gitlab_rails['gitlab_shell_ssh_port']=$SSH_PORT; puma['worker_processes']=2; sidekiq['concurrency']=5; prometheus_monitoring['enable']=false; gitlab_rails['usage_ping_enabled']=false" \
    "$GITLAB_IMAGE" >/dev/null
elif ! running "$NAME"; then
  log "starting existing $NAME"
  "$engine" start "$NAME" >/dev/null
fi

if ! exists "$RUNNER_NAME"; then
  log "creating $RUNNER_NAME from $RUNNER_IMAGE"
  "$engine" run -d --name "$RUNNER_NAME" --network "$NET" --restart unless-stopped \
    -v "$RUNNER_NAME-config:/etc/gitlab-runner" "$RUNNER_IMAGE" >/dev/null
elif ! running "$RUNNER_NAME"; then
  "$engine" start "$RUNNER_NAME" >/dev/null
fi

log "waiting for GitLab to become healthy (up to 15 min)"
deadline=$((SECONDS + 900))
until [[ $("$engine" inspect -f '{{.State.Health.Status}}' "$NAME") == healthy ]] &&
  [[ $(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/users/sign_in") == 200 ]]; do
  ((SECONDS < deadline)) || { log "timed out; see: $engine logs $NAME"; exit 1; }
  sleep 10
done

if ! token_works; then
  log "creating root personal access token (api scope)"
  tok=glpat-$(openssl rand -base64 24 | tr -dc A-Za-z0-9 | cut -c1-26)
  "$engine" exec -e TOK="$tok" "$NAME" gitlab-rails runner \
    "u=User.find_by_username('root'); t=u.personal_access_tokens.create!(name: 'bibcode-test-'+Time.now.to_i.to_s, scopes: [:api], expires_at: 300.days.from_now.to_date); t.set_token(ENV['TOK']); t.save!" >/dev/null
  (umask 077; printf 'PRIVATE-TOKEN: %s\n' "$tok" >"$AUTH_HEADER")
  sed -i.bak '/^GITLAB_ROOT_TOKEN=/d' "$CREDS" && rm -f "$CREDS.bak"
  printf 'GITLAB_ROOT_TOKEN=%s\n' "$tok" >>"$CREDS"
  token_works || { log "token does not authenticate"; exit 1; }
fi

log "ready at $BASE_URL after $((SECONDS - start))s; state dir: $STATE_DIR"
