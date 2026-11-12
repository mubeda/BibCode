# Third-Party Notices: Linux AppImage native components

The Linux AppImage carries shared libraries copied unmodified from its Ubuntu
22.04 build host, except that linuxdeploy and the GStreamer plugin rewrite their
run paths with `patchelf`. BiBCode and WebKitGTK load them dynamically. Each
component's corresponding source is the Ubuntu 22.04 (jammy) source package
named below, available from <https://launchpad.net/ubuntu/+source/> and from
the upstream project.

This file lives in the repository; it is not yet shipped inside the AppImage.

This file covers the GStreamer plugins and the libraries bundled for them. It
does not yet cover the components every AppImage already carried before them
(WebKitGTK, GTK, GLib, the GStreamer core and base libraries, and their
dependencies); see [Not yet recorded](#not-yet-recorded).

## GStreamer plugins

The plugin list is `allowed_plugins` in
`scripts/tauri/linuxdeploy-plugin-gstreamer.sh`. Every plugin comes from one of
three source packages, and each source package's Ubuntu copyright file is the
licence source:

| Source package (jammy version)             | Plugins                                                                                                                                                                                                      | Licence | Copyright file                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gstreamer1.0` (1.20.3-0ubuntu1.1)         | `libgstcoreelements.so`                                                                                                                                                                                      | LGPL-2+ | <https://changelogs.ubuntu.com/changelogs/pool/main/g/gstreamer1.0/gstreamer1.0_1.20.3-0ubuntu1.1/copyright>                |
| `gst-plugins-base1.0` (1.20.1-1ubuntu0.7)  | `libgstplayback.so`, `libgsttypefindfunctions.so`, `libgstapp.so`, `libgstaudioconvert.so`, `libgstaudioresample.so`, `libgstvolume.so`, `libgstogg.so`, `libgstvorbis.so`, `libgstopus.so`, `libgstalsa.so` | LGPL-2+ | <https://changelogs.ubuntu.com/changelogs/pool/main/g/gst-plugins-base1.0/gst-plugins-base1.0_1.20.1-1ubuntu0.7/copyright>  |
| `gst-plugins-good1.0` (1.20.3-0ubuntu1.10) | `libgstautodetect.so`, `libgstpulseaudio.so`, `libgstaudiofx.so`, `libgstwavparse.so`, `libgstaudioparsers.so`, `libgstid3demux.so`, `libgstmpg123.so`, `libgstflac.so`, `libgstmatroska.so`                 | LGPL-2+ | <https://changelogs.ubuntu.com/changelogs/pool/main/g/gst-plugins-good1.0/gst-plugins-good1.0_1.20.3-0ubuntu1.10/copyright> |

In those copyright files the only non-LGPL entries are build tooling
(`ltmain.sh`, `common/coverage/coverage-report-entry.pl`, GPL-2+) and, in the
core, the Bison-generated `gst/parse/grammar.tab.h` (GPL-3+), which belongs to
the core library rather than to `libgstcoreelements.so`. Whether that header
carries Bison's output exception is unverified; the lab confirms it, and that
no listed plugin is built from a GPL file, against
`/usr/share/doc/<package>/copyright` on the build host.

## Libraries bundled for the plugins

linuxdeploy copies each plugin's shared-library dependencies that its exclude
list does not leave to the host. The libraries below were new in the AppImage
once the plugins were bundled: confirmed from the built AppImage at 34f309e4d in
the Linux lab, by comparing its bundled libraries with the AppImage built before
the plugins. Each licence is the one the package's jammy copyright file states.

| Library (binary package)                                               | Needed by                              | Licence (jammy copyright file)                                                                | Copyright file (jammy)                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `libmpg123.so.0` (`libmpg123-0`)                                       | `libgstmpg123.so`                      | LGPL-2.1                                                                                      | <https://changelogs.ubuntu.com/changelogs/pool/main/m/mpg123/mpg123_1.29.3-1ubuntu0.1/copyright>                           |
| `libFLAC.so.8` (`libflac8`)                                            | `libgstflac.so`                        | See [FLAC](#flac)                                                                             | <https://changelogs.ubuntu.com/changelogs/pool/main/f/flac/flac_1.3.3-2ubuntu0.2/copyright>                                |
| `libogg.so.0` (`libogg0`)                                              | `libgstogg.so`, `libgstvorbis.so`      | BSD-style ("Redistribution and use in source and binary forms, with or without modification") | <https://changelogs.ubuntu.com/changelogs/pool/main/libo/libogg/libogg_1.3.5-0ubuntu3/copyright>                           |
| `libopus.so.0` (`libopus0`)                                            | `libgstopus.so`                        | BSD-style ("Redistribution and use in source and binary forms, with or without modification") | <https://changelogs.ubuntu.com/changelogs/pool/main/o/opus/opus_1.3.1-0.1build2/copyright>                                 |
| `libvorbis.so.0`, `libvorbisenc.so.2` (`libvorbis0a`, `libvorbisenc2`) | `libgstvorbis.so`                      | BSD-3-Clause                                                                                  | <https://changelogs.ubuntu.com/changelogs/pool/main/libv/libvorbis/libvorbis_1.3.7-1build2/copyright>                      |
| `libpulse.so.0`, `libpulsecommon-15.99.so` (`libpulse0`)               | `libgstpulseaudio.so`                  | LGPL-2.1+                                                                                     | <https://changelogs.ubuntu.com/changelogs/pool/main/p/pulseaudio/pulseaudio_15.99.1+dfsg1-1ubuntu1/copyright>              |
| `libsndfile.so.1` (`libsndfile1`)                                      | `libpulse.so.0`                        | LGPL-2.1+                                                                                     | <https://changelogs.ubuntu.com/changelogs/pool/main/libs/libsndfile/libsndfile_1.0.31-2ubuntu0.2/copyright>                |
| `libasyncns.so.0` (`libasyncns0`)                                      | `libpulse.so.0`                        | LGPL-2.1+                                                                                     | <https://changelogs.ubuntu.com/changelogs/pool/main/liba/libasyncns/libasyncns_0.8-6build2/copyright>                      |
| `libapparmor.so.1` (`libapparmor1`)                                    | `libpulse.so.0`                        | LGPL-2.1+ (`libraries/libapparmor/*`)                                                         | <https://changelogs.ubuntu.com/changelogs/pool/main/a/apparmor/apparmor_3.0.4-2ubuntu2.4/copyright>                        |
| `libgstriff-1.0.so.0` (`libgstreamer-plugins-base1.0-0`)               | `libgstwavparse.so` and other demuxers | LGPL-2+                                                                                       | <https://changelogs.ubuntu.com/changelogs/pool/main/g/gst-plugins-base1.0/gst-plugins-base1.0_1.20.1-1ubuntu0.7/copyright> |

Other files in some of these source packages carry other licences but are not
part of the bundled libraries:

- `pulseaudio`: `src/modules/bluetooth/proximity-helper.c` is GPL-2+; it is a
  PulseAudio module, not part of `libpulse` or `libpulsecommon`.
- `libsndfile`: besides the LGPL-2.1+ library sources, the package holds the
  GSM610 code (its own `gsm` licence), the ALAC code (Apache-2.0) and the G72x
  code (Sun's licence), which are compiled into `libsndfile.so.1`, and a GPL-2+
  test file (`src/G72x/g72x_test.c`), which is not.
- `apparmor`: the package's `Files: *` stanza is GPL-2+; `libapparmor` is
  covered by the `libraries/libapparmor/*` stanza, LGPL-2.1+.

### FLAC

Ubuntu's jammy copyright file for `flac` (1.3.3-2ubuntu0.2) gives `Files: *`
as "GPL-2+ or LGPL-2.1+", `examples/*` as GPL-2+ and `doc/*` as GFDL-1.1+, and
has a separate stanza listing `src/libFLAC/*` (with `include/FLAC/*` and
`src/libFLAC++/*`) as BSD-3-clause. Upstream FLAC 1.3.3's `README` says the
same: "The libraries (libFLAC, libFLAC++) are licensed under Xiph.org's BSD-like
license (see COPYING.Xiph)". The lab's reading of the copyright file on its
build host showed only the `Files: *` stanza; if a host's file really lacks the
`src/libFLAC/*` stanza, the libFLAC licence rests on the upstream statement.

### Libraries the plugins use from the host

linuxdeploy's exclude list keeps these on the host, so the AppImage does not
carry them: `libz.so.1`, `libasound.so.2` (the ALSA plugin therefore uses the
host's `libasound.so.2`), `libpulse-mainloop-glib.so.0` and `libwrap.so.0`.

### Already bundled before the plugins

`liborc-0.4.so.0` (`liborc-0.4-0`) and `libbz2.so.1.0` (`libbz2-1.0`), which
some plugins use, were already in the AppImage before the plugins were added;
they fall under [Not yet recorded](#not-yet-recorded).

`libmp3lame` (LAME) is not bundled, as the lab confirmed: its only consumer,
the `lame` encoder plugin, is not on the allowlist, and its jammy copyright file
lists a GPL file (`libmp3lame/fft.c`).

## Not yet recorded

The AppImage already bundled WebKitGTK, GTK, GLib, the GStreamer core and base
libraries, and their dependencies before these plugins were added, and no
notice records them. That gap predates this file and remains open.
