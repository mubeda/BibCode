# BiBCode Rebrand

## Goal

Rebrand the project and application from T4Code to **BiBCode**. User-facing
application names use `BiBCode`; icon artwork uses the compact mark `BiB`.

The work is intentionally staged. The visible product rebrand is completed and
verified first while compatibility-sensitive identifiers remain unchanged.
After that gate passes, internal identifiers are migrated to the BiBCode name
with compatibility handling wherever existing installations could otherwise
lose settings, data, or automation behavior.

No file will be staged or committed until the user explicitly approves a
commit.

## Scope

The audit covers every project-owned source-controlled or newly copied file,
including hidden project files, documentation, Markdown, application source,
tests, package metadata, desktop configuration, installer configuration,
release automation, CI, scripts, and image assets.

The audit excludes:

- `.git`, dependency directories, build output, caches, and generated indexes;
- `.repos`, whose contents are vendored reference repositories and are not
  owned by this project; and
- unrelated technical uses of `T4` that do not identify this application.

Historical upstream identity is not retained in product-facing screenshots,
copy, or artwork. If a historical reference is necessary for provenance, it
must be explicit prose rather than an accidental brand leftover.

## Brand Rules

- Canonical application name: `BiBCode`.
- Canonical icon text: `BiB`.
- `T4Code`, `T4 Code`, `T4Code Alpha`, `T4 Code Alpha`, and
  `T4Code (Alpha)` become `BiBCode` when they identify the product.
- A standalone product mark `T4` becomes `BiBCode` in prose or `BiB` in icon
  artwork, according to context.
- Alpha/nightly channel labels remain only when they describe an actual release
  channel; they are not part of the application name.
- The current monochrome visual identity is preserved: black background, white
  heavy type, compact rounded-square composition.
- Replacement is context-aware rather than a blind global substitution so
  unrelated technical terms and external examples are not corrupted.

## Phase 1: User-Visible Rebrand

Phase 1 changes every identity surface a user, installer, release consumer, or
documentation reader can encounter while leaving compatibility identifiers
such as `@bibcode/*`, Rust crate names, `BIBCODE_*`, persisted paths, and protocol
keys unchanged.

### Application and Web UI

- Replace visible titles, headings, menus, dialogs, accessibility labels,
  notifications, errors, onboarding copy, and attribution text.
- Update desktop window and product names while retaining the current Tauri
  application identifier until the internal migration phase.
- Update HTML metadata, manifests, social metadata, structured data, and
  marketing copy.
- Update test expectations and snapshots that verify visible text.

### Documentation

- Review all documentation directories and every Markdown file, including
  design specifications, plans, examples, and root-level contributor files.
- Update prose, commands, filenames, URLs, labels, screenshots, and alt text
  when they refer to the application brand.
- Preserve lowercase compatibility commands or variables during Phase 1, but
  describe them as legacy/internal where that distinction matters to readers.

### CI, Releases, Installers, and Artifacts

- Change workflow names, release titles, notes, installer product names,
  executable display names, bundle labels, and user-facing artifact basenames
  to BiBCode.
- Update all release and packaging tests together with their production code.
- Keep package filters, crate selectors, environment variables, internal marker
  filenames, and other compatibility identifiers unchanged until Phase 2.
- Keep the updater repository endpoint on `mubeda/BibCode` and ensure generated
  release URLs continue to use that repository.

### Images and Icons

`assets/prod/logo.svg` is the editable master for the monochrome icon. Its mark
will be changed from `T4` to `BiB`, then the existing asset path will be used to
regenerate or deterministically derive:

- universal and macOS PNG masters;
- Windows ICO and macOS ICNS bundles;
- web favicons and Apple touch icons; and
- copied web and marketing public assets.

Brand-bearing asset filenames will use `bibcode` instead of `t4` when the
filename itself is part of packaging or project identity. References and tests
will change atomically with those renames.

