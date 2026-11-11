#!/usr/bin/env bash
set -euo pipefail

# The only GStreamer plugins the AppImage carries: WebKitGTK's audio pipeline plus the decoders
# for the audio types Files previews (apps/web/src/components/files/filePreviewMode.ts: mp3, m4a,
# wav, ogg, oga, webm, flac). Each must come from GStreamer core, base or good (LGPL).
# m4a is not covered: its AAC decoders are in plugins-bad or libav only.
# BEGIN BIBCODE GSTREAMER PLUGINS
allowed_plugins=(
  libgstcoreelements.so      # core: typefind, queue, fakesink; WebKit's fallback video sink for <audio>
  libgstplayback.so          # base: playbin3, decodebin3 and parsebin, which WebKit uses for blob: URLs
  libgsttypefindfunctions.so # base: detects the container and codec of each file
  libgstapp.so               # base: appsrc and appsink, which WebKit's sources and sinks build on
  libgstaudioconvert.so      # base: sample-format conversion before the sink
  libgstaudioresample.so     # base: sample-rate conversion before the sink
  libgstvolume.so            # base: volume and mute on the <audio> element
  libgstogg.so               # base: Ogg demuxer for ogg and oga
  libgstvorbis.so            # base: Vorbis decoder for ogg, oga and webm
  libgstopus.so              # base: Opus decoder for ogg, oga and webm
  libgstalsa.so              # base (gstreamer1.0-alsa): ALSA sink, used when no sound server runs
  libgstautodetect.so        # good: autoaudiosink, which WebKit uses to pick the sink
  libgstpulseaudio.so        # good: PulseAudio sink, also served by PipeWire's pulse server
  libgstaudiofx.so           # good: scaletempo, which WebKit inserts to preserve pitch at other rates
  libgstwavparse.so          # good: WAV demuxer
  libgstaudioparsers.so      # good: MP3 and FLAC parsers that decodebin3 needs before decoding
  libgstid3demux.so          # good: strips ID3 tags so tagged MP3 files reach the parser
  libgstmpg123.so            # good: MP3 decoder (libmpg123, LGPL-2.1)
  libgstflac.so              # good: FLAC decoder (libFLAC, BSD-3-Clause)
  libgstmatroska.so          # good: WebM demuxer
)
# END BIBCODE GSTREAMER PLUGINS

if [[ "${1:-}" == "--list-plugins" ]]; then
  printf '%s\n' "${allowed_plugins[@]}"
  exit 0
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
upstream_plugin="$script_directory/bibcode-linuxdeploy-gstreamer-upstream.sh"

if [[ ! -x "$upstream_plugin" ]]; then
  printf 'BiBCode AppImage packaging error: upstream GStreamer plugin is not executable: %s\n' \
    "$upstream_plugin" >&2
  exit 1
fi

appdir=""
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  if [[ "${arguments[index]}" == "--appdir" && $((index + 1)) -lt ${#arguments[@]} ]]; then
    appdir="${arguments[index + 1]}"
  fi
done

if [[ -z "$appdir" ]]; then
  exec "$upstream_plugin" "$@"
fi

# The upstream plugin copies every file in GSTREAMER_PLUGINS_DIR. Give it a private folder with
# only the allowlisted plugins, each verified as packaged by GStreamer core, base or good, so the
# bundle does not depend on what else the build host has installed.
if [[ -n "${GSTREAMER_PLUGINS_DIR:-}" ]]; then
  host_plugins_directory="$GSTREAMER_PLUGINS_DIR"
elif [[ -d "/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0" ]]; then
  host_plugins_directory="/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0"
else
  host_plugins_directory="/usr/lib/gstreamer-1.0"
fi

staging_directory="$(mktemp -d "${TMPDIR:-/tmp}/bibcode-gstreamer-plugins.XXXXXX")"
trap 'rm -rf "$staging_directory"' EXIT

problems=()
for plugin in "${allowed_plugins[@]}"; do
  path="$host_plugins_directory/$plugin"
  if [[ ! -f "$path" ]]; then
    problems+=("$plugin: missing from $host_plugins_directory")
    continue
  fi
  # dpkg-query -S takes a glob; escape it so only this exact path can match.
  pattern="$(printf '%s' "$path" | sed 's/[][*?\\]/\\&/g')"
  owners="$(dpkg-query -S "$pattern" 2>/dev/null)" || owners=""
  if [[ -z "$owners" || "$owners" == *$'\n'* || "${owners#*: }" != "$path" ]]; then
    problems+=("$plugin: not owned by exactly one package (${owners:-no owner})")
    continue
  fi
  package="${owners%%: /*}"
  if [[ "$package" == *,* ]]; then
    problems+=("$plugin: owned by more than one package ($package)")
    continue
  fi
  source_package="$(dpkg-query -W -f='${source:Package}' "$package" 2>/dev/null)" || source_package=""
  case "$source_package" in
    gstreamer1.0 | gst-plugins-base1.0 | gst-plugins-good1.0) ;;
    *)
      problems+=("$plugin: from source package '${source_package:-unknown}' ($package)")
      continue
      ;;
  esac
  cp "$path" "$staging_directory/$plugin"
done
if ((${#problems[@]} > 0)); then
  printf 'BiBCode AppImage packaging error: GStreamer plugins cannot be bundled. Install gstreamer1.0-plugins-base, gstreamer1.0-plugins-good and gstreamer1.0-alsa from the distribution; see docs/testing/linux-desktop.md:\n' >&2
  printf '  %s\n' "${problems[@]}" >&2
  exit 1
fi
export GSTREAMER_PLUGINS_DIR="$staging_directory"

"$upstream_plugin" "$@"

# The upstream plugin re-runs linuxdeploy, which deploys the Wayland client the GTK wrapper
# removed. Remove it again so the AppImage uses the host's.
shopt -s nullglob
library_roots=("$appdir"/usr/lib*)
if ((${#library_roots[@]} > 0)); then
  find "${library_roots[@]}" \( -type f -o -type l \) -name 'libwayland-client.so*' -delete
  remaining_library="$(
    find "${library_roots[@]}" \( -type f -o -type l \) -name 'libwayland-client.so*' -print -quit
  )"
  if [[ -n "$remaining_library" ]]; then
    printf 'BiBCode AppImage packaging error: failed to remove bundled Wayland client: %s\n' \
      "$remaining_library" >&2
    exit 1
  fi
fi

for required in \
  "$appdir/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" \
  "$appdir/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"; do
  if [[ ! -f "$required" ]]; then
    printf 'BiBCode AppImage packaging error: the GStreamer plugin did not produce %s\n' \
      "$required" >&2
    exit 1
  fi
done

bundled="$(cd "$appdir/usr/lib/gstreamer-1.0" && ls -1 | LC_ALL=C sort)"
expected="$(printf '%s\n' "${allowed_plugins[@]}" | LC_ALL=C sort)"
if [[ "$bundled" != "$expected" ]]; then
  printf 'BiBCode AppImage packaging error: the bundled GStreamer plugins differ from the allowlist:\n%s\n' \
    "$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$bundled") || true)" >&2
  exit 1
fi
