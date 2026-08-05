# macOS Full-Black Icon

## Summary

BiBCode's macOS application icon appears as a small black tile on a large pale
plate in Finder on macOS 26. The working T4Code fork uses the same Tauri bundle
configuration and a traditional ICNS file without that plate. BiBCode must
restore T4Code's macOS enclosure geometry while retaining the current white
`BiB` mark.

## Diagnosis

The source and packaged BiBCode ICNS files are byte-identical, and both bundles
select their icon through `CFBundleIconFile`. Finder cache, Tauri metadata, DMG
packaging, signing, and the ICNS format are therefore not the differentiators.

The macOS PNG alpha masks differ materially:

| Measurement | T4Code | BiBCode |
| --- | ---: | ---: |
| Transparent corner area | 2.7% | 0.5% |
| First opaque pixel on the top row | x=171 | x=71 |
| Finder-rendered dark pixels | 77.6% | 42.6% |
| Finder-rendered pale pixels | 17.6% | 57.2% |

A differential probe applied only T4Code's alpha channel to the existing
BiBCode pixels, regenerated an ICNS, and placed it into a temporary copy of the
BiBCode application. Finder then rendered that copy with 81.9% dark pixels and
13.3% pale pixels. This isolates the regression to the macOS enclosure mask.

## Goals

- Render the BiBCode application as a full black macOS enclosure with the
  existing white `BiB` mark.
- Match the proven T4Code macOS corner geometry.
- Preserve the existing macOS 11 minimum version.
- Keep the existing Tauri, DMG, updater, and ad-hoc signing workflows.
- Prevent future icon regeneration from restoring the incorrect shallow corner
  radius.

## Non-Goals

- Introduce Icon Composer, an asset catalog, or a custom macOS bundler.
- Change the Windows, Linux, web, marketing, or favicon artwork.
- Change application names, bundle identifiers, installer names, or signing.
- Change the size, font, placement, or wording of the white `BiB` mark.

## Asset Model

The macOS application artwork remains a platform-specific transparent PNG at
`assets/prod/black-macos-1024.png`. Its black enclosure uses the same alpha mask
as T4Code's known-good macOS artwork. The current BiBCode RGB artwork supplies
the black field and white lettering, so only the enclosure alpha geometry
changes.

`assets/prod/bibcode-black-macos.icns` remains the deterministic bundle
derivative. It contains the standard 16, 32, 128, 256, 512, and 1024 pixel
representations generated from the corrected macOS PNG. Tauri continues to
reference this ICNS through the existing `bundle.icon` configuration.

The canonical SVG and non-macOS assets remain unchanged. This avoids coupling
the macOS enclosure mask to platforms that require full square artwork or use
different masking rules. The sibling T4Code checkout is diagnosis-only input;
BiBCode's checked-in PNG and ICNS remain self-contained and no build or test may
depend on `/Users/admin/projects/t4code`.

## Implementation Boundary

The change is intentionally asset-local:

1. Add a regression assertion for the macOS PNG's alpha geometry and ICNS
   contents.
2. Verify that the assertion fails against the current shallow mask.
3. Replace only the alpha channel of the macOS PNG with the proven T4Code mask.
4. Regenerate only the macOS ICNS from the corrected PNG.
5. Verify the focused tests, repository gates, native macOS build, bundle
   signature, and Finder-rendered appearance.

No build hook or runtime code is added. Release behavior remains predictable on
hosts that do not have Xcode because the generated ICNS stays checked in.

## Regression Coverage

The portable repository test must reject the exact source regression by
checking all of the following:

- the macOS PNG is 1024 by 1024 with an alpha channel;
- the top-row opaque bounds match the T4Code enclosure within a narrow
  antialiasing tolerance;
- transparent and partially transparent pixels exist in the rounded corners;
- the center remains opaque;
- the ICNS contains all required representations, including its 1024-pixel
  image.

The macOS artifact check exercises the real user-visible seam. It renders the
built `.app` icon through `NSWorkspace`, measures opaque dark and pale pixels,
and requires a predominantly black result. The threshold must distinguish the
known failing BiBCode result from both the working T4Code artifact and the
corrected BiBCode probe without relying on an exact OS-dependent pixel count.

## Failure Handling

Icon generation must fail immediately if an expected source or iconset frame is
missing. The build and release configuration remains unchanged, so there is no
new platform-dependent runtime failure mode. If the final `.app` fails the
Finder-rendered appearance check, the release is not considered verified even
when the source-level geometry test passes.

## Verification

- Run the focused icon and Tauri hardening tests.
- Run `vp check` and `vp run typecheck`.
- Build the macOS application and DMG through the existing release command.
- Confirm the packaged ICNS matches the corrected repository ICNS.
- Confirm the application bundle still passes recursive `codesign`
  verification.
- Render the built application icon through `NSWorkspace` on macOS 26 and
  confirm that the large pale plate is absent.
- Confirm the Windows, Linux, web, and marketing asset hashes are unchanged.

## Expected Outcome

BiBCode displays the same full-black macOS enclosure behavior as T4Code while
showing the current `BiB` mark. The fix requires no new packaging format,
dependency, runtime component, or release branch.
