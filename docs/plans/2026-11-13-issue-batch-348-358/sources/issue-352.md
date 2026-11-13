# #352 Flaky under load: removal_refuses_when_an_admission_does_not_drain_before_the_deadline

`production::worktree_catalog_rpc::...removal_refuses_when_an_admission_does_not_drain_before_the_deadline` times out (`bounded admission drain: Elapsed(())`) in about one of three whole-suite runs of `cargo test -p bibcode-server` in a Windows 11 arm64 VM, on `main` and on #349 alike. Alone it passes 10 of 10 (2.8 s against a 2 s bound in one loaded run).

It is a timing bound under load, not a behaviour change. Make the test wait on the condition with a generous deadline, or control time.
