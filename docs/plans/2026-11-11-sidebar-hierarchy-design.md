# Sidebar hierarchy

Issue #290, section "Extension", amendment A9. Requirements R63 to R65, decision D21. This note
covers Task 10.1 (tokens, level rules and the theme editor preview). Task 10.2 sets the level
attributes in the left panel.

## Problem

In Light and Dark the left panel draws the repository card, the environment band, the primary
checkout, a worktree and a chat row with nearly the same surface. The band is black 2.5 percent
over white in Light (`#f9f9f9` on `#ffffff`), and the primary checkout differs from a worktree
only by a small grey `primary` pill. A person cannot tell at a glance which row is a machine,
which is the main checkout and which is a worktree.

## The five levels

Each level differs from its neighbors by a cue that does not need color. Color then supports the
cue.

| Level       | Attribute                                                           | Cues without color                                                                      | Colored cue                                                                                    |
| ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Repository  | `data-sidebar-level="repo"`                                         | outlined, lifted card (`SIDEBAR_CARD_CLASS`), 13px medium title                         | `sidebar-card`, `sidebar-card-border`                                                          |
| Environment | `data-sidebar-level="environment"`                                  | inset band with a 3px leading rule, machine icon, status text                           | `sidebar-env-band`, `sidebar-env-accent`                                                       |
| Checkout    | `data-sidebar-level="checkout"`, primary marked with `data-primary` | house icon, 600 weight label, a `primary` badge                                         | `sidebar-primary-badge`, `sidebar-primary-badge-foreground`                                    |
| Worktree    | `data-sidebar-level="worktree"`                                     | branch icon, indent of 0.75rem, a 1px indent guide beside it, its own outlined surface  | `sidebar-worktree`, `sidebar-worktree-border`, `sidebar-worktree-icon`, `sidebar-indent-guide` |
| Chat        | `data-sidebar-level="chat"`                                         | 12px (`text-xs`, the app's floor) at weight 400 under a 13px checkout or worktree label | `sidebar-chat-foreground`                                                                      |

The "N more chats" and hidden-worktrees rows are chat level. Inside a level, three child markers
let one rule reach the right element: `data-sidebar-label` (the checkout or branch name),
`data-sidebar-icon` (the leading icon) and `data-sidebar-badge` (the `primary` badge).

## Tokens

D21 adds eight tokens and keeps `sidebar-well`, `sidebar-card`, `sidebar-card-border`,
`sidebar-env-band`, `sidebar-card-shadow` and the derived `--sidebar-card-muted-foreground` as
they are, with no aliases. Every new token is declared in the light block of `index.css` and,
where Dark needs another recipe, in its dark block, in terms of other tokens. A theme that sets
`primary`, `foreground`, `sidebar-card` or `sidebar-env-band` therefore moves the levels with it,
and a theme file saved before these tokens existed keeps working (R65, old theme file).
`DERIVED_DEFAULTS` in `baseTokenValues.ts` repeats each recipe, and `BASE_TOKEN_VALUES` holds its
painted value.

| Token                              | Light recipe                                | Light value | Dark recipe                                 | Dark value |
| ---------------------------------- | ------------------------------------------- | ----------- | ------------------------------------------- | ---------- |
| `sidebar-env-accent`               | `primary`                                   | `#d8610e`   | same                                        | `#d8610e`  |
| `sidebar-primary-badge`            | `primary` 14 percent over `sidebar-card`    | `#fae9dd`   | `primary` 24 percent over `sidebar-card`    | `#4c2f1b`  |
| `sidebar-primary-badge-foreground` | `primary` 65 percent with black             | `#8c3f09`   | `primary` 55 percent with white             | `#eaa87a`  |
| `sidebar-worktree`                 | `primary` 5 percent over `sidebar-card`     | `#fdf7f3`   | `primary` 7 percent over `sidebar-env-band` | `#332b25`  |
| `sidebar-worktree-border`          | `foreground` 16 percent over the worktree   | `#dbd6d2`   | `foreground` 18 percent over the worktree   | `#564f4a`  |
| `sidebar-worktree-icon`            | `primary` 80 percent with black             | `#ad4e0b`   | `primary` 70 percent with white             | `#e49056`  |
| `sidebar-chat-foreground`          | `foreground` 80 percent over `sidebar-card` | `#515151`   | `foreground` 78 percent over `sidebar-card` | `#c6c6c6`  |
| `sidebar-indent-guide`             | `foreground` 45 percent over the band       | `#9a9a9a`   | same                                        | `#838383`  |

In Dark a worktree lifts off the band (it is lighter), as the band lifts off the card. In Light
it is the near-white of the card with a warm tint, so it reads as a lifted row on the grey band.
The chat text equals today's thread titles (`text-foreground/80`) on an opaque surface.

The recipes reach the built-ins through their own overrides. Tokyo Night and Matrix Dark set
three values because the recipes fail there (see the contrast table): `sidebar-worktree`
(`#1f2335`, `#0f1f13`), `sidebar-worktree-border` (`#3b4261`, `#2a6b37`) and
`sidebar-chat-foreground` (their `foreground`, `#a9b1d6` and `#8bc98c`). Both themes lighten the
band strongly, so a worktree there is darker than the band instead. Matrix Light and Verdant
Light use the recipes unchanged.

`resolveToken` keeps full precision through a recipe chain and rounds once, at the final hex,
because a level token is built on another derived token (`sidebar-worktree-border` on
`sidebar-worktree` on `sidebar-env-band`). The base values a recipe reads start unrounded too:
`BASE_EXACT_VALUES` holds the values the stylesheet paints from Tailwind's oklch palette,
`color-mix()` and `--alpha()` (Dark `background`, both bases' `foreground`, `muted-foreground`,
`accent` and `accent-foreground`), and a test checks every recipe source against the stylesheet.
The parity tests compare the resolver with the stylesheet exactly, on unmodified defaults and with
each source overridden. This also corrected built-in Dark `sidebar-card` and `sidebar-env-band`,
which the resolver had given as `#1f1f1f` and `#262626` while the stylesheet paints `#202020` and
`#272727`.

## Contrast

`FIXED_PAIRS` gains nine pairs. Each pair carries its minimum and the overrides an import may
remove when it fails (R55):

- Four pairs with a sidebar token as text: badge text on the badge, and chat text on the card,
  on the band and on the worktree. An import that fails one loses the text override, then the
  surface override if the pair still fails. An import whose badge text falls below 4.5:1
  therefore loses that override (R65, unreadable level). An older theme that sets only
  `sidebar-env-band` (for example `#262626` on a light base) fails chat on the band, has no chat
  override, and so loses its band override.
- Four pairs with global text on a sidebar surface: `foreground` and the painted sidebar muted
  text (`--sidebar-card-muted-foreground`, Tailwind's neutral-400 in Dark, `resolveSidebarMuted`)
  on the band and on the worktree. An import that fails one loses only the sidebar surface
  override, never the global text (coordinator's call, Task 10.1 review round 2). A dark import
  that sets the band and the worktree to `#444444` therefore keeps its `muted-foreground` and
  loses both surfaces.
- The worktree icon on the worktree, at 3:1 because the icon is a graphic. An import that fails
  it loses only the icon override.

The editor's Contrast list shows every pair, warns against each pair's own minimum, and names the
3:1 minimum next to the icon pair. Themes already stored on a device are not passed through this
reset: `readLibrary` and the paint record only validate them (`validateThemeFile`), and only the
import dialog calls `planThemeImport` (R65, old theme file).

Measured with `contrastRatio` and `resolveToken` on the committed values. "Muted" is the painted
sidebar muted text. Markers are checked against 3:1, the WCAG minimum for a graphic.

| Theme         | Badge text on badge | Chat on card | Chat on band | Chat on worktree | Text on band | Text on worktree | Muted on band | Muted on worktree | Icon on worktree | Accent rule on band | Primary icon on band | Indent guide on band |
| ------------- | ------------------- | ------------ | ------------ | ---------------- | ------------ | ---------------- | ------------- | ----------------- | ---------------- | ------------------- | -------------------- | -------------------- |
| Light         | 6.28                | 7.94         | 7.54         | 7.47             | 14.37        | 14.25            | 5.29          | 5.25              | 5.11             | 3.54                | 7.05                 | 2.67                 |
| Dark          | 6.00                | 9.54         | 8.75         | 8.13             | 13.70        | 12.73            | 5.78          | 5.37              | 5.57             | 4.01                | 7.38                 | 3.94                 |
| Tokyo Night   | 5.85                | 6.90         | 6.36         | 7.37             | 6.36         | 7.37             | 4.52          | 5.24              | 8.35             | 5.33                | 8.33                 | 2.49                 |
| Matrix Dark   | 7.03                | 9.16         | 5.33         | 8.84             | 5.33         | 8.84             | 4.81          | 7.97              | 9.29             | 4.33                | 6.42                 | 2.31                 |
| Matrix Light  | 7.58                | 9.03         | 8.04         | 8.46             | 15.25        | 16.05            | 5.48          | 5.77              | 6.63             | 4.47                | 8.18                 | 2.80                 |
| Verdant Light | 7.51                | 6.38         | 5.94         | 5.99             | 11.06        | 11.16            | 5.71          | 5.76              | 6.56             | 4.65                | 8.47                 | 2.42                 |

Every text pair is at or above 4.5:1, and the accent rule and both icons at or above 3:1. Before
the built-in overrides, the recipes gave Tokyo Night chat on the band 4.44 and on the worktree
3.94, muted on the worktree 4.01, and Matrix Dark chat on the band 3.53 and on the worktree 3.16,
muted on the worktree 4.31. The overrides above fix all six.

The indent guide stays between 2.3:1 and 4.0:1. It repeats the indent, which already carries the
level, so it is a supporting line and not a required graphic. Raising it to 3:1 in Light makes a
1px line darker than the branch label. The worktree surface differs from the band by 1.01:1 to
1.66:1 in luminance, so the worktree's outline, indent, guide and icon carry the level, not its
fill.

## Card states (R64)

`resolveWorkspaceCardClassName` in `Sidebar.logic.ts` keeps its classes for every card: outlined,
the active card's `bg-foreground/8`, the selected card's `bg-primary/15` with `border-primary/40`,
the selected and active card's `bg-primary/22` with `border-primary/60`, the hover `bg-accent/60`,
the inner button's orange focus ring and the `opacity-60` of an unavailable environment.

On checkout and worktree rows those fills are translucent and replace the worktree surface. In
Tokyo Night and Matrix Dark they dropped a selected row's text to 3.7:1. Unlayered row rules in
`index.css` therefore replace the state fills and borders on these two levels. Every state mixes
into `sidebar-worktree`, so it stays opaque and a selected checkout looks like a selected worktree.
These mixes are not theme tokens (D21).

| State               | Attributes                                  | Fill                   | Border                       |
| ------------------- | ------------------------------------------- | ---------------------- | ---------------------------- |
| Resting worktree    | none                                        | `sidebar-worktree`     | `sidebar-worktree-border`    |
| Resting checkout    | none                                        | none (the band)        | the card class's transparent |
| Hover               | `:hover`                                    | `foreground` 3 percent | unchanged                    |
| Active              | `data-active="true"`                        | `foreground` 8 percent | `foreground` 40 percent      |
| Selected            | `data-selected="true"`                      | `primary` 16 percent   | `primary` 40 percent         |
| Selected and active | `data-selected="true"` `data-active="true"` | `primary` 20 percent   | `primary` 60 percent         |

Each fill is the named color mixed into `sidebar-worktree`. Hover paints over the resting surface,
so it is never weaker than resting. Selected beats hover and active, and selected and active beats
selected, because the rules have rising specificity in that order. On a hover, active or selected
row the label (`data-sidebar-label`, outside the primary checkout) paints `foreground` instead of
`foreground` at 90 percent, and the muted text paints the chat color. Selection keeps the
`primary` tint of R64 and differs from hover by hue, border and fill.

Contrast of label, chat and muted text on each composited row surface, measured with
`contrastRatio`, `resolveToken` and the evaluated rules. A test checks every cell at 4.5:1.

| Theme         | Resting worktree    | Resting checkout    | Hover               | Active              | Selected            | Selected and active |
| ------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| Light         | 10.62 / 7.47 / 5.25 | 10.69 / 7.54 / 5.29 | 13.52 / 7.09 / 7.09 | 12.25 / 6.42 / 6.42 | 11.82 / 6.20 / 6.20 | 11.28 / 5.92 / 5.92 |
| Dark          | 10.65 / 8.13 / 5.37 | 11.40 / 8.75 / 5.78 | 11.69 / 7.46 / 7.46 | 10.05 / 6.41 / 6.41 | 10.64 / 6.79 / 6.79 | 10.00 / 6.38 / 6.38 |
| Tokyo Night   | 6.27 / 7.37 / 5.24  | 5.48 / 6.36 / 4.52  | 6.99 / 6.99 / 6.99  | 6.34 / 6.34 / 6.34  | 5.55 / 5.55 / 5.55  | 5.15 / 5.15 / 5.15  |
| Matrix Dark   | 7.42 / 8.84 / 7.97  | 4.66 / 5.33 / 4.81  | 8.38 / 8.38 / 8.38  | 7.55 / 7.55 / 7.55  | 6.61 / 6.61 / 6.61  | 6.11 / 6.11 / 6.11  |
| Matrix Light  | 12.21 / 8.46 / 5.77 | 11.70 / 8.04 / 5.48 | 15.10 / 7.96 / 7.96 | 13.65 / 7.20 / 7.20 | 12.95 / 6.83 / 6.83 | 12.32 / 6.50 / 6.50 |
| Verdant Light | 8.33 / 5.99 / 5.76  | 8.27 / 5.94 / 5.71  | 10.59 / 5.68 / 5.68 | 9.68 / 5.19 / 5.19  | 8.98 / 4.82 / 4.82  | 8.50 / 4.56 / 4.56  |

### Attribute contract for Task 10.2

The row rules work only when the left panel sets these attributes. Task 10.2 MUST set them on the
same element that carries `resolveWorkspaceCardClassName`:

- `data-sidebar-level="checkout"` or `data-sidebar-level="worktree"` on each workspace row, and
  `data-primary` (any value) on the primary checkout.
- `data-selected="true"` when the row is selected (`isSelected`), and no attribute otherwise.
- `data-active="true"` when the row is active (`isActive`), and no attribute otherwise.
- `data-sidebar-label` on the element that holds the checkout or branch name,
  `data-sidebar-icon` on the leading icon and `data-sidebar-badge` on the `primary` badge.
- `data-sidebar-level="chat"` on each chat row and on the "N more chats" row inside a checkout or
  worktree, so the muted text and chat rules reach them.

`SidebarLevelsPreview` sets the same attributes: `feature/sample` is selected and
`feature/sample-docs` is active and not selected.

## Where the styles live

All level rules are in one block of `apps/web/src/index.css`, after the `[data-sidebar-card]`
rule, keyed on `data-sidebar-level`, `data-primary` and the three child markers. The theme editor's
Sidebar group shows `SidebarLevelsPreview` (`apps/web/src/components/settings/`), a static,
`inert` figure of fixture data: one repository (`example-group/sample-project`) with two
environments (Local, connected, and `example-server`, unavailable), the primary checkout `main`,
two worktrees (`feature/sample`, selected, and `feature/sample-docs`, active), chat rows and a "3
more chats" row. It uses `SIDEBAR_CARD_CLASS` and `resolveWorkspaceCardClassName` from
`Sidebar.logic.ts`, so it is drawn by the same rules and state classes as the left panel. Editing
a token repaints the preview through the editor's live theme preview, with no subscription in the
preview.

## Alternatives (D21)

- The issue's eighteen tokens. They rename `sidebar-card`, `sidebar-card-border`,
  `sidebar-env-band` and `sidebar-card-shadow`, which would need aliases or break saved themes.
- A separate selected-worktree token. Selection keeps the primary-tinted states of R64, which the
  user refined on 2026-09-25.
- A sidebar radius token. The `radius` token already exists.
- Level styles as Tailwind classes at each call site. The preview and the left panel would then
  repeat the same class lists, and a theme could not reach a level through one rule.
- Unlayered level rules for every level. They would paint over the selected, active and hover
  classes and break R64. Only the checkout and worktree row states are unlayered, and they restate
  each state themselves.
- Text fixes alone on the selected rows. Muted text could not reach 4.5:1 on a translucent
  `primary` fill over the band in Tokyo Night and Matrix Dark without changing its color at rest.

New defaults for Light and Dark are intended. R50's "today's look" covers only the six roles it
names.