Marketing screenshots currently contain older T3/T4 identity. They will be
recaptured from the rebranded application where practical instead of having
text painted over. Any raster asset that cannot be regenerated will be edited
only after visual inspection, preserving its dimensions and purpose.

## Phase 1 Verification Gate

Phase 1 is complete only after:

1. an identity guard scans project-owned paths and text for removed visible
   forms without matching its own literal patterns;
2. all icon formats are decoded, dimensions are checked, and representative
   large and small sizes are visually inspected;
3. screenshots and other raster assets are visually reviewed for old identity;
4. focused application, packaging, release, and asset tests pass;
5. formatting, linting, typechecking, and the full practical test suite pass;
   and
6. `git diff` confirms that compatibility identifiers were not prematurely
   migrated.

Only after this gate passes does Phase 2 begin.

## Phase 2: Internal Identifier Migration

Phase 2 migrates code-level identity from `t4code`/`T4CODE` to
`bibcode`/`BIBCODE`, including:

- workspace package names and `@bibcode/*` imports;
- Rust workspace packages, crates, module references, and binary names;
- repository-owned filenames and directory names;
- environment variables and command-line-visible internal names;
- default config, cache, log, runtime, and application-data paths;
- storage keys, database names, protocol/IPC identifiers, and temporary marker
  names; and
- scripts, CI filters, fixtures, tests, documentation, and lockfiles that refer
  to those identifiers.

This phase uses dependency-aware renames rather than raw text replacement.
CodeGraph and compiler/test failures identify callers and consumers so each
shared identity is changed once at its owning boundary.

### Compatibility Policy

New code writes and advertises BiBCode identifiers. Legacy identifiers remain
readable where removing them would break an existing installation or external
automation:

- accept `BIBCODE_*` environment variables as fallback aliases, with `BIBCODE_*`
  taking precedence;
- discover legacy config/data paths and migrate or reuse their contents without
  destructive moves;
- read old persisted storage keys and write the canonical BiBCode key on the
  next successful save;
- retain protocol compatibility aliases when an installed client or helper may
  still emit the old value; and
- document intentionally retained aliases so the final leftover scan does not
  mistake them for accidental branding.

Purely repository-internal package and crate names receive a direct rename; no
compatibility facade is added when there is no external consumer or persisted
state to protect.

## Phase 2 Verification Gate

The final audit will:

- scan every project-owned path and textual file for old identity;
- allow only documented compatibility aliases in a centralized allowlist;
- verify both new identifiers and legacy fallback/migration behavior;
- rebuild package and Rust dependency graphs and refresh lockfiles;
- run formatting, linting, typechecking, focused migration tests, the full
  practical test suite, and representative desktop/web builds;
- decode and visually inspect all brand assets again; and
- review the final unstaged diff for accidental vendored, generated, or
  unrelated changes.

## Error Handling and Safety

- Existing settings and user data are never deleted as part of rebranding.
- Path migration is copy/read-compatible until the new location is proven
  usable; destructive cleanup is out of scope.
- Installer identity changes are checked against update behavior so existing
  users retain a valid upgrade path.
- Missing or malformed generated icon formats fail verification instead of
  silently falling back to old assets.
- Automated replacement never touches vendored `.repos` content.
- No staging, commit, push, release, or external publication occurs without
  explicit user authorization.

## Selected Approach

Use the staged migration above. It separates a verifiable product rebrand from
the riskier code and persistence migration, while still completing both parts
of the requested full rebrand in sequence.

## Alternatives Rejected

- **One-pass deep rename.** It mixes visible corrections with package, path,
  protocol, and persistence changes, making regressions and data-compatibility
  failures harder to isolate.
- **Permanent visual-only rebrand.** It leaves the repository and runtime
  identity inconsistent with BiBCode and does not satisfy the requested final
  internal migration.
- **Raster-by-raster redrawing.** The repository already has an SVG master and
  asset-copy pipeline, so independent manual icon edits would create needless
  drift between formats.
