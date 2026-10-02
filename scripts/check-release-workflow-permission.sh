#!/usr/bin/env bash
# The release controller uses GITHUB_TOKEN, which cannot receive workflow-write
# permission. Check the live default branch without moving the candidate or tag.
set -euo pipefail

trap 'printf "Could not verify release workflow permissions. Check repository access and the immutable release commit, then retry this check.\n" >&2' ERR

if [[ $# != 1 || ! "$1" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]]; then
  printf 'Could not verify release workflow permissions: expected one immutable commit SHA.\n' >&2
  exit 1
fi
release_commit="$(git rev-parse --verify "$1^{commit}")"
default_branch="$(gh api "repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" --jq .default_branch)"
git check-ref-format "refs/heads/$default_branch"
# Fetch every time: the default branch may have advanced during native builds.
git fetch --quiet --no-tags origin "refs/heads/$default_branch"
default_commit="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"

if git diff --quiet "$default_commit" "$release_commit" -- .github/workflows/; then
  printf 'Release workflow permissions verified against %s at %s.\n' "$default_branch" "$default_commit"
else
  diff_status=$?
  if [[ "$diff_status" != 1 ]]; then
    printf 'Could not verify release workflow permissions: Git comparison failed.\n' >&2
    exit "$diff_status"
  fi
  printf 'GITHUB_TOKEN cannot authorize workflow changes between release %s and default branch %s at %s.\n' \
    "$release_commit" "$default_branch" "$default_commit" >&2
  printf '%s\n' \
    'Use an appropriately authorized release identity, or obtain explicit approval to replace an unpublished candidate following docs/operations/release.md.' \
    'Never move a published tag or retarget release metadata to conceal the mismatch. Pre-creating a draft or granting contents:write does not fix this permission.' \
    'Repeat draft inspection after recovery. A later API failure remains a failure: the default branch can change again after this check.' >&2
  exit 1
fi
