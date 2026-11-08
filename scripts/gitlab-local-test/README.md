# Local GitLab test kit

A throwaway GitLab CE plus a shell-executor runner in Docker, isolated from any real
GitLab server and from your real `glab` login, for testing BiBCode's pipeline screens.

```sh
kit=scripts/gitlab-local-test   # from the repository root
export BIBCODE_TEST_GITLAB_STATE_DIR=$HOME/.cache/bibcode-test-gitlab   # optional, outside the repo
$kit/up.sh                       # first boot takes 5-10 min; later runs reuse the containers
eval "$($kit/seed.sh /path/to/test/clone)"   # project root/sample-project, runner, branches, glab config
$kit/pipelines.sh                # main + bibcode-pipeline-test (finish), then one long-running
glab api projects                # uses the isolated config exported above
$kit/down.sh                     # or --keep-volumes to keep the data
```

- URL `http://localhost:8929` (SSH 2224), bound to 127.0.0.1. Login `root`; the password and
  API token are in `$STATE_DIR/credentials.env` (chmod 600). Override with
  `BIBCODE_TEST_GITLAB_PORT`, `_SSH_PORT`, `_NAME` (must start `bibcode-test-gitlab`),
  `_PROJECT`, `_IMAGE`, `_RUNNER_IMAGE`.
- Images are pinned in `lib.sh`; update them there, never to `latest`.
- Runner tag `bibcode-local`, project runner, no untagged jobs. Jobs are POSIX shell and
  run inside the runner container, which clones through `http://<name>:<port>`.
- `seed.sh` only reads the source clone; it works in `$STATE_DIR/seed-repo` and installs
  `gitlab-ci.test.yml` as `.gitlab-ci.yml`.
- `down.sh` touches only `bibcode-test-gitlab*` containers, volumes and network.
