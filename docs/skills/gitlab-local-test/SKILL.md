---
name: gitlab-local-test
description: Run GitLab-dependent BiBCode tests (pipelines, merge requests, Git Manager, sign-in) against a throwaway local GitLab CE plus runner in Docker, never a real GitLab server. Use whenever a test, validation or UI check needs real GitLab behaviour or a working CI runner.
---

# Local GitLab test kit

Any test that needs real GitLab behaviour runs against a local, throwaway
GitLab CE and runner in Docker. Never use a real GitLab server, a real account,
or anyone's `glab` login. The repository is public, so follow AGENTS.md
"Sensitive Data" for everything you record.

The scripts live in [`scripts/gitlab-local-test/`](../../../scripts/gitlab-local-test/README.md).

## Run it

```sh
export BIBCODE_TEST_GITLAB_STATE_DIR=<a folder outside the repo, such as your session scratchpad>
scripts/gitlab-local-test/up.sh                           # first boot about 3 minutes; later runs reuse it
eval "$(scripts/gitlab-local-test/seed.sh <test-clone>)"  # exports GLAB_CONFIG_DIR
scripts/gitlab-local-test/pipelines.sh                    # finished pipelines plus one long-running
```

- The UI and API are on `http://localhost:8929` (127.0.0.1 only). Log in as
  `root`; the generated password and API token are in
  `$BIBCODE_TEST_GITLAB_STATE_DIR/credentials.env`. Never print or commit them.
- `seed.sh` creates `root/sample-project`, pushes `main` and
  `bibcode-pipeline-test` from a copy of `<test-clone>` (any small Git
  repository you own), registers a project runner tagged `bibcode-local`, and
  writes an isolated `glab` config. Use only the exported `GLAB_CONFIG_DIR`.
- The test pipeline (`gitlab-ci.test.yml`) covers stages, `needs` (including
  `needs: []`), a parallel job with a long name, a stage-scheduled job, an
  allowed failure, a manual job and a 120-second job for live statuses.

## Point BiBCode at it

Start the server under test with the same `GLAB_CONFIG_DIR` in its environment
and add a clone of `http://localhost:8929/root/sample-project` as a project.
BiBCode then reads pipelines and merge requests from the local host. Drive the
browser or packaged app as the runbooks in `docs/testing/` describe.

## Clean up

```sh
scripts/gitlab-local-test/down.sh                 # removes bibcode-test-gitlab* containers, network and volumes
scripts/gitlab-local-test/down.sh --keep-volumes  # keeps the data for next time
```

GitLab needs about 4 GiB of RAM in Docker and about 500 MB of volumes. Run
`down.sh` when the session ends. Image versions are pinned in `lib.sh`; update
them there, never to `latest`.
