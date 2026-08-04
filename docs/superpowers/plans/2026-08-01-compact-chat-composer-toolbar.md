# Compact Chat Composer Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat composer footer's text-heavy controls with the approved compact toolbar, add arbitrary file attachments, and expose measured context plus selected-provider MCP status without reintroducing provider or agent selection.

**Architecture:** Keep `ChatComposer` as the footer coordinator and reuse the existing active-instance model picker, provider-option persistence, interaction/runtime callbacks, context meter, thread activities, and attachment root. Generalize the existing image attachment union instead of adding a parallel upload system. Normalize Codex MCP lifecycle data at its runtime adapter, project snapshots through existing thread activities with provider-instance attribution, and derive the active snapshot in the web client without a new global store.

**Tech Stack:** React 19, TypeScript, Effect Schema, Vite+, Vitest, Lucide React, Rust, Axum/Tokio, Codex app-server JSON-RPC.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-31-chat-composer-toolbar-design.md`.
- Keep the existing provider icon and display the selected model's `shortName` when available.
- The composer model popup may select models only for the active provider instance. It must never expose provider or agent selection.
- Use Lucide's folded `MapIcon` for Plan. Active means `plan`; inactive means backend `default`. Never render a Build icon or label.
- Fast is a dedicated lightning toggle. Effort is an increasing-bars icon. Runtime/edit mode shows only its selected icon.
- Keep the existing eight-attachment and 10 MiB-per-attachment limits and validate them in both TypeScript and Rust.
- Preserve image thumbnails and zoom behavior; render non-image files as removable filename/size chips.
- Materialize and sanitize uploads before orchestration dispatch. Never persist attachment `dataUrl` payloads in history; persist only safe attachment metadata and the materialized file.
- Use native provider file parts only where the provider protocol supports them; otherwise pass an explicit safe materialized path in the prompt. Never silently drop a file.
- MCP data is scoped to the selected provider instance. Clear connected presentation when the runtime is not live, and hide the control for providers without structured MCP status support.
- Context usage remains measured-only through `ContextWindowMeter`; do not invent category breakdowns.
- Keep the left toolbar horizontally scrollable and the paperclip, context, MCP, and primary action group fixed on narrow widths.
- Reuse the current UI primitives and Lucide package. Add no production dependency or state library.
- Preserve approval, pending-question, plan-follow-up, send/stop, keyboard, focus, reconnect, and draft-recovery behavior.
- Do not edit vendored repositories under `.repos/`.
- Use tests first for every behavior change.
- Run `vp check` and `vp run typecheck` before completion.

---

## Task 1: Make the footer a compact active-provider-only toolbar

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx:212-402,2538-2639`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx:910-1146,2319-2475`
- Modify: `apps/web/src/components/chat/ProviderModelPicker.tsx:20-205`
- Modify: `apps/web/src/components/chat/ProviderModelPicker.test.tsx:211-335`
- Modify: `apps/web/src/components/chat/ModelPickerContent.test.tsx:481-745`
- Delete: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`
- Delete: `apps/web/src/components/chat/CompactComposerControlsMenu.test.tsx`

**Interfaces:**

- Preserves: `ProviderModelPicker.lockToActiveInstance`, `toggleInteractionMode`, `handleRuntimeModeChange`, and `togglePlanSidebar`.
- Changes presentation only: `ComposerFooterModeControls` becomes icon-only and is rendered at every footer width.
- Removes: the compact overflow menu that can expose text-heavy Mode/Access sections.

- [ ] **Step 1: Write failing toolbar and picker tests**

Update `ChatComposer.test.tsx` to assert the approved semantics:

```tsx
it("renders the folded-map Plan toggle without Build UI", async () => {
  const { rerender } = renderComposer({ interactionMode: "default" });

  expect(screen.getByRole("button", { name: "Enable plan mode" })).toBeVisible();
  expect(screen.queryByText("Build")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Enable plan mode" }));
  expect(defaultProps.toggleInteractionMode).toHaveBeenCalledOnce();

  rerender(<ChatComposer {...defaultProps} interactionMode="plan" />);
  expect(screen.getByRole("button", { name: "Disable plan mode" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByText("Plan")).not.toBeInTheDocument();
});

it("keeps runtime controls icon-only at compact and regular widths", () => {
  renderComposer({ runtimeMode: "auto-accept-edits" });
  expect(screen.getByRole("button", { name: "Auto-accept edits" })).toBeVisible();
  expect(screen.queryByText("Auto-accept edits")).not.toBeInTheDocument();
});
```

