# Create GitHub Release Skill Design

## Status

Approved for implementation on 2026-08-16.

## Outcome

Create a reusable personal Codex skill named `create-github-release` at
`~/.codex/skills/create-github-release`. The skill must safely integrate a
feature branch, prepare release history, publish a GitHub release, follow its
builds to completion, and verify every supported installer asset.

The skill is repository-aware. It must discover the current repository's
version sources, validation commands, release trigger, platform matrix,
signing requirements, and asset contract rather than hardcoding BiBCode paths
or platforms.

## Components

The skill contains only the files required for execution:

- `SKILL.md`: guarded workflow, safety invariants, failure handling, and
  completion contract;
- `scripts/release_state.py`: read-only release JSON validation and next-patch
  resolution;
- `agents/openai.yaml`: user-facing name, description, and default invocation.

The helper accepts captured GitHub release JSON so it is deterministic and
testable without authentication or network mutation. Git, GitHub CLI, and
repository-defined scripts remain the visible execution boundary for release
operations.

## Version Resolution

An explicitly requested version is authoritative after semantic-version and
ordering validation. When no version is supplied, query GitHub Releases,
exclude drafts and prereleases, select the greatest stable semantic version,
and increment only the patch component. For example, `v0.3.14` becomes
`v0.3.15`.

Do not infer the next version from a manifest alone. The published stable
release inventory is the source of truth. Refuse ambiguous, malformed, or
missing stable histories rather than guessing.

## Integration Sequence

Use one ordered, inspectable workflow:

1. Verify GitHub authentication, repository identity, branch/upstream state,
   worktree ownership, and the scope of local changes.
2. Inspect the diff and commit only intended changes. Use a concise subject and
   a commit body that summarizes the completed task, important design choices,
   and validation evidence.
3. Fetch `origin/main`, merge current `main` into the feature branch, and
   resolve conflicts by preserving both upstream fixes and intentional feature
   behavior. Never prefer one side wholesale without tracing the conflict.
4. Run the repository's focused and required broad checks on the integrated
   feature branch.
5. Merge the verified feature branch into local `main`, run the required checks
   on the exact merged result, and only then push `main`.
6. Resolve the release version, update every repository-owned version source,
   update the changelog, and run release-specific preflight checks.
7. Commit and push the release preparation, then invoke the release mechanism
   declared by the repository.
8. Monitor GitHub Actions, diagnose failures from exact job logs, make the
   smallest coherent repair with focused regression evidence, and repeat until
   the candidate is green.
9. Verify and publish the release according to the repository's draft and
   approval policy.

Do not force-push, reset away work, discard unrelated changes, weaken tests,
move a published tag, or bypass signing and asset checks.

## Changelog Ownership

The root changelog is `CHANGELOG.md`.

If it does not exist, initialize it once from the complete stable GitHub
release history. Preserve each stable release's version, publication date, and
release description, ordered newest first. Exclude drafts and prereleases.

If it exists, preserve its history and prepend the new release entry. Build the
entry from commits, merged pull requests, current task summaries, and release
descriptions since the previous stable tag. Categorize user-visible features,
fixes, compatibility or migration notes, and validation. Use that curated entry
as the GitHub release body so the changelog and release page do not drift.

## Release Failure Policy

Run repository preflight and full validation before creating a tag. Determine
the actual release trigger from the checked-in GitHub workflow: tag, manual
dispatch, draft creation, or another documented mechanism.

When a workflow fails, inspect the failed job and step, reproduce locally when
possible, and repair the owning source or test. Do not widen product deadlines,
serialize tests, skip platforms, or suppress checks merely to make the release
green.

An unpublished candidate created by the skill may be recreated at the same
version only after proving it was not distributed and the repository's release
policy permits replacement. A published release or externally visible tag is
immutable. Corrections after publication require the next patch version.

Missing credentials, unavailable signing authority, branch protection, or
external platform outages are explicit blockers. Report them with the exact
failed boundary; never print secrets or replace a secure step with an unsigned
or unverified shortcut.

## Asset Completion Contract

The checked-in release workflow and living release documentation define the
supported platform matrix. Previous releases may corroborate naming but cannot
override the current workflow.

A release is complete only when:

- the release tag resolves to the intended tested release commit;
- required local checks and GitHub workflows are green;
- the release is in the repository-required final publication state;
- every declared installer is present, nonempty, and uniquely named;
- every required checksum, updater manifest, or signature is present and
  references the tag-specific payload;
- no unexpected secret, private key, or passphrase appears in assets or logs;
- the sorted asset inventory matches the workflow's declared contract.

The final report must include the main commit, tag, release URL, workflow URLs,
asset inventory by platform and architecture, changelog path, and residual
signing or native-platform risks.

## Testing Strategy

Develop the skill with documentation TDD.

Before writing it, run fresh-agent baseline scenarios without the skill. Cover
an upstream conflict, newer drafts/prereleases, missing changelog history, a
missing platform installer despite otherwise green CI, and a failed workflow
after a visible tag. Record exact omissions and rationalizations.

After implementation, repeat the scenarios with the skill and require safe
integration, correct patch resolution, complete changelog behavior, refusal of
incomplete assets, and immutable published tags. Use temporary repositories,
fixture release JSON, and a mocked `gh` executable; do not create a real branch,
tag, release, workflow run, or asset.

Test `release_state.py` against stable, draft, prerelease, malformed, empty, and
unordered release inventories. Validate the skill with the standard skill
validator and confirm `agents/openai.yaml` matches the final `SKILL.md`.

## Alternatives Rejected

- **Instructions only:** smaller, but repeatedly reimplements semantic-version
  filtering and makes the most error-prone decision less deterministic.
- **BiBCode-specific automation:** deterministic for one current workflow but
  brittle across repositories and future platform changes.
- **Fully automated mutating release script:** hides important destructive
  boundaries and makes conflict resolution, CI diagnosis, and recovery less
  reviewable.

The selected design automates only read-only version resolution and keeps every
mutation explicit in the skill workflow.
