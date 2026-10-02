# Disposable Arch AppImage qualification procedure

This branch contains a temporary CI qualification for issue 41. Its workflow
and driver are not intended to replace normal packaging or become part of the
issue-fix branch.

Use the official Arch userspace image pinned in the workflow. Keep package
signature verification enabled and record the installed GdkPixbuf, Glycin and
librsvg versions, advertised loader directory, userspace and host kernel.
The missing legacy directory must be observed in the real installed package;
never manufacture its absence or create an empty replacement.

The current wrapper must reject that unsupported build layout before changing
an owned AppDir, with guidance to use the supported Ubuntu build baseline or
published AppImage. Verify the pinned upstream plugin hash first so a missing
plugin cannot masquerade as the desired loader-layout diagnostic.

Separately verify the published x64 AppImage's GitHub asset digest, then launch
it as a new unprivileged container user with private application/XDG/HOME/TMP
roots, disabled providers and no ambient credentials. Use an authenticated,
owned Xvfb display with no TCP listener and the supported AppImage extraction
mode. Require the real native descriptor and a rendered application window,
then inspect the retained original screenshot. This does not claim a native
Arch packaging success, FUSE mount behavior, or the original Omarchy kernel.

Every request, subprocess and observation has a finite bound. Record and reap
the exact owned direct children; retain creation-aware descendant handles for
cleanup. Never signal an unrelated application. Upload only the allowlisted
diagnostic, provenance, runtime/cleanup metadata and screenshot. Keep full app
logs, application databases, environment and X authentication material private.

No native result is claimed by this procedure. Successful CI execution and
subsequent image review are required before writing the execution report.

The ordinary [Linux runbook](../linux-desktop.md) was reviewed and remains
accurate. The temporary job tests its documented diagnostic and fallback path.
