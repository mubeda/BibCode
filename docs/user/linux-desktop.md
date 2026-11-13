# Linux Desktop

Download the `.AppImage` matching your architecture (ARM64 or x64) from
[GitHub Releases](https://github.com/mubeda/BibCode/releases), make it executable,
and launch it. See [Provider setup](../providers/README.md) to connect a coding
agent.

## System libraries

The AppImage carries most of what it needs but uses three libraries from your
system: `libGLESv2.so.2`, `libfontconfig.so.1` and `libfribidi.so.0`. Desktop
installations have them; a minimal system or container may not. On Ubuntu and
Debian they come from the `libgles2`, `libfontconfig1` and `libfribidi0`
packages. Audio playback also uses the system's `libasound.so.2` (ALSA) and,
where one runs, the PulseAudio or PipeWire sound server.

## Wayland and fractional scaling

The AppImage prefers native Wayland on Wayland sessions and falls back to X11
when Wayland is unavailable. X11-only desktops continue to work automatically.
This fixes oversized rendering on Hyprland/Omarchy with fractional scaling,
where forcing the app through Xwayland could render it at 2× on a 1.5× desktop.

If native Wayland causes problems on your desktop, close BiBCode and launch the
AppImage with the previous X11 backend:

```sh
BIBCODE_GDK_BACKEND=x11 /path/to/BiBCode.AppImage
```

On a Wayland session this uses Xwayland and may bring back the fractional-scaling
issue. Launch without `BIBCODE_GDK_BACKEND` to restore automatic backend
selection; remove the variable from your environment or launcher if you saved it
there.