Add a model-picker case using two instances with the same driver and distinct models. Open the composer picker and assert the second instance label, model, and any agent rail are absent while the active instance model remains selectable.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ProviderModelPicker.test.tsx apps/web/src/components/chat/ModelPickerContent.test.tsx
```

Expected: failure because Plan still renders `BotIcon`/`PencilRulerIcon` and text, runtime still renders its label, and compact mode still uses the overflow menu.

- [ ] **Step 3: Replace the mode controls with icon-only buttons**

In `ComposerFooterModeControls`:

- Import and render `MapIcon` for both Plan states.
- Set `aria-pressed={interactionMode === "plan"}`.
- Use exactly `Enable plan mode` and `Disable plan mode` for accessible names and tooltips.
- Remove `BotIcon`, `PencilRulerIcon`, the visible Plan/Build span, and the interaction separator that exists only to group text controls.
- Keep the runtime `Select`, but render only `RuntimeModeIcon` inside `SelectTrigger`; use the selected option label for `aria-label` and the description for the tooltip.
- Keep the full runtime labels and descriptions inside `SelectPopup`.
- Keep the plan-sidebar control separate; it is not the Plan mode toggle.

Render these controls for compact and regular footers. Remove `CompactComposerControlsMenu` and its test because horizontal scrolling already protects the left group at narrow widths.

- [ ] **Step 4: Harden active-instance-only model selection**

Keep `lockToActiveInstance` required at the composer call site. In `ProviderModelPicker`, make the trigger tooltip include the full active provider display name plus full model name, while the visible label continues to use `getTriggerDisplayModelName()`.

Add/retain `ModelPickerContent` assertions that when `lockToActiveInstance` is true:

- the provider sidebar never renders;
- search filters only the active instance's models;
- `onInstanceModelChange` can only receive the active instance id;
- switching `activeInstanceId` while mounted replaces the model list rather than preserving a prior provider rail selection.

- [ ] **Step 5: Preserve the responsive split**

Keep the existing left wrapper as `min-w-0 flex-1 overflow-x-auto` and the right action wrapper as `shrink-0`. Add assertions against `data-chat-composer-actions="right"` so compact mode never moves send/stop into the scrolling group.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ProviderModelPicker.test.tsx apps/web/src/components/chat/ModelPickerContent.test.tsx
```

Expected: all pass.

```bash
git add apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ProviderModelPicker.tsx apps/web/src/components/chat/ProviderModelPicker.test.tsx apps/web/src/components/chat/ModelPickerContent.test.tsx apps/web/src/components/chat/CompactComposerControlsMenu.tsx apps/web/src/components/chat/CompactComposerControlsMenu.test.tsx
git commit -m "feat: compact the chat composer mode controls"
```

---

## Task 2: Split Fast and effort while removing composer agent selection

**Files:**

- Modify: `apps/web/src/components/chat/TraitsPicker.tsx:1-460`
- Modify: `apps/web/src/components/chat/TraitsPicker.test.tsx:175-455`
- Modify: `apps/web/src/components/chat/composerProviderState.tsx:34-160`
- Modify: `apps/web/src/components/chat/composerProviderState.test.tsx:240-370`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:1080-1115,2570-2610`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx:910-1146`

**Interfaces:**

- Adds: `ComposerTraitControls`, local `EffortLevelIcon`, and one shared provider-option updater inside `TraitsPicker.tsx`.
- Preserves: `TraitsPicker` for settings and `TraitsMenuContent` for non-composer consumers.
- Replaces: `renderProviderTraitsPicker`/`renderProviderTraitsMenuContent` in the composer with `renderComposerTraitControls`.

- [ ] **Step 1: Write failing dedicated-control tests**

