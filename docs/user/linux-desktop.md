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

## Disable GPU compositing

On some Intel integrated GPUs the graphics driver can hang while BiBCode draws
its window, and on a compositor such as Hyprland that ends the whole desktop
session. If that happens, turn on **Settings > Appearance > Rendering > Disable
GPU compositing** and restart BiBCode. The window is then drawn by the CPU,
which can be slower, so leave it off unless you need it.

The setting applies however BiBCode starts: from the application menu, from the
binary itself, or from a `bibcode://` link. It is stored as
`"linuxSoftwareRendering": true` in `~/.bibcode/userdata/desktop-settings.json`
(under `$BIBCODE_HOME` if you set it). A `BIBCODE_HOME` exported in one shell
only applies to launches from that shell. If no window can be shown, edit that
file, or start BiBCode once with the setting forced on:

```sh
BIBCODE_SOFTWARE_RENDERING=1 /path/to/BiBCode.AppImage
```

`BIBCODE_SOFTWARE_RENDERING=0` makes BiBCode leave the GPU settings alone for
that launch. While either value is set, Settings shows the switch as disabled.

With the setting on, BiBCode sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` and
`WEBKIT_DISABLE_DMABUF_RENDERER=1` for itself before it opens a window. A
value you exported yourself for either variable is kept as it is. Programs
started from BiBCode's terminals inherit the two variables, so another BiBCode
started from such a terminal also runs without GPU compositing until you start
it from elsewhere.
