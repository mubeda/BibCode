# Provider Capability Toolbar Design

Date: 2026-08-03
Status: Approved

## Summary

Make provider-dependent composer controls truthful and visually legible. Fast mode must reach the selected Codex, Claude, Cursor, or OpenCode backend instead of changing only local UI state. Enabled toggles use BiBCode's existing solid primary-button treatment. Unsupported controls remain visible, cannot be activated, and explain the selected provider/model limitation on hover and keyboard focus.

This design reuses the existing `ModelSelection.options` and `ProviderOptionDescriptor` contracts. It adds one shared option-reconciliation path at the provider runtime boundary and keeps provider-specific translations inside the existing adapters.

## Current Failure

The desktop baseline visually shows Fast as low-contrast text even when its accessible label is `Disable fast mode`, so enabled and disabled states are difficult to distinguish.

The behavior failure is deeper than styling:

- Composer drafts preserve canonical provider options, including Fast.
- Active provider sessions reconcile only model changes before delivery; option changes are ignored.
- Launch construction extracts a few string fields and drops boolean `fastMode` for providers that require it.
- Provider support is unevenly translated: Codex receives a service tier only during launch, Cursor has an unused ACP option resolver, Claude does not receive its per-session Fast setting, and OpenCode has no trustworthy Fast mapping unless a variant is advertised.
- The UI reflects the requested value optimistically rather than an accepted backend configuration.
- Some model normalization paths fabricate a Fast choice instead of treating real provider/model capability metadata as the source of truth.

## Goals

1. Apply Fast correctly for every supported provider/model, including an already-running session.
2. Never send an unsupported provider option.
3. Keep unsupported provider-dependent controls visible and disabled with an exact reason.
4. Give enabled Fast, Plan, effort, and edit-mode controls a clear theme-native solid state.
5. Expose a distinct applying/uncertain state until the backend accepts a change.
6. Preserve conversations when a provider requires restart/resume to apply an option.
7. Keep the compact toolbar free of agent selection.

## Non-goals

- Do not invent a Fast mode for a provider/model that does not advertise or implement one.
- Do not add a new feature color or hard-code violet styling.
- Do not show a Build icon. Plan enabled means plan mode; Plan disabled maps to build mode in the backend.
- Do not make attachment, context-usage, or MCP-status controls depend on provider reasoning capabilities.
- Do not redesign the existing model, permission, attachment, context, or MCP popovers.

## Architecture

### Capability discovery

The selected provider instance and model expose their existing option descriptors. A toolbar control is supported only when both conditions hold:

1. The selected model advertises the canonical option or variant.
2. The provider adapter implements a translation for that option.

UI-only normalization is not proof of support. In particular, a synthesized Codex service tier must not make Fast appear available unless the runtime can apply it for the selected model/account.

Capability status has three values:

- `known-supported`: the control can be used.
- `known-unsupported`: the control is visible but disabled with a reason naming the provider/model.
- `unknown`: metadata is still loading or incomplete; the control is disabled and says support is being checked.

Use the existing descriptor and model metadata types. Add only the minimum reason/status data needed by the toolbar; do not introduce a parallel capability registry.

### Shared option reconciliation

All model-selection update paths and turn starts route through one reconciliation function:

1. Preserve the complete canonical `ModelSelection.options` in the provider launch/session request.
2. Normalize requested options against the selected model's descriptors.
3. Reject or omit unsupported values before invoking a provider.
4. Diff requested values against the session's last applied values.
5. Ask the provider adapter to apply only the changed values.
6. If live update is unavailable but resume is safe, restart/resume the provider session with the new launch options.
7. Update the session's applied launch state only after success.
8. Deliver the turn only after reconciliation succeeds.

The existing model-selection update path should perform reconciliation when a user changes a control. Turn start calls the same function again as a safety boundary so reconnects, restored drafts, and older clients cannot bypass it.

For an idle thread without a provider process, the backend validates and stores the selection for the next launch. That acknowledgement is sufficient to show the configured control as enabled. For a live process, the UI remains applying until live update or restart/resume succeeds.

### Provider translations

| Provider | Fast translation | Existing session behavior | Unsupported behavior |
| --- | --- | --- | --- |
| Codex | Canonical Fast maps to `serviceTier: "fast"`; Off maps to the provider default tier. | Use the supported thread settings/turn update path; fall back to safe resume only if required by the installed protocol. | Disable when the selected model/account does not advertise an applicable Fast tier. |
| Claude | Canonical Fast maps to `fastMode` in generated per-session settings. Never mutate global user settings. | Restart/resume the Claude subprocess when its settings cannot be changed live. | Disable when Claude/model metadata or the installed CLI cannot accept Fast. |
| Cursor | Canonical Fast maps through the existing ACP configuration resolver to `session/set_config_option` for `fast`. | Apply live and wait for the ACP response. | Disable when the session's advertised config options omit `fast`. |
| OpenCode | Canonical Fast maps only to a provider/model variant that OpenCode advertises as a speed mode. | Apply using the advertised variant mechanism; otherwise use safe resume if required. | Keep Fast visible and disabled when no real speed variant is advertised. |

