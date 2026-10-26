# Multiple Device Previews

Status: Approved 2026-10-24 with every recommended answer. Issue #170.

## Problem

Issue #170: "I want to test two diffrerent tasks in two devices but I need to
change it from the list always." With one worktree per task, the user wants
each task's thread to keep its own Android emulator or iOS simulator running
and showing, instead of stopping one device and starting another every time
they switch threads. The issue's Alternatives and Risks fields are empty; this
document supplies them.

Two things stop it today: the server runs one device per platform, and the
Device pane's choice of device is not per thread.

## Current behavior (4e023ac5ff)

Server

- `DeviceManager::open` (`apps/server/src/device/mod.rs:329`) refuses a second
  live device on a platform: `DeviceTable::running_on(platform)` (`:549`) is
  checked unlocked (`:351`) and again under the table lock (`:381`), failing
  with `DeviceLimitError { running }` ("<name> is already running. Stop it
  before starting another device.", `:70`). The original design recorded this
  as "Configurable limit: YAGNI until asked"
  (`docs/superpowers/specs/2026-10-14-android-device-previews-design.md:54`).
- `open` awaits discovery (`mod.rs:339`) and the backend's `check_available`
  (`:355`) before it takes the lock and inserts the slot (`:386`). Nothing
  else can see an open while it waits.
- `wait_ready` returns at once for a device that is neither `starting` nor
  `booting` (`mod.rs:442`), so a `stopping` device is `NotReady` immediately.
- `publish` sorts the catalog's devices by device id (`mod.rs:628`), a
  per-open UUID, so catalog order says nothing about age. It keeps the four
  newest ended devices (`RETAINED_ENDED_DEVICES`, `:48`).
- Nothing else in the manager assumes one device: slots are a map by device id
  (`mod.rs:225`), frame and media hubs live in each slot, and `close_all` and
  `shutdown` stop every slot (`mod.rs:905`, `:508`).
- Android probes console ports 5554–5682 and releases them before the emulator
  binds (`apps/server/src/device/android/emulator.rs:468-494`); the comment
  accepts the race with other programs. Nothing records the ports BiBCode has
  already handed out, so two BiBCode launches at once can pick the same pair.
  adb is addressed by serial (`emulator-<port>`, `emulator.rs:285`) and scrcpy
  forwards a fresh port with a random `scid` per session
  (`android/scrcpy.rs:216`). Android uses the default `check_available`, which
  always succeeds (`device/backend.rs:78`).
- iOS addresses simulators by UDID everywhere (never `booted`), keeps the UDIDs
  it booted (`apps/server/src/device/ios/mod.rs:471`), and registers each
  simulator's `launchd_sim` by UDID (`ios/simctl.rs:395`). `check_available`
  calls any simulator that is not `Shutdown` busy outside BiBCode
  (`ios/mod.rs:403`), including one BiBCode booted; the platform limit fires
  first today, so that path is unreachable. Each running simulator starts its
  own state poll once it runs (`ios/mod.rs:606`), which runs
  `simctl list devices available -j` every 2 s, checks its cancellation before
  recording an exit (`:614`), and is cancelled and joined first by a stop
  (`:671`). One call took about 0.1 s of CPU (user plus sys) on an
  Apple-silicon Mac with Xcode 27.1, so each simulator costs about 5% of a
  core.
- Devices have no owner. One runs until `device.close`, `device_close`, the
  setting turning off, or shutdown. Thread deletion closes the thread's
  terminals and preview gateways (`cleanup_deleted_thread`,
  `apps/server/src/production/orchestration_effects.rs:1402`;
  `production/runtime.rs:984`) but no device.

Client

- The right panel's device surface is per thread and carries nothing:
  `{ id: "device", kind: "device" }` (`apps/web/src/rightPanelStore.ts:78`,
  sanitized at `:342`).
- `ChatView` renders `DevicePanel` only while that surface is active, passing
  only the environment id (`apps/web/src/components/ChatView.tsx:6824`), and
  `DevicePanel` keys its session by environment
  (`apps/web/src/components/device/DevicePanel.tsx:214`); `SourceControlPanel`
  beside it is keyed by thread (`ChatView.tsx:6816`). A chat panel renders only
  its Activity surface (`ChatView.tsx:2045-2049`), so the Device pane belongs
  to the thread view, not to chat panels.
- The pick and the followed device are component state
  (`DevicePanel.tsx:308-309`), so they either carry over to the next thread or
  are lost with the pane; neither is per thread. `selectedImageOf` (`:112`)
  falls back to "any running device". `selectShownDevice` (`:138`) assumes at
  most one per platform, never returns a `stopped` device, and returns a
  `failed` one only when its id matches the component-local followed id, so a
  remount or an agent-started failure loses the reason.
- Start is disabled while the platform runs a device ("Stop the running device
  to start another", `deviceMessages.ts:57`; `DevicePanel.tsx:594`), an image
  without a device says "<name> is running. Stop it to start another device."
  (`:731`), and the limit banner offers one **Stop <name>**, which stops the
  first live device of that platform in catalog order (`:616`).
- Only a visible pane streams: the JPEG producer stops with its last subscriber
  (`apps/server/src/device/frames.rs:56`) and the H.264 hub with its last
  socket (`device/media.rs:938`). A device admits 4 media sockets
  (`media.rs:29`) and a session holds at most 8 tickets (`media.rs:38`). The
  desktop already shows a device in several windows
  (`docs/testing/cross-platform-validation.md`, Android device previews, step
  8), so two windows on two threads would show two devices if the server ran
  them.

Agents

- `device_open` says "One device runs per platform"
  (`apps/server/src/production/connect_mcp/device_tools.rs:313`).
  `device_screenshot` without `deviceId` takes the only live device and fails
  otherwise (`device_id`, `:232`). `device_close` stops any device.
  `DeviceTools::call` receives the caller's `PreviewScope`, thread id included,
  and only logs it (`:56`, `:64`).
- A chat panel's agent gets its MCP credential for its own thread id
  (`production/provider_runtime.rs:1210`), not its host's.
  `build_launch_request` already reads the thread row (`provider_runtime.rs:4868`),
  which carries `host_thread_id` (`persistence/repositories.rs:2341`).

## Goals

- Several devices run at once on one environment, of either platform, up to a
  fixed limit.
- Returning to a thread shows that thread's device, or its last attempt and
  why it ended, without picking it again.
- A device a thread started stops when that thread is deleted.
- An agent's default device is its own thread's, and it cannot start or stop a
  device another thread is using. A chat panel's agent and its host thread are
  one thread for devices.
- No new RPC method, stream, or capability; older clients and servers keep
  working.

## Non-goals

- Two instances of one image. The emulator allows it only with `-read-only`,
  which discards the extra instances' writes and was introduced as
  experimental (emulator 28.0.0 notes,
  https://androidstudio.googleblog.com/2018/07/emulator-2800-canary.html; the
  current command-line reference does not list it). An image runs once.
- Two devices side by side in one window. The right panel shows one surface at
  a time; a second desktop window or browser tab on another thread shows a
  second device.
- A tab per device in one thread, a configurable limit, memory-aware
  admission, stopping idle devices, and moving a device to another thread.
- Naming the tab after its device: the picker names it directly under the tab,
  and the tab strip would need the catalog.

## Alternatives

**A. Status quo, documented.** An emulator and a simulator already run side
by side. Rejected: the issue is two tasks on one platform.

**B. Raise the server limit only.** Smallest change, but the pane still falls
back to "any running device", so every thread shows whichever device the
catalog lists first and the user still changes it in every worktree.

**C. B plus a client-only binding.** Persist the picked image in each thread's
device surface. Fixes the user's own starts, but a device an agent started is
invisible to its thread's pane, nothing ties a device to a thread for cleanup,
and agents cannot tell their device from another thread's. With a hard limit
of four, a device left behind by a deleted thread holds one of four places
until someone notices it, and two threads' agents each taking a screenshot
without `deviceId` both fail once two devices run. This is the fallback if
ownership is split out (see Decision).

**D. B plus the owner thread on the server and the pick on the client.**
`device.open` records the thread that started the device and the catalog
shows it. The pane derives "this thread's device" from the catalog; the
persisted pick only remembers what to show or start. Thread deletion and the
agent tools use the same field.

**E. Thread-scoped devices.** Each thread sees and controls only its own.
Isolates tasks best, but removes looking at another thread's device, which
works today, and hides devices that count against the limit.

**F. One surface per device (`device:<platform>:<imageId>`, like browser
tabs).** One-click switching between a thread's devices. More store, tab, and
command-palette surface for a case the picker covers, and it does not address
the per-thread problem. Deferred.

## Decision

**D**, with a fixed limit of four live devices per environment, any mix of
platforms, one device per image, and one owner scope: the root thread (a chat
panel's host, else the thread itself) for the pane and the agent tools alike.

Four covers the issue's two tasks on one platform, or two on each. The local
Pixel 8 AVD reserves 2 GB of guest RAM and 4 cores (`hw.ramSize=2G`,
`hw.cpu.ncore=4` in its `config.ini`), and Google recommends a 16 GB host for
the emulator (https://developer.android.com/studio/run/emulator), so four
emulators already exceed small hosts, which fail at boot with the emulator's
own reason. Xcode has run several simulators at once since Xcode 9
(https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/WhatsNewXcode/xcode_9/xcode_9.html),
and the console range allows 64 emulators
(https://developer.android.com/studio/run/emulator-commandline).

What this trades away: a number fitted to no particular host, an owner that is
a label rather than a permission (see Trust boundaries), and more lifecycle
code than C. If the owner is not approved, the change ships C: the limit, one
device per image, port reservation, open-order catalog, the per-thread pick,
and ended-device display, with no `threadId` anywhere, and ownership follows
as its own design that starts from the rules below.

## Answers to the issue's questions

The issue asks none explicitly; these are the ones its proposal implies.

- **How many?** Four live devices per environment. A fifth start lists the four
  and offers to stop each.
- **How does a worktree keep its device?** The thread that starts a device owns
  it, and returning to that thread shows it, or its last attempt and why it
  ended. A thread with nothing running shows the image it last picked, ready
  to start.
- **Can two threads share a device?** Yes, by picking it. The pane says which
  thread started it, and both control it, as two clients on one device do
  today.
- **What do agents see?** Every device, each marked as their thread's or not;
  their defaults are their thread's. A chat panel's agent counts as its host.
- **What happens when a task ends?** Deleting its thread stops the devices it
  started. Archiving does not: a boot takes minutes and an archived thread can
  return.

## Server

- **Limit.** `MAX_RUNNING_DEVICES = 4` replaces `running_on(platform)`: a count
  of slots not `stopped` or `failed`, checked unlocked and again under the
  table lock as today. A `stopping` device counts until it is gone.
  `DeviceOpError::Limit` keeps its `running` string, now the display name of
  the first live device on the requested platform in catalog order (else the
  first live device), with the message "Four devices are already running, the
  most this server runs at once. Stop one to start another."
- **Catalog order.** `publish` sorts devices by `seq`, their open order,
  instead of by id. The first live device is then the oldest, so the name in
  the limit error is the device an older client's **Stop <name>** stops
  (`DevicePanel.tsx:616`), and a client finds an image's newest attempt
  without component state. Retention is unchanged. No client depends on id
  order; the comment at `DevicePanel.tsx:107-110` goes.
- **One device per image.** For image I, admission looks at I's slots, unlocked
  first and authoritatively under the insertion lock:
  - a slot `starting`, `booting`, or `ready`: return its device id, start
    nothing, keep its owner;
  - a slot `stopping`: refuse with `NotReady(Stopping)`, whose message becomes
    "This device is still stopping. Start it again once it has stopped."
    (`not_ready_message` splits its `Stopping | Stopped` arm; `Stopped` keeps
    today's text). The pane disables Start meanwhile, so only racing callers
    see it;
  - otherwise (none, or only ended ones): start a new device after the checks
    below.

  The unlocked attach runs before `check_available`, so iOS no longer reports
  its own simulator as busy outside BiBCode. Two concurrent iOS opens of one
  image can both miss the slot; the second's `check_available` may then see
  the simulator the first is booting and return `Busy`. On `Busy`, `open`
  retakes the lock and attaches to a `starting`, `booting`, or `ready` slot of
  I if one now exists, and returns `Busy` only if none does. No slot is
  reserved before the check: that would publish a `starting` device for an
  open the check may still refuse. Android's check always succeeds, so its
  second open attaches under the insertion lock.

- **Owner.** `device.open` takes an optional `threadId`. The server trims it
  and refuses one that is empty after trimming with `DeviceInputError`
  ("threadId must name a thread."), so every published owner decodes as
  `ThreadId` unchanged. The owner is the root thread: the pane sends its
  thread's `hostThreadId`, else its id, and MCP uses `PreviewScope`'s owner
  (see Agents). The slot stores it and `DeviceSnapshot` publishes it. Ended
  slots keep it, so the retained ended devices still say whose they were.
- **Thread deletion.** A new `OrchestrationEffectCallbacks::close_devices`
  (default no-op, like `close_previews` at `orchestration_effects.rs:98`),
  called from `cleanup_deleted_thread` after `close_previews`, runs
  `DeviceManager::stop_thread(thread_id)`. Under the table lock it records the
  id in a list of recent deletions (the last 256, oldest dropped first) and
  starts the close of every live slot with that owner on the manager's tasks.
  It returns without waiting for the reap, so a 10 s emulator stop never holds
  up the deletion, and has nothing to fail on; each stop keeps today's
  logging. `open` checks the owner against the list before discovery and again
  under the insertion lock, and refuses with a new
  `DeviceOpError::OwnerDeleted`, mapped to the existing `DeviceNotFoundError`
  ("This thread was deleted, so its device was not started."). So a deletion
  that lands while an open awaits discovery or `check_available` refuses that
  open, and a late `device.open` from a client that has not seen the deletion
  yet is refused too. The manager never reads the read model; the list is fed
  by the same effect that stops the devices. Deleting a host emits
  `thread.deleted` for each of its chat panel threads too
  (`thread_delete_cascades_to_live_and_archived_host_panels`,
  `apps/server/src/orchestration/engine.rs:7607`); devices are owned by the
  host, so the host's deletion stops them.
- **Android ports.** `AndroidBackend` records the console and gRPC ports of
  every launch until its device ends, its launch fails, or it is cancelled,
  and `pick_ports` skips them. Races with programs outside BiBCode stay as
  documented at `emulator.rs:468`.
- **iOS state poll.** One backend task replaces the per-simulator polls:
  - `IosBackend` keeps a registry of running simulators, UDID to a
    registration with a generation number and its exit slot. A simulator
    registers where its poll starts today (`ios/mod.rs:606`), once it runs,
    and unregisters at the step of its stop that cancels the poll today
    (`:671`).
  - While the registry is not empty, one task copies the registered
    (UDID, generation) pairs every 2 s, runs one `simctl list`, and then,
    under the registry lock, applies the listing only to pairs still
    registered with the same generation: not listed is `Deleted outside
    BiBCode`, listed but not `Booted` is `Shutdown outside BiBCode`, recorded
    once, as today. A failed listing is logged at debug and retried at the
    next tick.
  - A simulator that registered after a listing began is not in its copy, so a
    pre-boot `Shutdown` never fails it. One that unregistered, or stopped and
    was opened again under a new generation, is skipped, so a stop is never
    taken for an outside shutdown. Unregistering takes the same lock, so once
    it returns no listing can mark that simulator.
  - The last unregister takes the task out of the registry, cancels it, and
    awaits it, as each stop joins its own poll today; the next registration
    starts a new task. Manager shutdown stops every device, so the last stop
    joins the task and nothing outlives `DeviceManager::shutdown`.

## Protocol, schema, and persistence

- `DeviceOpenInput` gains `threadId: Schema.optionalKey(ThreadId)`
  (`packages/contracts/src/device.ts:124`); the Rust `DeviceOpenInput`
  (`production/device_rpc.rs:22`) gains `thread_id: Option<String>`,
  normalized as above before admission. It does not deny unknown fields, so an
  older server ignores `threadId` and keeps one device per platform.
- `DeviceSnapshot` gains `threadId: Schema.optionalKey(ThreadId)`
  (`device.ts:65`; Rust `device/catalog.rs:142`, skipped when `None`), the
  normalized owner. Older clients ignore it: Effect Schema strips unknown keys
  unless a decode asks for `onExcessProperty: "error"`
  (`.repos/effect-smol/packages/effect/src/SchemaAST.ts:490`), which only
  contract tests do.
- The catalog lists devices in open order. This changes no schema.
- `DeviceLimitError` keeps its shape (`device.ts:170`); its message and the
  choice of `running` change. The new Rust variants map to existing tags:
  `OwnerDeleted` to `DeviceNotFoundError`, and the agent refusal below to
  `DeviceBusyError`. No contract error is added.
- The device surface becomes
  `{ id: "device", kind: "device", image?: { platform, imageId } }`. The
  sanitizer (`rightPanelStore.ts:342`) keeps a well-formed `image` and drops a
  malformed one, so the storage version stays 10 and an older client simply
  drops the field. It stores an image id (an AVD name or a simulator UDID),
  which outlives server restarts, never a device id, which is a per-open UUID.
  Closing the Device tab discards the pick with the surface.
- The server persists nothing new; devices, owners, and the recent-deletions
  list end with the server.

## Client

`ChatView` passes the thread ref and its root id (`hostThreadId`, else its
id). For thread T, "T's devices" are devices whose `threadId` is T's root.
`selectedImageOf` stays a pure function of the catalog, the stored pick, and
the root id, and picks:

1. the stored pick, while the catalog lists the image, live or not;
2. else the image of T's oldest live device;
3. else the image of T's newest ended device, so an agent-started failure
   stays in view;
4. else the first image that is neither running nor in use elsewhere;
5. else nothing.

A fallback never overwrites the stored pick, so a pick whose image is missing
while discovery runs comes back once the catalog lists it. The pick is the
user's intent, so it always wins: with Pixel 8 running in T, picking iPhone
shows iPhone ready to Start, and the picker still lists Pixel 8 as running
here. Picking writes the image to T's surface, and Start writes the selected
image before it sends `device.open`, so leaving T during the open still shows
it on return. A thread whose user has picked nothing shows the device its
agent starts (rule 2); a thread with a pick lists the agent's device in the
picker as running here rather than switching to it.

`selectShownDevice` drops the followed id and reads only the catalog: the
selected image's live device (at most one), else its newest ended device,
`stopped` or `failed`, the last one in open order. A remount, an agent-started
failure, and a stop caused by another thread's deletion all show the same
way. The catalog keeps the four newest ended devices of the environment, so an
older attempt drops out and the image shows ready to Start.
`DeviceSession` is keyed by thread so notes, errors, and the input queue never
cross threads.

## UI (UI.md)

- **Picker.** Running images stay pickable and say whose they are: "Pixel 8 —
  Running here", "Pixel 8 — Running in Fix login" (the thread's title), or
  "Pixel 8 — Running" when there is no owner or the thread is unknown. The
  list shows what the user would otherwise have to remember. Images running
  outside BiBCode keep "— Running outside BiBCode" and stay disabled.
- **Another thread's device** shows live with the status line "Started in Fix
  login." Input works, as with two viewers today.
- **An ended device** shows its last state: a failed one as today, with its
  reason and "Press Start to try again, or pick another device."; a stopped
  one as "Pixel 8 stopped." with "Press Start to start it again.", or "Press
  Start to start it." when another thread started it. An ended device of
  another thread also carries the "Started in Fix login." line, so a thread
  that lands on that image through rule 4 sees whose attempt it is. Today a
  `stopped` device would fall into the "Starting…" message (`DevicePanel.tsx:749`),
  so this branch is new.
- **Start** is disabled at the limit, with "Four devices are running. Stop one
  to start another."; while the selected image's device is stopping, with the
  existing "The device is stopping"; and while a start is pending. The old
  "Stop the running device to start another" and "<name> is running. Stop it to
  start another device." go: they describe a rule that no longer exists.
- **Limit banner.** A refused start lists each live device as **Stop <name>**
  (at most four buttons, wrapping), read from the catalog rather than the
  error's one name.
- **Stopping another thread's device** asks first, because it ends that task's
  session and a new boot takes minutes: "Stop Pixel 8? It was started in Fix
  login." with **Stop device** and **Cancel** ("started in another thread"
  when the title is unknown). Stopping this thread's device or one without an
  owner asks nothing, as today.
- No new setting: the limit is policy, not a choice the user should have to
  make (UI.md, Reduce decisions).

## Agents

- **Owner scope.** `issue_mcp_credential` takes the owner thread id and stores
  it as `PreviewScope.owner_thread_id`: the thread's `host_thread_id` for a
  chat panel, else its own id. `build_launch_request` reads it from the thread
  row it already loads and carries it on `ProviderLaunchRequest` as
  `host_thread_id: Option<String>`. Credential retention stays keyed on
  `thread_id`. A chat panel's agent and its host's Device pane therefore share
  one owner, and every rule below compares owners.
- `device_list` adds `thisThread: true | false` to each device.
- `device_open` records the caller's owner. An image `starting`, `booting`, or
  `ready` for the caller's owner, or for no owner, returns that device
  (waiting for `ready` as today). One live for another owner fails with
  `DeviceBusyError`: "Pixel 8 is in use by another thread. Start a different
  image, or look at it with device_screenshot." A stopping image fails with
  the `NotReady(Stopping)` message. The descriptor drops "One device runs per
  platform", states the limit, and says that opening a running image of the
  agent's thread returns it.
- `device_screenshot` without `deviceId` takes the caller's only live device,
  else the only live device, else fails listing the live ids. It works on any
  device.
- `device_close` refuses another owner's device: "Pixel 8 was started by
  another thread. Ask the user to stop it." A device without an owner, from an
  older client, can be closed by any agent, as today.
- The overview's invariant that a provider MCP credential is the operate grant
  stays true; these refusals isolate tasks, they are not access control.

## Trust boundaries

`threadId` on `device.open` is an unverified label from an authenticated
client that can already open and close every device on the environment. It
grants nothing: it drives selection, display, the thread-deletion stop, and
the agent refusals. A client that labels a device with another thread's id can
make that thread's deletion stop it, which it could do directly, or keep that
thread's agent from closing it. The server normalizes it to a `ThreadId` and
never resolves it against the read model; the RPC frame limit bounds its size.
The agent-side owner comes from `PreviewScope`, which `provider_runtime`
issues with the credential from the thread row. The recent-deletions list is
written only by the `thread.deleted` effect. No new process, filesystem,
network, or desktop-bridge path.

## Failure, cancellation, reconnect, concurrency

- Two opens racing for the fourth place: the locked check admits one, the
  other gets `DeviceLimitError`.
- Two opens of one image: one slot, both get its id, the first owner kept
  (Android under the insertion lock; iOS through the recheck on `Busy`).
- An open of a stopping image is refused until the stop ends; the pane
  disables Start meanwhile.
- A dropped `device.open` behaves as today: the launch runs on the manager's
  tasks.
- A thread deleted while its open awaits discovery or `check_available`: the
  open is refused at insertion and starts nothing. Deleted while its device
  boots: `stop_thread` cancels the launch, which stops what it started.
- A thread deleted while another thread watches its device: the device stops,
  and the watcher's pane shows "Pixel 8 stopped." from the catalog with its
  pick ready to Start.
- Reconnect: the catalog stream resubscribes with `threadId`, and selection is
  recomputed; the stored pick needs no server state.
- Setting off, shutdown, and exit handling already iterate every slot;
  shutdown now runs up to four stops in parallel, each bounded as today, and
  the last iOS stop joins the shared poll.
- Concurrent iOS opens each run `check_available`'s `simctl list` (up to 15 s);
  two at once are acceptable.
- Port reservation is per process: another BiBCode server on the host, or the
  user's own emulator, can still take a probed port, and that device fails
  with the emulator's reason, as today.

## Performance

- Streaming scales with visible panes, not live devices: producers stop with
  their last subscriber, and one window shows one device. Each extra visible
  device adds its stream (scrcpy at most 4 Mbit/s and 30 fps; VideoToolbox
  2–12 Mbit/s; or JPEG at most 15 fps) and a decoder in that window.
- An unwatched device costs its guest's CPU and memory plus BiBCode's
  watchers: Android's 1 s exit check reads the child's status in-process, and
  the shared iOS poll makes four simulators cost one `simctl list` per 2 s, as
  one does now.
- Catalog publishes stay O(devices), at most four live and four ended, and
  sort by an integer; selection is O(devices). The recent-deletions list holds
  at most 256 ids, scanned twice per open.
- Media limits fit: four sockets per device, and a session's eight tickets
  cover two devices each retrying three times within 60 s.

## Profiler coverage

- Child processes: spawn paths unchanged. Each emulator stays a registered
  `android-emulator` helper and each `launchd_sim` is registered by UDID, so
  the sampler attributes several; an unrequested exit still raises
  `subprocess.crash` per device. The shared poll's `simctl list` runs through
  the same runner as today's polls.
- RPC methods: none added; `device.open` and `device.close` are already in
  `is_long_running` (`apps/server/src/diagnostics/profiler/latency.rs:151`).
- Events: `device.lifecycle` gains `running`, the count of live devices after
  the transition, so a memory or CPU finding can be read against it. It names
  no thread, image, or device. Update
  `docs/skills/bibcode-profiler/references/events.md` and the overview's
  Profiler section.
- Shutdown: no new service; `DeviceManager::shutdown` keeps its place before
  the profiler's teardown. Worktree removal, binaries, and re-exec modes are
  untouched.

## Files to change

- Server: `apps/server/src/device/mod.rs` (limit, open-order publish, attach
  rules, `Busy` recheck, owner, recent deletions, `stop_thread`, new error
  variants, `running` in `record_lifecycle`, module docs),
  `device/catalog.rs`, `device/fake_backend.rs` (holds on `discover` and
  `check_available` for the interleaving tests), `device/android/mod.rs` and
  `android/emulator.rs` (ports), `device/ios/mod.rs` (shared poll),
  `production/device_rpc.rs` (input and normalization),
  `production/connect_mcp.rs` (`PreviewScope.owner_thread_id`,
  `issue_mcp_credential`), `production/connect_mcp/device_tools.rs`,
  `production/provider_runtime.rs` (`host_thread_id` on the launch request),
  `production/orchestration_effects.rs`, `production/runtime.rs`.
- Contracts: `packages/contracts/src/device.ts`, regenerated
  `packages/contracts/fixtures/rpc-wire/`.
- Web: `apps/web/src/rightPanelStore.ts` (`image`, sanitizer, a
  `setDeviceImage` action), `components/ChatView.tsx`,
  `components/device/DevicePanel.tsx`, `DeviceToolbar.tsx`,
  `deviceMessages.ts`, and `apps/web/src/state/device.ts` if the open command
  shapes its input.
- Living docs, same change: `docs/architecture/overview.md` (Device previews:
  limit, catalog order, owner and root thread, attach, deletion, agents,
  shared iOS poll); `docs/architecture/rpc-and-orchestration.md` (`device.open`
  payload, and its `is_long_running` sentence, which omits `device.open`
  although `latency.rs:151` lists it); `docs/user/workspace-ui.md` (Device
  previews, Agents, Current limitations);
  `docs/testing/cross-platform-validation.md` (Android and iOS simulator
  previews) and `docs/testing/macos-desktop.md`; profiler `events.md`.

## Test plan (each fails before the change)

Server unit (`cargo test -p bibcode-server --lib device::`):

- `open_publishes_states_and_enforces_one_device` (`mod.rs:1069`) becomes: a
  second image on one platform opens; a fifth live device is refused; a
  `stopping` device still counts.
- Open order: with device ids from a test-only id source in `mod.rs` that
  issues them in descending order, so id order is the reverse of open order,
  the catalog lists devices in open order, and the limit error names the
  first live device on the requested platform in that order, the one an older
  client's banner stops.
- Attach: opening a `starting`, `booting`, or `ready` image returns its id with
  one backend launch, owner unchanged; opening a `stopping` image is refused
  with `NotReady(Stopping)` and launches nothing; reopening a BiBCode-booted iOS
  simulator attaches instead of `Busy`.
- Same-image race: with a second open held in `check_available`, a first open
  of the image starts it and the fake then reports it busy; released, the
  second open returns the first's id, with one launch and the first owner.
- Owner: `" t1 "` is stored and published as `t1`; a blank `threadId` is
  refused with `DeviceInputError`.
- `stop_thread` stops only that owner's live devices and returns before the
  reap; a deleted thread's booting device ends `stopped`. A deletion while an
  open is held in discovery, and another while held in `check_available`,
  refuse that open with `OwnerDeleted`, insert no slot, and launch nothing; an
  open naming a recently deleted thread is refused.
- Two concurrent Android launches get different console ports (fake SDK), and
  the ports are free again after the stop.
- iOS poll (counting, holdable fake runner): two running simulators make one
  `simctl list` per interval; an outside shutdown of one fails only that one;
  a listing begun before simulator B registered and delivered after B runs
  leaves B running; a listing in flight during A's stop leaves A `stopped`
  with no outside reason; a listing begun before A was stopped and opened again
  does not touch the new A; the last stop joins the task, and none runs after
  `shutdown`.
- `device.lifecycle` carries `running`.

Server integration (`--test device_rpc --test production_connect_mcp`):

- `device.open` with `threadId` shows it in the catalog; without it the
  snapshot has none; a padded one is published trimmed and a blank one fails.
- `device_list` marks `thisThread`; `device_screenshot` without an id takes the
  caller's device when two run; `device_open` of another thread's image and
  `device_close` of another thread's device fail; the caller's own image
  attaches. A credential issued for a chat panel thread records its host as
  owner, and that agent attaches to and closes a device the host started.
- `thread.deleted` calls `close_devices` (extend the counting callbacks at
  `orchestration_effects.rs:2290`).

Web, from the root
(`vp test run packages/contracts/src/device.test.ts apps/web/src/components/device apps/web/src/rightPanelStore`)
and, because root runs leave components uncompiled, again from `apps/web`
(`vp test run --project unit src/components/device src/rightPanelStore`), as
`docs/testing/cross-platform-validation.md` requires for compiler-sensitive
files:

- `selectedImageOf` rules 1–5: picking an idle image while T's device runs
  selects the idle image; with no pick, T's agent-started device is selected,
  and after it fails its image stays selected; a device owned by T's host
  counts for T; a missing pick returns once the catalog lists it; an older
  server's catalog without `threadId` falls through to rule 4.
- `selectShownDevice`: the live device, else the newest ended one of the
  selected image; a stopped attempt newer than a failed one hides the failure.
- Mounted: two threads with two devices, switching shows each thread's device;
  each thread's pick and failed attempt survive a remount; a device stopped by
  another thread's deletion shows "stopped" with Start enabled; the sanitizer
  keeps a valid `image` and drops a bad one.
- Start stays enabled with a same-platform device running, is disabled with
  the limit reason at four and with the stopping reason while the selected
  image stops; the banner lists four Stop buttons; Stop asks for another
  thread's device and not for this thread's or an unowned one.
- Contracts: `device.test.ts` decodes snapshots with and without `threadId`,
  and a server-produced snapshot round-trips unchanged; `check:contracts` and
  `rpcRustParity.test.ts` pass.

## Verification

- Gates: the focused tests, `cargo fmt --all --check`, Clippy with warnings
  denied, `vp check`, `vp run typecheck`, the UI.md review of the picker,
  ended states, banner, and confirmation, and the `vercel-react-best-practices`
  review of `DevicePanel` and the store change.
- Native, macOS host: two AVDs in two threads on two worktrees; switching
  threads shows each one's device; typing in one reaches only it; two desktop
  windows show both with video; deleting one thread reaps its emulator while
  the other runs; a fifth start is refused. Repeat with two live iOS
  simulators, and with one of each. Two CoreSimulator screens, HID
  connections, and VideoToolbox sessions in one process have never run
  together, so this run is their first evidence. Record host RAM and CPU with
  four devices in the execution report, not the runbook.
- Agents: two threads' agents each open a different AVD and take a screenshot
  without `deviceId`, each getting its own; one's `device_close` of the
  other's device is refused; a chat panel's agent screenshots and closes its
  host's device.

## Rollout

One release, no capability flag. A new client on an older server can press
Start for a second device on a platform and gets the old `DeviceLimitError`,
whose banner offers Stop; with no owners in the catalog, selection falls back
to the pick and then the first free image. An older client on a newer server
still disables Start while its platform runs a device, so it starts at most
one per platform, sends no `threadId` (its devices have no owner), and shows
other clients' extra devices through its old fallback; its limit banner stops
the device it names, because the catalog is in open order. Land after the
reload-devices button (#169), which edits the device toolbar and messages, and
rebase the picker changes on it.

## Risks

- Several live simulators in one server process are unproven; CoreSimulator,
  SimulatorKit, or the DTUHID connection may keep per-process state. The native
  run is required before release. If it fails, iOS stays at one live simulator
  (further ones view only) while Android ships.
- Host memory: four devices can exhaust a 16 GB host; the emulator fails to
  boot or the host swaps. BiBCode shows the failure but does not prevent it.
- The shared iOS poll replaces a per-launch poll that has shipped; its stale-
  result rules are covered by the fake-runner tests, but the native run is its
  first evidence against a real `simctl`.
- The recent-deletions list holds 256 ids: an open would have to span 256
  deletions, or a stale client would have to open a thread deleted 256
  deletions ago, for a device to outlive its thread. Such a device runs
  unowned in effect, as every device does today, and the limit banner stops
  it.
- The catalog keeps four ended devices for the whole environment, so with
  several threads an attempt's reason can drop out before its thread is shown
  again.
- The owner is the opener: a device started in one thread and then used from
  another still stops with the first thread.

## Review

Codex's critique, each finding checked against the code at 4e023ac5ff:

1. **Deletion races a pending open (major): accepted.** `open` awaits
   discovery (`mod.rs:339`) and `check_available` (`:355`) before inserting
   (`:386`). `stop_thread` now records recent deletions, and `open` checks them
   before discovery and under the insertion lock (Server, Thread deletion).
   Tests hold the open in each await.
2. **Owner can break the catalog schema (major): accepted.** `ThreadId` is
   `TrimmedNonEmptyString` (`baseSchemas.ts:14`, `:32`) and `decode` uses only
   Serde (`device_rpc.rs:246`). The server trims and refuses blank ids before
   admission; tests cover padded, blank, and round trip.
3. **Concurrent same-image opens can return `Busy` (major): accepted, iOS
   only.** Android's `check_available` always succeeds (`backend.rs:78`), but
   iOS's sees a booting simulator as busy (`ios/mod.rs:414`). `open` rechecks
   for a live slot under the lock on `Busy`; no reservation, which would
   publish doomed opens. Test holds the second check.
4. **Pane and agent ownership disagree for chat panels (major): accepted.**
   Panels render only Activity (`ChatView.tsx:2045-2049`) and credentials
   carry the panel's id (`provider_runtime.rs:1210`). One owner scope, the root
   thread, now serves both: the pane sends `hostThreadId` else its id, and the
   credential's `PreviewScope.owner_thread_id` comes from the row
   `build_launch_request` already reads. The old "raw thread ids" limitation
   is gone.
5. **Ended-device recovery unspecified (major): accepted.**
   `selectShownDevice` never returns `stopped` and keys `failed` on component
   state (`DevicePanel.tsx:138-152`). Selection now reads the newest ended
   attempt of the selected image from the catalog, with rule 3 for unpicked
   threads and a new stopped message; tests cover remounts, agent failures,
   and deletion while watching.
6. **Older client may stop a different device (major): accepted.** The
   catalog was sorted by UUID (`mod.rs:628`) while the old banner stops the
   first same-platform entry (`DevicePanel.tsx:616`). The catalog is now in open
   order and the limit error names the first live same-platform device in it;
   a server test pins that pairing. The risk is removed.
7. **Shared iOS poll lacks stale-result and teardown rules (major):
   accepted.** Today's poll starts only once its simulator runs
   (`ios/mod.rs:606`), so a shared one would meet booting simulators. The poll
   now applies each listing only to registrations copied at its start, under
   the registry lock, and the last unregister joins it; tests delay listings
   across boot, stop, and reopen.
8. **Attaching to a stopping device (minor): accepted.** `wait_ready` rejects
   `stopping` at once (`mod.rs:442`). Attach covers only `starting`,
   `booting`, and `ready`; a stopping image is refused, and the pane disables
   Start with the existing stopping reason.
9. **React Compiler path missing (minor): accepted.**
   `docs/testing/cross-platform-validation.md:3058` requires the `apps/web`
   run; the Test plan adds it, with mounted switching and remount tests.

**Simpler alternative (split ownership out): not adopted, offered as a
decision.** Findings 1, 2, 4, and part of 5 come from ownership, and each now
has a specified rule. Without ownership, raising the limit makes agents worse
off than today: an agent's device is not shown in its thread's pane, a deleted
thread's device holds one of four places, and default screenshots fail once
two devices run. The Decision names the split as the fallback if the owner is
not approved.
