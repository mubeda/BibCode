# Paired remote environment identity: design

Status: approved in conversation on 2026-09-04 ("Key remotes by storage id").

## Problem

Every BiBCode server reports the same environment id. `ServerConfig::default`
sets `environment_id: "local"` (`apps/server/src/config.rs:90`) and nothing
overrides it — not the standalone server, not the server the desktop app runs
in process. The `/.well-known/bibcode/environment` descriptor therefore says
`"local"` on every host.

The client keys its environment registry by `target.environmentId`
(`EnvironmentRegistry.installEntryLocked`), and the pairing flow takes that id
straight from the remote descriptor
(`verifyAndAddPairingCode`: `environmentId: descriptor.environmentId`). The
desktop's own primary registration takes its id from its own server's
descriptor the same way (`web.connectionPlatform.loadPrimaryConnectionRegistration`).

So the desktop app's own **Local** environment occupies registry key `"local"`,
and every remote server claims that same key. `verifyAndAddPairingCode` sees
the key taken and rejects the pairing:

```
if (entries.has(descriptor.environmentId)) → PairingAddError(duplicate-storage-identity)
```

Observed as **Add Server → "Server already saved"** with an empty saved-server
list, reproduced end to end in the desktop app on a data root that had never
seen the remote host. Removing the saved server cannot help: the entry it
collides with is Local, which is not removable.

The same collision would make two different remote servers overwrite each
other in the registry, because both call themselves `"local"`.

## Decisions

### D1. A paired remote's client-side id is derived from its storage instance id

`verifyAndAddPairingCode` derives the environment id it registers from the
pairing payload's `storageInstanceId` — a UUID minted per data root
(`persistence::StorageInstanceId`) that the payload already carries and that
pairing already verifies against the authenticated session. The id is
`remote:<storageInstanceId>`, matching the existing `wsl:` / `ssh:` /
`desktop-local:` namespacing conventions. `connectionId` follows it, so the
accepted-storage-identity key (`bearer:<connectionId>`) is unique per host too.

Consequences:

- A remote can never collide with the client's own Local environment, and two
  remotes can never collide with each other.
- `entries.has(...)` becomes a _meaningful_ duplicate check rather than an
  accidental one: the same data root always derives the same id, so re-adding
  a server that is already saved is still refused, and the refusal now names
  the entry it collided with.
- The manual endpoint+token path (`prepareBearerRegistration`) derives the same
  way from `descriptor.storageInstanceId`, falling back to
  `descriptor.environmentId` when a server reports no storage id, which is the
  behaviour that path has today.

### D2. The server-reported id is stored, not inferred

`BearerConnectionTarget` gains `serverEnvironmentId`, the id the host declares
about itself, so the resolver keeps checking that the endpoint still reports
the environment the client saved. Client-side identity and host-declared
identity become two different fields instead of one overloaded one.

The field is `Schema.NullOr(EnvironmentId)` with a decoding default of `null`,
and readers fall back to `target.environmentId`. Rows written before this
change carry the host-declared id in `environmentId`, so the fallback is exactly
right for them and no migration step is needed.

`RemoteEnvironmentAuthorization.authorizeBearer` keeps its
`expectedEnvironmentId` parameter and its meaning ("what the host must report");
only the bearer broker's argument changes, from the registry key to the stored
host-declared id. `authorizeBearer` holds no cache keyed by that value (the
token cache belongs to `authorizeDpop`), so nothing else shifts.

### D3. The failure names the entry it collided with

`connectPresentation` discards the `detail` of a `duplicate-storage-identity`
failure and prints one generic sentence, so the dialog could not say that the
collision was with **Local**. Both duplicate branches now carry a detail that
names the entry, and the dialog renders it. `UI.md`: an error a user cannot act
on is not an error message.

## Alternatives considered

- **Give each server a unique `environment_id`** (e.g. its storage instance id).
  Fixes the source, but changes the desktop's own environment id, which
  persisted client caches are keyed by, and does nothing for the servers already
  deployed — every 0.5.4-and-earlier host still reports `"local"`, so the client
  needs D1 regardless. Rejected as the primary fix; still open as a later
  clean-up.
- **Drop the environment-id equality check for bearer targets.** It is vacuous
  today (`"local" === "local"`) and the storage-identity check is the real
  assertion. Rejected: removing a check silently is worse than storing the value
  it needs, and D2 costs one optional field.
- **Exempt platform-managed entries from the duplicate check.** Would let the
  remote register under `"local"` and shadow the desktop's own Local entry in
  the registry map. Rejected — it trades a blocked pairing for silent data
  confusion.

## Scope and known gaps

Scoped to bearer connections: the pairing flow and the manual endpoint+token
flow. SSH and desktop-local (WSL) targets keep taking their ids from the
desktop bridge and leave `serverEnvironmentId` null, so their behaviour is
byte-for-byte unchanged. Those two paths compare a bridge-assigned id
(`ssh:…`, `wsl:…`) against a host that also declares `"local"`; whether that
comparison holds on those platforms is untested here and is **not** addressed by
this change. Recorded so the next person finds it rather than rediscovering it.

## Invariants preserved

- Host identity is still asserted on every connect: the E2EE host key, the
  storage instance id (`verifyPreparedStorageIdentity`), and the host-declared
  environment id (D2).
- Pairing survives restart: the derived id is persisted with the registration,
  so reconnects resolve the same entry.
- Saved entries written before this change keep resolving through the
  `serverEnvironmentId ?? environmentId` fallback.
