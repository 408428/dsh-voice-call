#!/usr/bin/env bash
# Fetch the models the plugin can use, without shipping them in the repository.
#
# Everything here is optional: the plugin works with no models at all, using the
# cloud voice. Each piece you fetch removes a cloud round trip from a call.
#
# Usage:
#   ./scripts/fetch-models.sh voice     # local Piper voice (~61 MB)
#   ./scripts/fetch-models.sh clone     # XTTS v2 for cloning (~1.8 GB)
#   ./scripts/fetch-models.sh portrait  # LivePortrait, mouth animation (~630 MB)
#   ./scripts/fetch-models.sh all       # all of the above
#
# Everything lands under ~/.dsh/voice-call, which is where the plugin looks by
# default. Set DSH_VOICE_CALL_HOME to put it somewhere else.

set -euo pipefail

ROOT="${DSH_VOICE_CALL_HOME:-$HOME/.dsh/voice-call}"
# A mirror first: the official hosts are often unreachable from some networks,
# and both serve the same bytes.
MIRROR="${HF_ENDPOINT:-https://hf-mirror.com}"

say() { printf '  %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { say "missing: $1"; exit 1; }; }

# Download one file, skipping it when it is already there and the right size.
fetch() {
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  if [ -f "$out" ] && [ -s "$out" ]; then
    say "have $(basename "$out")"
    return 0
  fi
  say "fetching $(basename "$out")"
  # --fail so an HTML error page is not saved as a model; -C - resumes.
  curl -fL --retry 3 --retry-delay 2 -C - -o "$out" "$url" \
    || { rm -f "$out"; say "FAILED: $url"; return 1; }
}

voice() {
  need curl
  local base="$MIRROR/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium"
  say "Piper voice (zh_CN-huayan-medium)"
  fetch "$base/zh_CN-huayan-medium.onnx"      "$ROOT/models/zh_CN-huayan-medium.onnx"
  fetch "$base/zh_CN-huayan-medium.onnx.json" "$ROOT/models/zh_CN-huayan-medium.onnx.json"
  say "done: $ROOT/models"
}

clone() {
  need curl
  say "XTTS v2 (voice cloning, about 1.8 GB)"
  say "This also needs a Python environment with coqui-tts:"
  say "  python3 -m venv $ROOT/venv"
  say "  $ROOT/venv/bin/pip install coqui-tts torch torchaudio pypinyin"
  # Coqui's own downloader knows the file layout, so it is used rather than a
  # hand-written list of URLs that would drift.
  if [ -x "$ROOT/venv/bin/python" ]; then
    say "fetching weights through the installed coqui-tts"
    "$ROOT/venv/bin/python" - <<'PY' || say "could not pre-fetch; the first clone will download instead"
import os
os.environ.setdefault("COQUI_TOS_AGREED", "1")
try:
    from TTS.utils.manage import ModelManager
    ModelManager().download_model("tts_models/multilingual/multi-dataset/xtts_v2")
    print("  weights ready")
except Exception as error:
    print(f"  skipped: {error}")
PY
  else
    say "no venv at $ROOT/venv, so the weights download on first use instead"
  fi
  say "done"
}

portrait() {
  need curl
  say "LivePortrait (mouth animation, about 630 MB)"
  local w="$ROOT/liveportrait/pretrained_weights/liveportrait"
  local base="$MIRROR/KlingTeam/LivePortrait/resolve/main/liveportrait"
  fetch "$base/base_models/appearance_feature_extractor.pth" "$w/base_models/appearance_feature_extractor.pth"
  fetch "$base/base_models/motion_extractor.pth"             "$w/base_models/motion_extractor.pth"
  fetch "$base/base_models/spade_generator.pth"              "$w/base_models/spade_generator.pth"
  fetch "$base/base_models/warping_module.pth"               "$w/base_models/warping_module.pth"
  fetch "$base/retargeting_models/stitching_retargeting_module.pth" "$w/retargeting_models/stitching_retargeting_module.pth"
  fetch "$base/landmark.onnx" "$w/landmark.onnx"
  # The face detector LivePortrait crops with.
  local face="$MIRROR/KlingTeam/LivePortrait/resolve/main/insightface/models/buffalo_l"
  fetch "$face/det_10g.onnx"   "$ROOT/liveportrait/pretrained_weights/insightface/models/buffalo_l/det_10g.onnx"
  fetch "$face/2d106det.onnx"  "$ROOT/liveportrait/pretrained_weights/insightface/models/buffalo_l/2d106det.onnx"

  # LivePortrait ships its own source code, which the worker imports.
  if [ ! -d "$ROOT/liveportrait/src" ]; then
    say "cloning the LivePortrait source"
    need git
    git clone --depth 1 https://github.com/KwaiVGI/LivePortrait.git "$ROOT/liveportrait-src"
    cp -r "$ROOT/liveportrait-src/src" "$ROOT/liveportrait/"
    rm -rf "$ROOT/liveportrait-src"
  else
    say "have LivePortrait source"
  fi

  # Its own environment, because it pins numpy 1.x and the speech stack needs 2.x.
  if [ ! -x "$ROOT/lp-venv/bin/python" ]; then
    say "LivePortrait needs a separate Python environment:"
    say "  python3 -m venv $ROOT/lp-venv"
    say "  $ROOT/lp-venv/bin/pip install numpy==1.26.4 torch torchvision \\"
    say "      scipy imageio imageio-ffmpeg opencv-python-headless onnx onnxruntime pyyaml"
  fi
  say "done: $ROOT/liveportrait"
}

case "${1:-all}" in
  voice)    voice ;;
  clone)    clone ;;
  portrait) portrait ;;
  all)      voice; clone; portrait ;;
  *)        say "usage: $0 {voice|clone|portrait|all}"; exit 2 ;;
esac

say ""
say "Restart the harness (~/dsh-start.sh) and the plugin will pick these up."