Add `TraitsPicker.test.tsx` cases that mount `ComposerTraitControls` with `fastMode`, effort, and agent descriptors together:

```tsx
expect(screen.getByRole("button", { name: "Disable fast mode" })).toHaveAttribute(
  "aria-pressed",
  "true",
);
expect(screen.getByRole("button", { name: "Reasoning effort: High" })).toBeVisible();
expect(screen.queryByText("High")).not.toBeInTheDocument();
expect(screen.queryByText("Agent")).not.toBeInTheDocument();
expect(screen.queryByText("reviewer")).not.toBeInTheDocument();
```

Open the effort menu and assert every effort option remains labeled, including a prompt-injected `Ultrathink` option. Click Fast and an effort option and assert the existing draft/options persistence payloads.

- [ ] **Step 2: Run the trait tests and confirm they fail**

Run:

```bash
vp test run apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/composerProviderState.test.tsx
```

Expected: failure because the composer still receives one combined text trigger and agent descriptors remain in its menu content.

- [ ] **Step 3: Share the existing update path**

Extract only the duplicated persistence closure and descriptor replacement into a local hook/helper in `TraitsPicker.tsx`. Both the existing settings picker and `ComposerTraitControls` must continue to call:

```ts
buildProviderOptionSelectionsFromDescriptors(
  replaceDescriptorCurrentValue(descriptors, descriptor.id, nextValue),
)
```

Keep prompt-injected effort handling (`Ultrathink:` prefix, body-text lock, and prefix removal) in the same canonical handler; do not create a second effort implementation.

- [ ] **Step 4: Render the dedicated controls**

Implement `ComposerTraitControls` so:

- `fastMode` renders a `ZapIcon` button, `aria-pressed`, and `Enable/Disable fast mode`; the short `Fast` text may appear only at desktop width.
- the primary effort descriptor renders a four-bar `EffortLevelIcon`; fill `optionIndex + 1` bars and clamp to one through four so unknown descriptor sizes remain legible;
- the effort trigger has no visible effort label, but its accessible name is `Reasoning effort: <label>`;
- the effort popup reuses the existing labeled radio choices and prompt-injected behavior;
- the `agent` descriptor is never rendered or placed in an overflow menu in the composer;
- descriptors unrelated to Fast/effort remain available in the existing settings `TraitsPicker`, not the composer toolbar.

Change `composerProviderState.tsx` to expose `renderComposerTraitControls` and stop creating composer `TraitsMenuContent`.

- [ ] **Step 5: Verify provider switches do not leak trait state**

Add a rerender test with a different `instanceId`, model, and descriptor snapshot. Assert Fast/effort immediately reflect the new instance and no prior agent or option label remains.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
vp test run apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: all pass.

```bash
git add apps/web/src/components/chat/TraitsPicker.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/composerProviderState.tsx apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx
git commit -m "feat: split composer fast and effort controls"
```

---

## Task 3: Generalize attachment contracts and draft state

**Files:**

- Modify: `packages/contracts/src/orchestration.ts:152-190,615-628`
- Modify: `packages/contracts/src/orchestration.test.ts`
- Modify: `apps/web/src/composerDraftStore.ts:81-100,240-265,425-493,1075-1120,2040-2160,2900-2990`
- Modify: `apps/web/src/composerDraftStore.test.ts`
- Modify: `apps/web/src/components/ChatView.logic.ts:291-325`
- Modify: `apps/web/src/components/ChatView.logic.test.ts:352-425`

**Interfaces:**

- Adds: `ChatFileAttachment`, `UploadChatFileAttachment`, `ComposerFileAttachment`, `ComposerAttachment`, and `PersistedComposerAttachment`.
- Changes: `ChatAttachment` and `UploadChatAttachment` become image/file unions.
- Renames the shared size constant to `PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES`; retain `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` as a deprecated alias for one release to avoid breaking unrelated imports.
- Migrates draft state from image-only collections/methods to attachment collections/methods.

- [ ] **Step 1: Write failing contract tests**

Add decoding tests for one image and one text file, plus rejection cases for an image MIME on a file, non-image MIME on an image, more than eight attachments, and a file above 10 MiB:

