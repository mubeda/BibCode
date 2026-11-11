# Third-Party Notices: Linux AppImage native components

The Linux AppImage carries shared libraries copied unmodified from its Ubuntu
22.04 build host, except that linuxdeploy and the GStreamer plugin rewrite their
run paths with `patchelf`. BiBCode and WebKitGTK load them dynamically. Each
component's corresponding source is the Ubuntu 22.04 (jammy) source package
named below, available from <https://launchpad.net/ubuntu/+source/> and from
the upstream project.

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
list does not leave to the host. The list below is expected from the plugins'
documented dependencies and is **unverified** until the lab compares the
bundled libraries of an AppImage built before and after the plugins. Licences
come from the jammy copyright file named for each.

| Library (binary package)                                                                                           | Needed by                            | Licence                                                         | Copyright file (jammy)                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `libmpg123.so.0` (`libmpg123-0`)                                                                                   | `libgstmpg123.so`                    | LGPL-2.1                                                        | <https://changelogs.ubuntu.com/changelogs/pool/main/m/mpg123/mpg123_1.29.3-1ubuntu0.1/copyright>              |
| `libFLAC.so.8` (`libflac8`)                                                                                        | `libgstflac.so`                      | BSD-3-Clause (`src/libFLAC/*`)                                  | <https://changelogs.ubuntu.com/changelogs/pool/main/f/flac/flac_1.3.3-2ubuntu0.2/copyright>                   |
| `libvorbis.so.0`, `libvorbisenc.so.2` (`libvorbis0a`, `libvorbisenc2`)                                             | `libgstvorbis.so`                    | BSD-3-Clause                                                    | <https://changelogs.ubuntu.com/changelogs/pool/main/libv/libvorbis/libvorbis_1.3.7-1build2/copyright>         |
| `libogg.so.0` (`libogg0`)                                                                                          | `libgstogg.so`, `libgstvorbis.so`    | BSD-3-Clause (upstream; jammy copyright file not checked)       | unverified                                                                                                    |
| `libopus.so.0` (`libopus0`)                                                                                        | `libgstopus.so`                      | BSD-style ("Redistribution and use in source and binary forms") | <https://changelogs.ubuntu.com/changelogs/pool/main/o/opus/opus_1.3.1-0.1build2/copyright>                    |
| `liborc-0.4.so.0` (`liborc-0.4-0`)                                                                                 | audio conversion, resampling, volume | BSD-style ("Redistribution and use in source and binary forms") | <https://changelogs.ubuntu.com/changelogs/pool/main/o/orc/orc_0.4.32-2ubuntu0.1/copyright>                    |
| `libpulse.so.0`, `libpulse-mainloop-glib.so.0`, `libpulsecommon-15.99.so` (`libpulse0`, `libpulse-mainloop-glib0`) | `libgstpulseaudio.so`                | LGPL-2.1+                                                       | <https://changelogs.ubuntu.com/changelogs/pool/main/p/pulseaudio/pulseaudio_15.99.1+dfsg1-1ubuntu1/copyright> |
| `libz.so.1` (`zlib1g`)                                                                                             | `libgstmatroska.so`                  | Zlib                                                            | <https://changelogs.ubuntu.com/changelogs/pool/main/z/zlib/zlib_1.2.11.dfsg-2ubuntu9.2/copyright>             |
| `libbz2.so.1.0` (`libbz2-1.0`)                                                                                     | `libgstmatroska.so`                  | BSD-variant                                                     | <https://changelogs.ubuntu.com/changelogs/pool/main/b/bzip2/bzip2_1.0.8-5ubuntu0.1/copyright>                 |
| `libasound.so.2` (`libasound2`)                                                                                    | `libgstalsa.so`                      | LGPL-2.1+                                                       | <https://changelogs.ubuntu.com/changelogs/pool/main/a/alsa-lib/alsa-lib_1.2.6.1-1ubuntu1.2/copyright>         |

`libpulse0` itself depends on further libraries (for example `libsndfile1`,
`libasyncns0`, `libapparmor1`, `libwrap0`); whichever of them linuxdeploy bundles
must be added here from the lab's diff. `libmp3lame` (LAME) must not appear: its
only consumer, the `lame` encoder plugin, is not bundled, and its jammy
copyright file lists a GPL file (`libmp3lame/fft.c`).

## Not yet recorded

The AppImage already bundled WebKitGTK, GTK, GLib, the GStreamer core and base
libraries, and their dependencies before these plugins were added, and no
notice records them. That gap predates this file and remains open.
