# Flaky-test diagnosis

Use the shared [failure classification and repair procedure](./cross-platform-validation.md#failure-classification-and-repair)
first. Keep the initial failure and its exact command. A passing retry alone
does not distinguish a regression, a fixture race, and a host resource limit.

For an in-flight HTTP body, a client-side stream poll proves only that the
client produced bytes, not that the server admitted the request. The Claude
terminal dormant-hook test uses `Expect: 100-continue` and waits for the
server's interim response before toggling activity. Its handler authenticates
and captures the activity generation before polling the body, and Hyper sends
Continue only when the handler asks for body data. Verify that ordering in the
handler and HTTP stack when changing this fixture; a sleep after a client-side
signal cannot establish it.

For a desktop start racing shutdown, observe the specific runtime that reached
the pre-publish gate. The lifecycle regression blocks that runtime's join,
waits for its stop-request event, and proves both callers remain pending until
the join can finish. It captures the join result synchronously when `start`
returns. A TCP connection probe is not an identity-safe cleanup oracle: the
same address can already belong to another listener or remain open in an
unrelated fork. Keep a controlled port-reuse counterexample distinct from a
natural stress failure rate, and verify that deliberately removing the cleanup
wait makes the runtime-join regression fail before restoring the real code.

For WebSocket heartbeat integration, separate exact cadence from connection
survival. Controlled-clock transport tests pin the 15-second cadence and the
restart after a scheduler stall; real sockets verify Pong-only survival for
at least 60 seconds and four observed heartbeats before a final RPC exchange.
The observation can wait up to 180 seconds when scheduling delays delivery.
Do not require a fixed Ping count inside a fixed wall-clock minute: the server
intentionally restarts its cadence after a late check. A contention harness's
process deadline must cover that bound plus setup and teardown, and every
selected invocation must actually execute the test. Keep the controlled-stall
counterexample distinct from naturally observed failures.

## Alternate base and change

For intermittent provider or terminal failures, rerun each failing case in
isolation three times, then compare the complete affected suite:

1. Build a clean detached worktree at the base revision with its own
   `CARGO_TARGET_DIR`. Build the changed revision separately. Finish both
   builds before measuring so compilation does not compete with tests.
2. Keep toolchain, environment, suite filters, and harness concurrency equal.
   Alternate base, change, base, change for a fixed number of paired runs;
   do not run all base samples before all changed samples.
3. Record each failure by test name and assertion, along with pass/fail counts,
   timeouts, and resource observations for each revision. Isolation passes are
   supporting evidence, not a replacement for the suite comparison.
4. Investigate an excess or a new failure mode on the changed side. Similar
   counts suggest a shared cause but do not prove the change is correct. If
   both revisions fail consistently, inspect host limits and fixtures too.

In-process write-then-exec fixtures can produce `ETXTBSY` when sibling tests
fork. Use the existing [hermetic executable fixture rules](./README.md#hermetic-rust-fixtures)
before attributing that error to the host. Do not label an entire supervisor
suite flaky based on an old failure rate.

## Focused Linux contention loop

To reproduce a scheduling race without loading every core, use `taskset` to
pin one already-built test binary and one busy loop to the same allowed CPU.
Get the executable from Cargo's `--no-run --message-format=json`
`compiler-artifact` output; do not guess its hashed filename. Start with about
300 separate invocations at the base and the fix, with identical settings.

The following Bash recipe counts red runs and retains each log. Choose an
active, non-ignored test and a per-run timeout that covers normal fixture
setup and cleanup. The single harness thread isolates this one test; it does
not replace the normal concurrency of the full suite.

```sh
(
set -eu
test_binary='<absolute-test-executable>'
test_name='<exact-test-name>'
evidence_dir=$(mktemp -d)
test_cpu=$(python3 -c 'import os; print(min(os.sched_getaffinity(0)))')
"$test_binary" --list | rg --fixed-strings --line-regexp "$test_name: test"
taskset -c "$test_cpu" sh -c 'while :; do :; done' &
busy_pid=$!
cleanup() {
  kill "$busy_pid" 2>/dev/null || true
  wait "$busy_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
red=0
for iteration in $(seq 1 300); do
  if timeout --kill-after=5s 60s taskset -c "$test_cpu" \
    "$test_binary" "$test_name" --exact --test-threads 1 --nocapture \
    > "$evidence_dir/run-$iteration.log" 2>&1; then
    :
  else
    result=$?
    red=$((red + 1))
    printf 'run=%s exit=%s\n' "$iteration" "$result"
  fi
done
printf 'red=%s/300 logs=%s\n' "$red" "$evidence_dir"
test "$red" -eq 0
)
```

Inspect logs for assertion failures, timeouts, and setup failures separately;
verify each invocation actually ran the selected test. Repeat with the other
revision and compare the red count and failure signatures. A zero-red fixed
run is useful only if the same setup reproduces the base failure. Restore the
full suite's default concurrency afterward. See
[`taskset(1)`](https://man7.org/linux/man-pages/man1/taskset.1.html) for CPU
affinity semantics.

## Linux host limits

### Pipe capacity

Linux accounts pipe-buffer pages per user. At `pipe-user-pages-soft`, new pipes
are limited to two pages on current kernels, which can block a fixture that
writes output before publishing a readiness marker. Probe a fresh pipe rather
than assuming a fixed capacity. See
[`pipe(7)`](https://man7.org/linux/man-pages/man7/pipe.7.html).

```sh
cat /proc/sys/fs/pipe-user-pages-soft /proc/sys/fs/pipe-max-size
python3 - <<'PY'
import fcntl
import os

reader, writer = os.pipe()
try:
    print("pipe bytes:", fcntl.fcntl(reader, fcntl.F_GETPIPE_SZ))
    print("page bytes:", os.sysconf("SC_PAGE_SIZE"))
finally:
    os.close(reader)
    os.close(writer)
PY
```

A small result is a diagnostic clue, not proof of exhaustion by itself. Count
and inspect pipe holders without printing their environments or credentials;
stop only verified idle processes owned by the test run, then probe again.
Do not change system limits or terminate unrelated tools. Fixtures must drain
output or keep pre-readiness writes bounded independently of normal pipe size.
The Claude recovery backpressure test in `production_provider_runtime.rs`
keeps its 512 stderr lines below one 4 KiB page for this reason.

### Inotify instances

Read `/proc/sys/fs/inotify/max_user_instances` and inspect the current user's
`anon_inode:inotify` descriptors under `/proc`. Descriptor counts are only an
estimate: descriptors can share an instance, and permissions can hide holders.
See [`inotify(7)`](https://man7.org/linux/man-pages/man7/inotify.7.html).

Exhausted watcher creation must preserve subscriptions and enter the fallback.
`git::watcher` tests `exhausted_backend_creation_returns_fallback_promptly` and
`exhausted_watch_registration_returns_fallback_promptly` cover creation and
registration failure; both require bounded shutdown. A low remaining instance
budget alone does not explain a hung suite.

Inspect the first stalled test for an unbounded permit wait or a lost wakeup.
In particular, `Notify::notify_waiters` does not retain a notification for a
future waiter. A waiter registered after the releasing task runs can hang and
hold a shared test permit. Lower concurrency can help diagnosis but is not a
repair. Keep system limits and other sessions untouched, and use the shared
[cleanup procedure](./cross-platform-validation.md#cleanup) for test-owned work.