```ts
const file = {
  type: "file",
  id: "notes-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
};
expect(decodeChatAttachment(file)).toEqual(file);
```

Add upload-union coverage with `data:text/plain;base64,aGVsbG8=`.

- [ ] **Step 2: Run contract tests and confirm they fail**

Run:

```bash
vp test run packages/contracts/src/orchestration.test.ts
```

Expected: failure because only image attachments decode.

- [ ] **Step 3: Extend the attachment schemas**

Define `ChatFileAttachment` with `type: "file"`, the existing safe id/name rules, non-empty MIME up to 100 characters, and the shared 10 MiB limit. Define the upload variant with the same fields plus bounded `dataUrl`. Keep image MIME validation on `ChatImageAttachment`; prevent file records from using an `image/*` MIME so image preview semantics remain unambiguous.

Use the existing eight-item array limit in `ProviderSendTurnInput` and `ClientThreadTurnStartCommand`.

- [ ] **Step 4: Write failing draft migration tests**

Cover:

- a new persisted file round-trip;
- hydration of a legacy persisted image with no `type` field as `type: "image"`;
- image preview URL restoration;
- file restoration without `URL.createObjectURL`;
- dedupe and removal across mixed attachment types;
- preserving mixed attachments on send-failure restoration.

- [ ] **Step 5: Generalize the draft model**

Use these canonical web types:

```ts
export interface ComposerImageAttachment extends ChatImageAttachment {
  readonly previewUrl: string;
  readonly file: File;
}

export interface ComposerFileAttachment extends ChatFileAttachment {
  readonly file: File;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerFileAttachment;
```

Replace `images`, `addImage(s)`, `removeImage`, and image-only persisted helpers with `attachments`, `addAttachment(s)`, and `removeAttachment`. Decode the old persisted image shape as an image during hydration. Revoke object URLs only for image attachments.

Rename `readFileAsDataUrl` error messages from image-specific wording to attachment/file wording while preserving its behavior.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
vp test run packages/contracts/src/orchestration.test.ts apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.logic.test.ts
```

Expected: all pass.

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts
git commit -m "feat: generalize composer attachment state"
```

---

## Task 4: Add the paperclip picker and mixed attachment presentation

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx:404-610,1140-1170,1390-1430,1830-1930,2310-2450,2538-2639`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx:1147-1282,1885-2032,2112-2268`
- Modify: `apps/web/src/components/ChatView.tsx:188-190,1500-1510,2465-2500,4730-4778,4840-4915`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx:1515-1586,3550-3590`
- Modify: `apps/web/src/historyBootstrap.ts:1-40`
- Modify: `apps/web/src/historyBootstrap.test.ts`

**Interfaces:**

- Changes `ChatComposerHandle.getSendContext().images` to `.attachments`.
- Changes the parent ref from `composerImagesRef` to `composerAttachmentsRef`.
- Adds one hidden native `<input type="file" multiple>` and an `Attach files` paperclip button.
- Uses one `addComposerAttachments(files)` path for picker, paste, and drop.

- [ ] **Step 1: Write failing picker, validation, and chip tests**

Add tests that:

- click `Attach files`, deliver an image and `notes.txt` through the hidden input, and render both;
- render the image thumbnail/preview behavior unchanged;
- render `notes.txt`, its formatted size, and a remove button without an image element;
- reject a zero-byte file, a file above 10 MiB, and the ninth mixed attachment with the rejected filename in the message;
- paste and drop non-image files through the same path;
- keep the draft intact when selection or data reading fails;
- disable attachment selection during approval/pending-question states.

- [ ] **Step 2: Run ChatComposer tests and confirm they fail**

Run:

```bash
vp test run apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: failure because the paperclip/input do not exist and paste/drop filter to images.

- [ ] **Step 3: Implement the shared validation path**

Replace `addComposerImages` with `addComposerAttachments`:

- validate active thread/state once;
- reject empty files;
- enforce 10 MiB and the combined eight-item cap;
- normalize an empty browser MIME to `application/octet-stream`;
- classify `image/*` as `type: "image"` and create/revoke object URLs only for images;
- classify every other MIME as `type: "file"`;
- report the first rejected filename and reason through `setThreadError`;
- add all accepted files in one store update.

