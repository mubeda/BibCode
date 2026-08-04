#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
upstream_plugin="$script_directory/bibcode-linuxdeploy-gtk-upstream.sh"

if [[ ! -x "$upstream_plugin" ]]; then
  printf 'BiBCode AppImage packaging error: upstream GTK plugin is not executable: %s\n' \
    "$upstream_plugin" >&2
  exit 1
fi

appdir=""
appdir_seen=false
arguments=("$@")
upstream_arguments=()
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  case "${arguments[index]}" in
    --appdir)
      upstream_arguments+=("--appdir")
      appdir_seen=true
      if ((index + 1 >= ${#arguments[@]})); then
        printf 'BiBCode AppImage packaging error: --appdir requires a path.\n' >&2
        exit 1
      fi
      appdir="${arguments[index + 1]}"
      upstream_arguments+=("$appdir")
      index=$((index + 1))
      ;;
    --appdir=*)
      appdir_seen=true
      appdir="${arguments[index]#--appdir=}"
      upstream_arguments+=("--appdir" "$appdir")
      ;;
    *)
      upstream_arguments+=("${arguments[index]}")
      ;;
  esac
done

"$upstream_plugin" "${upstream_arguments[@]}"

if [[ "$appdir_seen" == false ]]; then
  exit 0
fi
if [[ -z "$appdir" || ! -d "$appdir" ]]; then
  printf 'BiBCode AppImage packaging error: invalid AppDir: %s\n' "$appdir" >&2
  exit 1
fi

shopt -s nullglob
library_roots=("$appdir"/usr/lib*)
if ((${#library_roots[@]} == 0)); then
  exit 0
fi

find "${library_roots[@]}" \
  \( -type f -o -type l \) \
  -name 'libwayland-client.so*' \
  -delete

remaining_library="$(
  find "${library_roots[@]}" \
    \( -type f -o -type l \) \
    -name 'libwayland-client.so*' \
    -print -quit
)"
if [[ -n "$remaining_library" ]]; then
  printf 'BiBCode AppImage packaging error: failed to remove bundled Wayland client: %s\n' \
    "$remaining_library" >&2
  exit 1
fi
