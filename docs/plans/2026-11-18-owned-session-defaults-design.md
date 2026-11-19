# Owned provider session defaults in a settings write

## Problem

`server.updateSettings` replaces `providerSessionDefaults` whole. A send that
clears a retired Codex default builds the map from this window's copy of the
settings. When another window saved a Claude default whose config event has not
reached this window yet, the write drops it. The client cannot close that
window; only the server sees both writes in order.

## Decision

The request gains an optional `ownedProviderSessionDefaults`, a list of
provider drivers, beside `patch`. When present, the server reads its committed
map under the settings update lock and, for each owned provider, sets it from
`patch.providerSessionDefaults` or removes it when that map leaves it out.
Every other provider keeps its saved default. When absent, the map replaces the
saved map as before.

The client keeps sending its full map and names the one provider it changes.

## Alternatives

- **A per-key patch field inside `patch`.** The web routes any key that is not a
  `ServerSettings` field to client persistence, and an older server stores an
  unknown top-level patch key in the settings document. Rejected.
- **A boolean "merge" flag with a one-key map.** An older server ignores the flag
  and replaces the whole map with that one key, erasing every other default.
  Rejected.
- **Compare-and-set on a settings revision.** Needs a revision on the wire and a
  retry loop in every writer for a map whose entries never depend on each other.
  Rejected as larger than the problem.

## Trade-offs

- An older server ignores the field and replaces the map, which is today's
  behaviour, so a mixed version loses nothing it did not lose before.
- Removal is expressed by leaving an owned provider out of the map, so no `null`
  is needed in a schema whose values are defaults.