Route file input, paste, and drop to this function. Clear the input's value after each `change` so choosing the same file again works after removal.

- [ ] **Step 4: Render the paperclip and file chips**

Place the paperclip at the start of `ComposerFooterPrimaryActions`, before context/MCP/send. It must remain in the fixed right group at compact widths.

Keep the existing image grid. Add non-image chips with filename, `formatBytes(sizeBytes)`, file icon, non-persisted warning, and remove action. Use the same attachment id for preview, optimistic message, persisted message, and removal.

- [ ] **Step 5: Generalize send and reconnect behavior**

In `ChatView.tsx`, serialize every `ComposerAttachment` to its matching upload union member with `dataUrl`. Build optimistic attachments without `dataUrl`; include `previewUrl` only for images. Restore all mixed attachments after a failed turn start.

Update `historyBootstrap.ts` so attachment summaries count both types and use `Image: <name>` only when the first attachment is an image; otherwise use `File: <name>`.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
vp test run apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/historyBootstrap.test.ts
```

Expected: all pass.

```bash
git add apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/historyBootstrap.ts apps/web/src/historyBootstrap.test.ts
git commit -m "feat: add mixed file attachments to the composer"
```

---

## Task 5: Materialize uploads safely and adapt them per provider

**Files:**

- Modify: `apps/server/src/provider/attachments.rs:9-137`
- Modify: `apps/server/src/provider/attachments.rs:139-290` (tests)
- Modify: `apps/server/src/production/orchestration_rpc.rs:20-75`
- Modify: `apps/server/src/production/orchestration_rpc.rs` test module
- Modify: `apps/server/src/production/provider_runtime.rs:2353-2383,2550-2565,2740-2755,2951-2976,3696-3721,4482-4578`

**Interfaces:**

- Renames `MaterializedImage` to `MaterializedAttachment` and adds `attachment_type` plus canonical `path`.
- Adds `AttachmentMaterializer.prepare()` to validate/write upload bodies and return safe metadata before orchestration dispatch.
- Extends `AttachmentMaterializer.materialize()` to read prepared image/file metadata for provider delivery.
- Adds shared `split_native_images_and_file_references()` and `append_file_references()` helpers for provider adapters.

- [ ] **Step 1: Write failing server boundary tests**

Extend `attachments.rs` tests to cover:

- materializing `data:text/plain;base64,bm90ZXM=` as a file;
- accepting a pre-materialized reconnect attachment with no `dataUrl`;
- rejecting decoded bytes above 10 MiB even when claimed `sizeBytes` is smaller;
- rejecting mismatched claimed/decoded size, malformed data URLs, image/file MIME mismatch, invalid ids, and traversal/symlink escapes;
- never overwriting an existing attachment id with different bytes.

Add an orchestration RPC test that dispatches a turn with `dataUrl`, then asserts the projected `thread.message-sent` attachment contains `type`, `id`, `name`, `mimeType`, and `sizeBytes`, but no `dataUrl`. Also assert a materialization failure returns the declared RPC error before any message/turn event is persisted.

- [ ] **Step 2: Run server tests and confirm they fail**

Run:

```bash
cargo test -p bibcode-server provider::attachments -- --nocapture
cargo test -p bibcode-server production::orchestration_rpc -- --nocapture
```

Expected: failure because non-image metadata is rejected, upload bytes are not prepared, and the RPC dispatch path does not sanitize uploads.

- [ ] **Step 3: Generalize materialization without weakening path safety**

Parse this internal shape in `prepare()`:

```rust
struct AttachmentInput {
    attachment_type: String,
    id: String,
    name: String,
    mime_type: String,
    size_bytes: u64,
    data_url: Option<String>,
}
```

Validate type/MIME, id, filename length, claimed size, decoded size, and exact size equality. Decode only base64 data URLs. Create the attachment root if needed, write a new upload using `create_new`, canonicalize it, and retain the current root-prefix protection. If the id already exists, accept only byte-for-byte identical content so a retry is idempotent; never overwrite different bytes. If no `dataUrl` is present, require an existing canonical file for reconnect/history delivery.

Return safe metadata from `prepare()`. Keep `materialize()` responsible for reading that prepared metadata into `MaterializedAttachment { attachment_type, name, mime_type, base64_data, file_url, path }` at the provider boundary.

- [ ] **Step 4: Prepare and sanitize before orchestration dispatch**

In `register_orchestration_rpc_with_provider`, construct an `AttachmentMaterializer` from the existing state root. For `ThreadTurnStart`, call `prepare()` before `engine.dispatch`, replace `message.attachments` with its safe metadata result, and use that same sanitized command for both orchestration and provider routing. A preparation error must return before `engine.dispatch`, leaving the draft recoverable and history unchanged.

- [ ] **Step 5: Write failing provider-adapter tests**

Replace the current image-only adapter fixture with one image and one text file. Assert:

- Codex/Claude/ACP keep image-native payloads and add one explicit local path reference for the text file;
- OpenCode receives both image and file as native `type: "file"` URL parts;
- filenames and paths are quoted/escaped safely;
- no adapter silently drops the file.

- [ ] **Step 6: Adapt provider sends through two shared helpers**

For Codex, Claude, Cursor, and Grok, split materialized attachments into native images and non-image path references. Append a bounded section to the user's text:

```text
<attached_files>
- notes.txt: C:\BiBCodeState\attachments\notes-1
</attached_files>
```

Escape XML-sensitive filename/path characters. Keep OpenCode's existing native file URL block for both images and files. If an adapter cannot produce either a native part or a readable path, return `ProviderRuntimeError` before `send_turn`.

- [ ] **Step 7: Run server tests and commit**

Run:

```bash
cargo test -p bibcode-server provider::attachments -- --nocapture
cargo test -p bibcode-server production::provider_runtime::attachment_adapter_tests -- --nocapture
cargo test -p bibcode-server production::orchestration_rpc -- --nocapture
```

Expected: all pass.

```bash
git add apps/server/src/provider/attachments.rs apps/server/src/production/orchestration_rpc.rs apps/server/src/production/provider_runtime.rs
git commit -m "feat: materialize and route arbitrary attachments"
```

---

## Task 6: Normalize Codex MCP status into provider-scoped thread activities

**Files:**

- Modify: `packages/contracts/src/providerRuntime.ts:148-197,238-245,542-545,902-907`
- Modify: `packages/contracts/src/providerRuntime.test.ts`
- Modify: `packages/contracts/src/server.ts:170-190`
- Modify: `packages/contracts/src/server.test.ts`
- Modify: `apps/server/src/provider/codex/runtime.rs:143-210,367-535,1200-1410`
- Modify: `apps/server/src/provider/codex/runtime.rs` test module
- Modify: `apps/server/src/production/provider_runtime.rs:1589-1732`
- Modify: `apps/server/src/production/provider_runtime.rs:5790-5880` (tests)
- Modify: `apps/server/src/production/provider_inventory.rs:414-435,492-665,1419-1470`
- Modify: `apps/server/src/production/provider_inventory.rs` test module

**Interfaces:**

- Adds: `McpServerConnectionState`, `McpServerStatus`, and a typed `McpStatusUpdatedPayload.servers` snapshot.
- Adds: optional `ServerProvider.supportsMcpStatus` capability, true for Codex and absent/false elsewhere.
- Adds: `CodexSessionRuntime.refresh_mcp_status()` using `mcpServerStatus/list` and handling `mcpServer/startupStatus/updated` notifications.
- Adds provider instance attribution to projected `mcp.status.updated` activity payloads.

**Protocol reference:** Codex app-server documents `mcpServerStatus/list` and `mcpServer/startupStatus/updated` in its official README: `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`.

- [ ] **Step 1: Write failing contract tests**

Decode a normalized event such as:

```ts
{
  type: "mcp.status.updated",
  payload: {
    servers: [
      { name: "context7", state: "connected" },
      { name: "atlassian", state: "needs-auth", detail: "OAuth required" },
    ],
  },
}
```

Reject unknown states and blank server names. Add `ServerProvider` compatibility coverage proving old snapshots decode without `supportsMcpStatus` and Codex snapshots decode with it.

- [ ] **Step 2: Run contract tests and confirm they fail**

Run:

```bash
vp test run packages/contracts/src/providerRuntime.test.ts packages/contracts/src/server.test.ts
```

Expected: failure because MCP status is still `Schema.Unknown` and the provider capability is absent.

- [ ] **Step 3: Define the normalized status contract**

Use these UI-facing states:

```ts
export const McpServerConnectionState = Schema.Literals([
  "connected",
  "starting",
  "needs-auth",
  "disconnected",
  "error",
]);
```

`McpServerStatus` contains `name`, `state`, and optional `detail`. `McpStatusUpdatedPayload` contains the complete `servers` snapshot, not a partial update, so reconnect and replacement semantics remain deterministic.

- [ ] **Step 4: Write failing Codex runtime tests**

Use the existing fake JSON-RPC connection to assert:

- after thread start, `mcpServerStatus/list` is called with the provider thread id;
- paginated `data` results normalize into one full snapshot;
- `mcpServer/startupStatus/updated` maps `starting`, `ready`, `failed`, and `cancelled` to the normalized states;
- `failureReason: "reauthenticationRequired"` maps to `needs-auth`;
- a later snapshot replaces missing servers rather than merging stale connected entries forever.

- [ ] **Step 5: Implement Codex status normalization**

Maintain one small `BTreeMap<String, McpServerStatus>` inside `CodexSessionRuntime`. Seed/replace it from `mcpServerStatus/list` after `thread/start`/`thread/resume`. Update it from startup notifications and emit `RuntimeEvent { type: "mcp.status.updated", payload: { servers } }` after each change.

Do not infer connected state from configured tools alone: map startup `ready` to connected, reauthentication failures to needs-auth, other failures to error, starting to starting, and cancelled to disconnected.

- [ ] **Step 6: Attribute projected status to the active provider instance**

In `project_provider_event`, special-case only `mcp.status.updated`: add `providerInstanceId` from `ProviderLaunchRequest` to the activity payload before dispatch. Keep all other provider event projection unchanged.

Set `supportsMcpStatus: true` only for Codex inventory snapshots. This prevents an empty button for adapters that do not expose structured lifecycle data.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
vp test run packages/contracts/src/providerRuntime.test.ts packages/contracts/src/server.test.ts
cargo test -p bibcode-server provider::codex::runtime -- --nocapture
cargo test -p bibcode-server production::provider_runtime -- --nocapture
cargo test -p bibcode-server production::provider_inventory -- --nocapture
```

