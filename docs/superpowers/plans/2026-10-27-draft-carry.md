# Draft carry: keep text typed into a new chat during its promotion (#189)

Batch `draft-carry`, branch `claude/b3-draft-carry`.

## Approved corrections (supersede the sections below)

The lead approved the plan with these changes, and the implementation follows
them:

1. **Late restore.** A reply can be lost after the server committed
   `thread.created` and `thread.message-sent`. The canonical route can then
   finalize the draft before the send's `restoreOutgoing` writes to the
   `DraftId` it captured. Finalization now records the draft-to-thread handoff
   in memory. `restoreOutgoing` and the ambiguous-admission `restoredDraft`
   read go through `resolveComposerRestoreTarget`, a narrow `ChatView`
   send-path hunk. The "before its first `await`" claim was wrong:
   attachment-authority checks can await before the clear (~`ChatView.tsx:5755`).
   Finalization still needs a started thread, and the turn is dispatched only
   after the clear, so the no-resurrection argument holds.
2. **Two drafts.** A thread entry can exist before finalization, and the lookup
   prefers it, so the route switch can hide draft text. Rule 4 is replaced:
   both survive. The draft's content goes ahead of the thread's, whose content
   and settings are never overwritten.
3. **Complete caller.** The packaged `composer-native-triggers` spec gains a
   second scenario. It opens a new chat from the command palette and types
   through the real composer right after the first send, across the route
   switch. It then asserts the visible and persisted thread draft after
   finalization. The provider walk-through's primary workspace chat is already
   a server thread with no draft session (checked in the packaged app), so it
   never promoted a draft, and its old wait for the draft route was a no-op.
   Unit coverage stays in the store tests; `ChatView.test.tsx` is not touched.
4. **Docs.** `docs/architecture/connection-runtime.md` describes the promotion
   handoff and late-reply behavior, and the cross-platform runbook describes
   the new packaged assertion. The overview bullet was dropped.

## Acceptance criterion

When a new chat's first send turns its draft into a server thread, composer
content that was never sent survives the whole switch: send, the server thread
arriving, the draft route rendering server-mode `ChatView`, text typed in that
gap, the canonical thread route taking over, and promotion finalization. That
content includes prompt text with its `@` mentions and chips, attachments, and
terminal, element, preview-annotation and review-comment contexts. After
finalization it is the thread's composer draft. Content that was sent never
comes back, and a thread draft that already holds content is never
overwritten.

## Root cause (verified)

- `ChatView.tsx:1576-1577`: once the draft route renders `routeKind="server"`
  (`_chat.draft.$draftId.tsx:56-66`), `composerDraftTarget` becomes the scoped
  thread ref.
- `composerDraftStore.ts:1304-1328` (`resolveComposerDraftKey`): a scoped ref
  that has no entry of its own resolves to the matching draft session's
  `DraftId`. So during the gap the composer keeps reading and writing the
  draft's entry, and text typed there is visible and stored under the `DraftId`.
- The canonical route calls `finalizePromotedDraftThreadByRef` once the server
  thread has started (`_chat.$environmentId.$threadId.tsx:56-61` calling
  `composerDraftStore.ts:3672-3687`). That runs `finalizePromotedDraftThread`
  (`:2570-2581`), and `removeDraftThreadReferences` (`:1463-1488`) deletes
  `draftsByThreadKey[draftId]` and revokes its image preview URLs (`:1105`).
  After that the scoped ref resolves to its own empty key, and the composer
  clears.
- A scratch store test confirmed this order: `clearComposerContent(draftId)`
  (the send), then `markPromotedDraftThreadByRef`, then `setPrompt(threadRef,
  "@README")` writes under the `DraftId`, and `getComposerDraft(threadRef)`
  returns it. `finalizePromotedDraftThreadByRef` then leaves
  `getComposerDraft(threadRef) === null`. The scratch file was deleted.
- This corrects the issue text slightly. The route switch itself does not hide
  the text; finalization deletes it. The switch would hide it only if
  `promotedTo` differed from the session's own ref. No current producer does
  that: `markPromotedDraftThread*` and `finalizePromotedDraftThreadByRef` pass
  the session's own ref. Only a route-test fixture uses a different one. The
  fix covers both cases.
- Sent content cannot come back. The send clears the draft synchronously
  (`ChatView.tsx:6004-6006`) before its first `await`. Finalization needs a
  started server thread, which can only happen after that dispatch. Anything
  left in the draft at finalization was therefore typed after the send, or put
  back by `restoreOutgoing` after a failed turn (`ChatView.tsx:5818-5867`).
  Carrying restored content is correct, because it was not accepted.

## Change (store only; no ChatView edit)

In `composerDraftStore.ts`, `finalizePromotedDraftThread` carries the draft
entry before removing the session. The destination key is
`composerTargetKey(existing.promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId))`.
Rules, applied in one `set` transition:

1. **Draft content is empty.** Content means prompt, attachments,
   persistedAttachments, terminal, element, preview-annotation and
   review-comment contexts. Finalize exactly as today and carry nothing. Model
   and mode fields alone are not carried, so a promoted thread does not gain a
   permanent draft override; it follows the selection the server recorded for
   the first turn.
