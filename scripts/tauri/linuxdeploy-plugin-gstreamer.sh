#!/usr/bin/env bash
set -euo pipefail

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

# The upstream plugin copies every file in the host plugin folder. Resolve that folder the
# way it does and allow only GStreamer core, base and good (LGPL), so a host with the bad,
# ugly or libav sets installed fails here instead of shipping them.
if [[ -n "${GSTREAMER_PLUGINS_DIR:-}" ]]; then
  plugins_directory="$GSTREAMER_PLUGINS_DIR"
elif [[ -d "/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0" ]]; then
  plugins_directory="/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0"
else
  plugins_directory="/usr/lib/gstreamer-1.0"
fi
if [[ ! -d "$plugins_directory" ]]; then
  printf 'BiBCode AppImage packaging error: no GStreamer plugin folder: %s. Install the Linux build packages; see docs/testing/linux-desktop.md.\n' \
    "$plugins_directory" >&2
  exit 1
fi
export GSTREAMER_PLUGINS_DIR="$plugins_directory"

rejected=()
plugin_count=0
for plugin in "$plugins_directory"/*; do
  [[ -f "$plugin" ]] || continue
  plugin_count=$((plugin_count + 1))
  owners="$(dpkg-query -S "$plugin" 2>/dev/null)" || owners=""
  owners="${owners%%: /*}"
  allowed=false
  if [[ -n "$owners" ]]; then
    allowed=true
    IFS=', ' read -r -a packages <<<"$owners"
    for package in "${packages[@]}"; do
      source_package="$(dpkg-query -W -f='${source:Package}' "$package" 2>/dev/null)" || source_package=""
      case "$source_package" in
        gstreamer1.0 | gst-plugins-base1.0 | gst-plugins-good1.0) ;;
        *) allowed=false ;;
      esac
    done
  fi
  if [[ "$allowed" == false ]]; then
    rejected+=("$plugin (${owners:-not owned by a package})")
  fi
done
if ((plugin_count == 0)); then
  printf 'BiBCode AppImage packaging error: the GStreamer plugin folder is empty: %s\n' \
    "$plugins_directory" >&2
  exit 1
fi
if ((${#rejected[@]} > 0)); then
  printf 'BiBCode AppImage packaging error: the build host has GStreamer plugins outside the core, base and good sets. Uninstall their packages (for example gstreamer1.0-plugins-bad, -ugly or gstreamer1.0-libav) and build again:\n' >&2
  printf '  %s\n' "${rejected[@]}" >&2
  exit 1
fi

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