Plan/build, effort, and edit mode follow the same capability and reconciliation rules. Each provider adapter translates the canonical value it actually supports. Plan remains a folded-map icon; disabling it selects build mode without displaying a Build icon.

## Toolbar State Contract

| State | Interaction | Visual treatment | Hint |
| --- | --- | --- | --- |
| Off | Enabled | Existing ghost treatment | Describes what activation does. |
| Applying / uncertain | Not operable | Theme-neutral progress treatment with a small spinner | `Applying Fast mode…` or `Checking feature support…` |
| Confirmed on | Enabled | Existing `border-primary bg-primary text-primary-foreground` solid treatment | Identifies the enabled mode and how to disable it. |
| Unsupported | Not operable | Reduced emphasis with the existing input/border surface | Exact reason, such as `Fast mode is not supported by Qwen 3 through OpenCode.` |
| Failed | Retry when still supported | Revert to the last confirmed state; show failure feedback | Provider error in plain language. Persistent limitations become Unsupported. |

Use the same confirmed-on treatment for Fast, Plan, effort, and edit mode. Fast keeps its short text label. Plan and edit mode show only their selected icons in the toolbar; their selection menus retain full labels. The toolbar never contains an agent selector.

Unsupported controls use an accessible disabled pattern rather than an unfocusable native disabled button: `aria-disabled="true"`, guarded activation handlers, and a tooltip reachable by hover and keyboard focus. This preserves the explanatory hint while preventing mouse, keyboard, and programmatic activation.

Switching providers recalculates capabilities immediately. Unsupported values are not sent to the new provider. Provider-scoped selections may remain in the draft store so switching back restores the previous supported choice.

## Failure and Recovery

- A failed option update must not mutate `applied` session state.
- Delivery must stop before the prompt is sent when reconciliation definitely fails.
- A restart/resume fallback must preserve the provider session identity or resume cursor needed to keep conversation context.
- If delivery certainty is unknown, preserve the existing durable-delivery safeguards; do not retry a prompt merely to apply an option.
- Transient provider errors revert the control to its last confirmed value and permit retry.
- Explicit provider rejection, missing configuration, cooldown, or account ineligibility disables the control and exposes the reason.
- Logs include provider instance, model, canonical option id, requested value, application method, and result, without recording prompt contents or secrets.

## Testing

### Shared and runtime tests

- Capability detection distinguishes supported, unsupported, and unknown.
- Unsupported options are removed or rejected before provider invocation.
- Reconciliation applies only changed values and updates applied state only after success.
- Existing sessions apply Fast before their next delivery.
- Restart/resume fallback retains conversation continuity.
- Failure prevents delivery, preserves the previous applied value, and returns a usable reason.
- Restored drafts and turn-start commands pass through the same reconciliation boundary.

### Provider adapter tests

- Codex maps Fast to `serviceTier` at launch and update.
- Claude generates per-session `fastMode` settings and does not modify user-global settings.
- Cursor sends ACP `fast` configuration and consumes its acknowledgement.
- OpenCode uses only advertised speed variants and otherwise reports a stable unsupported reason.

### Web tests

- Confirmed controls receive the existing primary solid classes in light and dark themes.
- Unsupported controls remain visible, expose `aria-disabled`, ignore activation, and show their reason on hover and focus.
- Unknown/applying states are distinct from both off and unsupported.
- Failed updates restore the last confirmed value.
- Switching provider/model recomputes control availability without sending stale options.
- Plan disabled maps to build while no Build icon is rendered.
- No provider renders an agent selector in the toolbar.

### Desktop visual verification

After building and launching the desktop app, use the Codex Computer Use skill against the unique `BiBCode` window. Capture screenshots and accessibility state for:

1. Fast and Plan off.
2. Fast and Plan confirmed on with the solid theme-native fill.
3. Applying/uncertain state.
4. A provider/model with Fast or Plan unsupported, including the hover/focus reason.
5. At least one light-theme and one dark-theme capture.
6. A compact window width to confirm labels and icons do not overflow or jump.

The current baseline is a regression reference: accessibility reports `Disable fast mode` while Fast remains visually low contrast. The completed UI must make the enabled state obvious without introducing a feature-specific accent color.

### Required commands

- Run focused web and Rust tests for the modified modules.
- Run `vp check`.
- Run `vp run typecheck`.

## Acceptance Criteria

- Toggling Fast changes real provider behavior for supported Codex, Claude, Cursor, and OpenCode configurations.
- An already-running provider session receives the change or is safely resumed before the next prompt.
- Unsupported controls remain visible, cannot activate, and state why.
- The UI never claims Fast is enabled after a provider rejected or ignored it.
- Enabled Fast, Plan, effort, and edit-mode controls use the existing solid primary theme treatment.
- Plan disabled selects build mode without displaying a Build icon.
- Agent selection is absent from every provider's toolbar.
- Computer Use visual verification and the required automated checks pass.
