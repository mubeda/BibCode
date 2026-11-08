#!/usr/bin/env bash
set -euo pipefail

# Create the test project, register the project runner, push main plus a test
# branch, and write an isolated glab config. Idempotent; run after up.sh.
# Usage: seed.sh SOURCE_REPO_DIR   (a git clone with main; branch bibcode-pipeline-test
#        is used if present, otherwise created from main). The source is only read:
#        a copy in $STATE_DIR/seed-repo gets the new remote and the CI template.
# Prints only: export GLAB_CONFIG_DIR=...

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

if [[ $# -ne 1 || ! -d "$1/.git" ]]; then
  printf 'Usage: %s SOURCE_REPO_DIR\n' "$0" >&2
  exit 2
fi
src=$(cd "$1" && pwd)
token_works || { log "no working token; run up.sh first"; exit 1; }
command -v git >/dev/null
command -v glab >/dev/null
test_branch=bibcode-pipeline-test

# 1. project
if ! api GET "/projects/$PROJECT_ENC" >/dev/null 2>&1; then
  ns=${PROJECT%/*}; path=${PROJECT##*/}
  [[ $ns == root ]] || { log "only the root namespace is supported"; exit 1; }
  api POST /projects --data-urlencode "path=$path" --data visibility=private >/dev/null
fi
pid=$(project_id)

# 2. runner (project runner, tag bibcode-local, no untagged jobs)
rid_file=$STATE_DIR/runner-id
if [[ -f $rid_file ]] && api GET "/runners/$(cat "$rid_file")" >/dev/null 2>&1 &&
  "$engine" exec "$RUNNER_NAME" grep -q '\[\[runners\]\]' /etc/gitlab-runner/config.toml 2>/dev/null; then
  log "runner already registered"
else
  log "registering project runner"
  resp=$(api POST /user/runners --data runner_type=project_type --data "project_id=$pid" \
    --data "tag_list=$RUNNER_TAG" --data run_untagged=false --data description="$NAME")
  echo "$resp" | json id >"$rid_file"
  # Jobs clone via --clone-url because the external_url (localhost) is unreachable from the runner container.
  echo "$resp" | json token | xargs -I{} "$engine" exec "$RUNNER_NAME" gitlab-runner register \
    --non-interactive --url "http://$NAME:$PORT" --clone-url "http://$NAME:$PORT" \
    --token {} --executor shell --name "$NAME" >/dev/null 2>&1
  "$engine" exec "$RUNNER_NAME" sed -i 's/^concurrent = .*/concurrent = 4/' /etc/gitlab-runner/config.toml
  "$engine" restart "$RUNNER_NAME" >/dev/null
fi

# 3. push main and the test branch from a copy; the source clone is never modified
work=$STATE_DIR/seed-repo
rm -rf "$work"
git clone -q --no-hardlinks "$src" "$work"
git -C "$work" remote rename origin source
git -C "$work" remote add local-gitlab "$BASE_URL/$PROJECT.git"
git -C "$work" fetch -q source
git -C "$work" checkout -q -B main source/main
if git -C "$work" rev-parse -q --verify "refs/remotes/source/$test_branch" >/dev/null; then
  git -C "$work" branch -q -f "$test_branch" "source/$test_branch"
else
  git -C "$work" branch -q -f "$test_branch" main
fi
auth=$(printf 'root:%s' "$(sed -n 's/^PRIVATE-TOKEN: //p' "$AUTH_HEADER")" | base64 | tr -d '\n')
gitpush() { # keeps the token out of argv: config is passed through the environment
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $auth" \
    git -C "$work" "$@"
}
for b in main "$test_branch"; do
  if api GET "/projects/$pid/repository/branches/$b" >/dev/null 2>&1; then
    log "branch $b already on GitLab"
    continue
  fi
  git -C "$work" checkout -q "$b"
  cp "$here/gitlab-ci.test.yml" "$work/.gitlab-ci.yml"
  git -C "$work" add .gitlab-ci.yml
  git -C "$work" -c user.name=bibcode-test -c user.email=bibcode-test@localhost commit -q --allow-empty \
    -m "ci: local bibcode-local test pipeline"
  gitpush push -q -o ci.skip local-gitlab "$b" 2>"$STATE_DIR/push.log" || { cat "$STATE_DIR/push.log" >&2; exit 1; } # pipelines.sh triggers pipelines explicitly
done

# 4. isolated glab config; the real ~/.config/glab-cli is never read or written
cfg=$STATE_DIR/glab-config
mkdir -p "$cfg"
sed -n 's/^PRIVATE-TOKEN: //p' "$AUTH_HEADER" |
  GLAB_CONFIG_DIR=$cfg glab auth login --hostname "localhost:$PORT" --stdin \
    --api-protocol http --git-protocol http >/dev/null 2>&1
GLAB_CONFIG_DIR=$cfg glab api projects >/dev/null

printf 'export GLAB_CONFIG_DIR=%s\n' "$cfg"
