# #354 Git: lock handling for pull and hooks, sign-in detector, and two missing doc entries

Small leftovers from the #341 and #343 work in #349. Not verified by a run: found by reading the code.

- A forced stop while `git pull` is merging leaves its `index.lock` behind. `takes_index_lock` in `apps/server/src/git/process.rs` does not list `pull`, because it holds no lock while it fetches. Either list it with a watcher test, or record the limit in the code.
- A forced stop while a hook runs (pre-commit, post-checkout) relates to the lock ownership question raised in the review of #349: the hook runs without BiBCode holding the lock. Check this case against the ownership rule that #349 ends up with.
- `has_missing_username_refusal` in `apps/server/src/git/sign_in.rs` accepts any text that contains both "could not read username" and "terminal prompts disabled". A commit message or a hook's output that contains both phrases triggers the sign-in guidance. Anchor it to Git's own `fatal:` line.
- `docs/skills/bibcode-profiler/references/events.md` does not list the `git-writes` step among the `server.stop` quiesce steps.
- `docs/testing/cross-platform-validation.md` does not list the `background_status_`, `git_stop_` and `index_lock_cleanup_` test filters.
