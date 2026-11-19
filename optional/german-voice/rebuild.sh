#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Deutsch Daily Deck contributors
# Build only in a dedicated working directory; no system packages are installed.
set -euo pipefail
voice_build_root="${1:?Usage: rebuild.sh /absolute/dedicated/build-directory}"
case "$voice_build_root" in /*) ;; *) echo 'Use an absolute build directory.' >&2; exit 1;; esac
voice_component_root="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$voice_build_root/sources" "$voice_build_root/artifacts"
checkout() {
 local name="$1" remote="$2" revision="$3"
 if [ ! -f "$voice_build_root/sources/$name/CMakeLists.txt" ]; then
  git clone "$remote" "$voice_build_root/sources/$name"
  git -C "$voice_build_root/sources/$name" checkout "$revision"
 fi
 if [ -d "$voice_build_root/sources/$name/.git" ] && [ "$(git -C "$voice_build_root/sources/$name" rev-parse HEAD)" != "$revision" ]; then
  echo "Unexpected $name revision; use a fresh build directory." >&2; exit 1
 fi
}
checkout espeak-ng https://github.com/rhasspy/espeak-ng.git 0f65aa301e0d6bae5e172cc74197d32a6182200f
checkout piper-phonemize https://github.com/wide-video/piper-phonemize.git cfff8e52ebaea37c7e953ae2d06b174acb827ac4
if [ ! -d "$voice_build_root/emsdk/.git" ]; then
 git clone https://github.com/emscripten-core/emsdk.git "$voice_build_root/emsdk"
 git -C "$voice_build_root/emsdk" checkout 708dcbcc9ee23bc7d2dad44fc90db377e38b771c
fi
"$voice_build_root/emsdk/emsdk" install 3.1.47
"$voice_build_root/emsdk/emsdk" activate 3.1.47 --embedded
# shellcheck source=/dev/null
source "$voice_build_root/emsdk/emsdk_env.sh"
if ! grep -q '__EMSCRIPTEN__' "$voice_build_root/sources/espeak-ng/src/include/compat/wctype.h"; then
 git -C "$voice_build_root/sources/espeak-ng" apply "$voice_component_root/patches/emscripten-wctype.patch"
fi
cmake -S "$voice_build_root/sources/espeak-ng" -B "$voice_build_root/espeak-native" \
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF \
 -DUSE_ASYNC=OFF -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF -DUSE_KLATT=OFF -DUSE_SPEECHPLAYER=OFF
cmake --build "$voice_build_root/espeak-native" -j 4
emcmake cmake -S "$voice_build_root/sources/espeak-ng" -B "$voice_build_root/espeak-wasm" \
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBUILD_SHARED_LIBS=OFF \
 -DUSE_ASYNC=OFF -DUSE_MBROLA=OFF -DUSE_LIBSONIC=OFF -DUSE_LIBPCAUDIO=OFF -DUSE_KLATT=OFF -DUSE_SPEECHPLAYER=OFF
cmake --build "$voice_build_root/espeak-wasm" --target espeak-ng -j 4
python3 - "$voice_build_root" <<'PY'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1]); source = root/'espeak-native/espeak-ng-data'; target = root/'german-data'; target.mkdir(exist_ok=True)
for item in source.iterdir():
    if item.name.endswith('_dict') and item.name not in ('de_dict','en_dict'): continue
    if item.is_dir(): shutil.copytree(item, target/item.name, dirs_exist_ok=True)
    else: shutil.copy2(item, target/item.name)
PY
voice_piper="$voice_build_root/sources/piper-phonemize/src"
em++ -O3 -std=c++17 "$voice_piper/main.cpp" "$voice_piper/phonemize.cpp" "$voice_piper/phoneme_ids.cpp" "$voice_piper/shared.cpp" \
 -I"$voice_build_root/sources/espeak-ng/src/include" \
 "$voice_build_root/espeak-wasm/src/libespeak-ng/libespeak-ng.a" "$voice_build_root/espeak-wasm/src/ucd-tools/libucd.a" \
 -s ALLOW_MEMORY_GROWTH=1 -s INVOKE_RUN=0 -s MODULARIZE=1 -s EXPORT_NAME=createPiperPhonemize \
 -s EXPORTED_FUNCTIONS='["_main"]' -s EXPORTED_RUNTIME_METHODS='["callMain","FS"]' -s ENVIRONMENT=worker,node \
 --preload-file "$voice_build_root/german-data@/espeak-ng-data" -o "$voice_build_root/artifacts/phonemizer.js"