Expected: all pass.

```bash
git add packages/contracts/src/providerRuntime.ts packages/contracts/src/providerRuntime.test.ts packages/contracts/src/server.ts packages/contracts/src/server.test.ts apps/server/src/provider/codex/runtime.rs apps/server/src/production/provider_runtime.rs apps/server/src/production/provider_inventory.rs
git commit -m "feat: project provider-scoped MCP status"
```

---

## Task 7: Add the MCP popover and finish toolbar integration

**Files:**

- Create: `apps/web/src/components/chat/McpStatusPopover.tsx`
- Create: `apps/web/src/components/chat/McpStatusPopover.test.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:349-402,480-610,2538-2639`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx:910-1146,2319-2475`
- Modify: `apps/web/src/components/chat/ContextWindowMeter.test.tsx:43-100`
- Verify: `apps/web/src/components/chat/ContextWindowMeter.tsx:1-150`

**Interfaces:**

- Adds: pure `deriveMcpStatusSnapshot(activities, activeInstanceId, runtimeLive)` and presentational `McpStatusPopover`.
- Consumes: existing `activeThreadActivities`, selected provider instance id, session phase, and `ServerProvider.supportsMcpStatus`.
- Preserves: `ContextWindowMeter` as the only context usage implementation.

- [ ] **Step 1: Write failing derivation and popover tests**

Cover:

- choosing the newest `mcp.status.updated` activity for the active instance;
- ignoring a newer event from another provider instance;
- returning an awaiting snapshot when no matching activity exists;
- clearing connected state when `runtimeLive` is false;
- rendering connected, starting, needs-auth, disconnected, and error rows with accessible status text;
- hiding the button when the active provider lacks `supportsMcpStatus`.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
vp test run apps/web/src/components/chat/McpStatusPopover.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: failure because the derivation helper and plug control do not exist.

- [ ] **Step 3: Implement the pure snapshot derivation**

Scan activities from newest to oldest, accept only `summary === "mcp.status.updated"`, validate the payload defensively, and require exact `providerInstanceId` equality. If the runtime is not live, map prior connected/starting rows to disconnected or return the neutral awaiting state; never display stale connected rows.

Keep this as a pure function in `McpStatusPopover.tsx`; the thread activity reducer already owns reconnect/event replacement, so no new Zustand store is needed.

- [ ] **Step 4: Implement the plug popover**

Render an icon-only `PlugIcon` trigger with `aria-label="MCP servers"`. The popup title is `MCPs`; each row has a state icon, server name, and concise status. Use `Awaiting MCP status` when supported but no snapshot has arrived. Keep errors/details text-wrapped and server names truncated with their full value in `title`.

- [ ] **Step 5: Integrate the right action group**

Order the fixed right controls as:

```text
[paperclip] [context ring when measured] [MCP plug when supported] [primary send/stop]
```

Pass the selected instance and selected `ServerProvider` into `ComposerFooterPrimaryActions`. Do not combine events across provider statuses. Add a rerender test that switches instances and immediately replaces or hides the MCP popup.

- [ ] **Step 6: Reconfirm measured-only context behavior**

Keep `ContextWindowMeter` unchanged unless integration reveals a spacing/accessibility issue. Its tests must continue proving used/max/percentage/total-processed values render only when present and no reference-image category labels (`Free space`, `MCP tools`, `Memory files`) appear.

- [ ] **Step 7: Run the complete focused web suite**

Run:

```bash
vp test run apps/web/src/components/chat/McpStatusPopover.test.tsx apps/web/src/components/chat/ContextWindowMeter.test.tsx apps/web/src/components/chat/TraitsPicker.test.tsx apps/web/src/components/chat/ProviderModelPicker.test.tsx apps/web/src/components/chat/ModelPickerContent.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/composerDraftStore.test.ts
```

Expected: all pass.

- [ ] **Step 8: Run repository-required verification**

Run:

```bash
vp test
vp check
vp run typecheck
```

Expected: all pass with no warnings introduced by this change.

- [ ] **Step 9: Perform a manual responsive smoke test**

At desktop and narrow widths verify:

- short model label and current provider icon remain visible;
- the model popup contains no provider/agent rail;
- folded-map Plan toggles plan/default and never renders Build UI;
- Fast, effort bars, and runtime icon update immediately;
- paperclip attaches one image and one non-image file;
- the left controls scroll while the right controls/send remain reachable;
- context and MCP popovers show only current measured/selected-provider data;
- switching provider instances cannot retain the previous MCP, Fast, effort, or model state.

- [ ] **Step 10: Commit the completed toolbar**

```bash
git add apps/web/src/components/chat/McpStatusPopover.tsx apps/web/src/components/chat/McpStatusPopover.test.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/chat/ContextWindowMeter.test.tsx
git commit -m "feat: finish compact composer status controls"
```

---

## Final Acceptance Checklist

- [ ] The provider icon is unchanged and the model trigger prefers `shortName`.
- [ ] No composer toolbar control or popup can select an agent/provider.
- [ ] Folded-map Plan is icon-only; inactive dispatches `default`; no Build UI exists.
- [ ] Fast is dedicated, effort is increasing bars, and runtime is selected-icon-only.
- [ ] Paperclip, paste, and drop accept mixed files through one validation path.
- [ ] Images keep previews; non-images keep chips across send/reconnect.
- [ ] Upload bodies are not persisted, traversal is rejected, and per-file limits are enforced twice.
- [ ] Every provider receives a native attachment or explicit readable path; none silently drops files.
- [ ] Context shows measured values only.
- [ ] MCP shows only the active provider instance and cannot retain stale connected state.
- [ ] `vp test`, `vp check`, and `vp run typecheck` pass.
