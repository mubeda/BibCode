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

`FIXED_PAIRS` gains four pairs, each with a sidebar token as its text, so the import reset of R55
removes only a sidebar override and never a theme's global `foreground` or `muted-foreground`:
badge text on the badge; chat text on the card, on the band and on the worktree. The editor's
Contrast list shows them, and an import whose badge text falls below 4.5:1 loses that override
(R65, unreadable level). The worktree icon is a graphic, so a test checks it at 3:1 on the
worktree instead of a fixed pair. As a fixed pair it would make an import that sets only
`sidebar-worktree` lose that override whenever the derived icon fell under 4.5:1.

Text in a level that uses a global token is checked by a separate test over the six built-ins:
`foreground` on the band and on the worktree, and the painted sidebar muted text
(`--sidebar-card-muted-foreground`, `neutral-400` in Dark) on the same two. Those pairs are not
fixed pairs, because the muted text inside a sidebar card is not the `muted-foreground` token in
Dark, and a fixed pair on it would misreport.

Measured with `contrastRatio` and `resolveToken` on the committed values. "Muted" is the painted
sidebar muted text. Markers are checked against 3:1, the WCAG minimum for a graphic.

| Theme         | Badge text on badge | Chat on card | Chat on band | Chat on worktree | Icon on worktree | Text on band | Text on worktree | Muted on band | Muted on worktree | Accent rule on band | Primary icon on band | Indent guide on band |
| ------------- | ------------------- | ------------ | ------------ | ---------------- | ---------------- | ------------ | ---------------- | ------------- | ----------------- | ------------------- | -------------------- | -------------------- |
| Light         | 6.28                | 7.94         | 7.54         | 7.47             | 5.11             | 14.37        | 14.25            | 5.29          | 5.25              | 3.54                | 7.05                 | 2.67                 |
| Dark          | 6.00                | 9.65         | 8.86         | 8.20             | 5.62             | 13.88        | 12.85            | 5.86          | 5.42              | 4.06                | 7.48                 | 3.99                 |
| Tokyo Night   | 5.85                | 6.90         | 6.36         | 7.37             | 8.35             | 6.36         | 7.37             | 4.52          | 5.24              | 5.33                | 8.33                 | 2.49                 |
| Matrix Dark   | 7.03                | 9.16         | 5.33         | 8.84             | 9.29             | 5.33         | 8.84             | 4.81          | 7.97              | 4.33                | 6.42                 | 2.31                 |
| Matrix Light  | 7.58                | 9.03         | 8.04         | 8.46             | 6.63             | 15.25        | 16.05            | 5.48          | 5.77              | 4.47                | 8.18                 | 2.80                 |
| Verdant Light | 7.51                | 6.38         | 5.94         | 5.99             | 6.56             | 11.06        | 11.16            | 5.71          | 5.76              | 4.65                | 8.47                 | 2.42                 |

Every text pair is at or above 4.5:1, and the accent rule and both icons at or above 3:1. Before the built-in
overrides, the recipes gave Tokyo Night chat on the band 4.44 and on the worktree 3.94, muted on
the worktree 4.01, and Matrix Dark chat on the band 3.53 and on the worktree 3.16, muted on the
worktree 4.31. The overrides above fix all six.

The indent guide stays between 2.3:1 and 4.0:1. It repeats the indent, which already carries the
level, so it is a supporting line and not a required graphic. Raising it to 3:1 in Light makes a
1px line darker than the branch label. The worktree surface differs from the band by 1.01:1 to
1.66:1 in luminance, so the worktree's outline, indent, guide and icon carry the level, not its
fill.

## Card states (R64)

The states stay the classes of `resolveWorkspaceCardClassName` in `Sidebar.logic.ts`: every card
outlined, the active card's `bg-foreground/8`, the selected card's `bg-primary/15` with
`border-primary/40`, the selected and active card's `bg-primary/22` with `border-primary/60`, the
hover `bg-accent/60`, the inner button's orange focus ring and the `opacity-60` of an unavailable
environment.

The level rules sit in `@layer components`, below Tailwind's utilities, so each state class
paints over a level's resting surface. A selected worktree (`primary` at 15 percent with a
`primary` border) is therefore much stronger than a hovered one (`accent` at 60 percent). One
rule sits outside the layers: `[data-sidebar-level="worktree"]:not([data-selected="true"])` sets
the worktree border, because the resting card class carries `border-transparent`, a utility that
would otherwise hide it. A selected worktree sets `data-selected="true"` and keeps the selection
border. Task 10.2 sets `data-selected` on worktree rows.

## Where the styles live

All level rules are in one block of `apps/web/src/index.css`, after the `[data-sidebar-card]`
rule, keyed on `data-sidebar-level`, `data-primary` and the three child markers. The theme editor's
Sidebar group shows `SidebarLevelsPreview` (`apps/web/src/components/settings/`), a static,
`inert` figure of fixture data: one repository (`example-group/sample-project`) with two
environments (Local, connected, and `example-server`, unavailable), the primary checkout `main`,
two worktrees (`feature/sample`, selected, and `feature/sample-docs`), chat rows and a "3 more
chats" row. It uses `SIDEBAR_CARD_CLASS` and `resolveWorkspaceCardClassName` from
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
- Unlayered level rules. They would paint over the selected, active and hover classes and break
  R64.

New defaults for Light and Dark are intended. R50's "today's look" covers only the six roles it
names.