2. **Draft has content and the thread has no entry.** Move the draft's entry
   object to the thread key unchanged, without revoking its preview URLs. The
   same object identity keeps the ambiguous-admission `restoredDraft ===` check
   working. `persistedAttachments` and `nonPersistedAttachmentIds` move with
   it, and the persist partializer (`:1877-1905`) writes persisted attachments
   per key, so storage follows the key. Model selection, active provider and
   runtime and interaction modes move too, because they are what the composer
   showed in the gap. If `promotedTo.threadId` differs from the draft's thread
   id, terminal contexts are re-stamped with
   `normalizeTerminalContextsForThread`; only then is a new object built.
3. **Draft has content and the thread entry exists with no content.** Copy all
   content fields into the thread entry, all or nothing. Fill
   `modelSelectionByProvider`, `activeProvider`, `runtimeMode` and
   `interactionMode` only where the thread entry's value is empty or null;
   never overwrite. Don't revoke carried preview URLs.
4. **Thread entry already has content.** Leave it untouched and remove the
   draft as today, revoking the draft's preview URLs. The rule is never
   overwrite.
5. Never write an entry that `shouldRemoveDraft` would delete.

Mentions and chips need no rule of their own. They are tokens in `prompt` plus
the context arrays above; the draft state has no separate mention field.
Route files need no code change: the canonical route's finalize call is
already correctly gated.

## Files

- `apps/web/src/composerDraftStore.ts`: the carry in
  `finalizePromotedDraftThread`.
- `apps/web/src/composerDraftStore.test.ts`: tests.
- `apps/web/src/components/ChatView.test.tsx`: **outside my owned files**. One
  added `it` next to "onSend promotes a draft session by bootstrapping thread
  creation" (~line 5806). It only adds a test; `ChatView.tsx` is not touched.
  See the fallback below.
- `docs/architecture/overview.md`: one bullet under "Boundaries and
  invariants".

## Tests

Store tests in `composerDraftStore.test.ts` (failing first):

- Rewrite "finalizes a promoted draft after the canonical thread route is
  active". It currently asserts the bug; it should assert that the prompt lands
  under the thread key and the draft session and its entry are gone.
- The caller-order sequence: send clear, mark promoted, `setPrompt(threadRef)`
  in the gap, finalize. The text should survive under the thread key, and the
  sent text should not.
- A content-empty draft with only model fields: no thread entry is created
  (rule 1).
- A thread entry that already has content keeps it unchanged (rule 4).
- A content-empty thread entry with a model selection receives the draft
  content and keeps its own model selection (rule 3).
- An image attachment is carried, and its preview URL is not revoked (spy on
  `URL.revokeObjectURL`). `persistedAttachments` arrive under the thread key.
- A differing `promotedTo.threadId` re-stamps the carried terminal contexts.

Complete switch in `ChatView.test.tsx`, using the existing real store and
prop-capture harness:

1. Render draft-mode `ChatView`, set `promptRef`, and call `onSend`. Assert
   that the draft prompt is cleared synchronously.
2. Seed the server thread and call `markPromotedDraftThreadByRef`, as the
   draft route does, then render `routeKind="server"`. Assert that the captured
   composer `composerDraftTarget` is the scoped thread ref.
3. Type in the gap with `setPrompt(composerDraftTarget, "@README ")`, which is
   the call `ChatComposer` makes, and assert the composer resolves it.
4. Seed a started thread with the user message and call
   `finalizePromotedDraftThreadByRef(threadRef)`, as the canonical route effect
   does. Re-render and assert that the thread's draft prompt is `"@README "`,
   the draft session is gone, and the sent text is absent.

The route tests already prove that the routes drive these steps under the right
conditions: `_chat.draft.$draftId.test.tsx` covers the server-mode render
before start, and `_chat.$environmentId.$threadId.test.tsx` covers finalize
only after start. They mock the store, so they cannot prove the carry.

If the `ChatView.test.tsx` addition is refused, the fallback is a new sibling
test (`apps/web/src/routes/draftPromotionCarry.test.tsx`). It would mount the
real draft and canonical routes against the real store, with a probe
`ChatView` that applies the same one-line target rule. That is weaker, because
it mirrors the rule instead of exercising it.

Validation: `vp test run --project unit src/composerDraftStore.test.ts
src/components/ChatView.test.tsx src/routes/_chat.draft.\$draftId.test.tsx
src/routes/_chat.\$environmentId.\$threadId.test.tsx` from `apps/web`, then
`vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck` and
`vp test run scripts/bibcode-identity.test.ts`. Optional native proof, left to
the validation agents: run `composer-native-triggers` with its route-switch
wait removed.

## Docs and runbooks

- `overview.md`: add the invariant "a new chat's unsent composer content
  survives draft promotion; a thread draft with content is never overwritten".
  No other living doc describes draft promotion.
- `docs/testing` runbooks: reviewed; none mention this wait or the promotion
  flow, and they remain accurate.
- `apps/desktop/e2e/specs/composer-native-triggers.e2e.ts:688-690`: its
  comment describes the bug as current behavior. The file is outside my scope;
  I suggest the integrator rewords it to "waits so the typed text lands on the
  thread route". The wait itself stays and is harmless.

## Review gates

- vercel-react-best-practices: no React component or hook changes, so nothing
  to review except the test.
- UI.md: user work is preserved, and nothing new appears.
- Profiler coverage: none applies. There are no processes, RPC, worktree
  removal, binaries, shutdown or events.

## Skipped (ponytail)

- Merging draft content into a thread draft that already has content.
- Making `resolveComposerDraftKey` alias through `promotedTo`.
- Removing the E2E wait.
- Any `ChatView.tsx` edit.
- Carrying model-only drafts.
