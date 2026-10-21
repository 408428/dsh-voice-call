#!/usr/bin/env bash
# Fetch the models the plugin can use, without shipping them in the repository.
#
# Everything here is optional: the plugin works with no models at all, using the
# cloud voice. Each piece you fetch removes a cloud round trip from a call.
#
# Usage:
#   ./scripts/fetch-models.sh voice     # local Piper voice (~56 MB)
#   ./scripts/fetch-models.sh portrait  # LivePortrait, mouth animation (~583 MB)
#   ./scripts/fetch-models.sh clone     # XTTS v2 for cloning (~1.8 GB)
#   ./scripts/fetch-models.sh all       # all of the above
#   ./scripts/fetch-models.sh status    # what is present, what is missing
#
# The voice and portrait weights come from this project's GitHub release, which
# is a CDN rather than a rate-limited host. If that download fails the script
# falls back to the upstream sources, so it works even with the release
# unreachable.
#
# Everything lands under ~/.dsh/voice-call, which is where the plugin looks by
# default. Set DSH_VOICE_CALL_HOME to put it somewhere else.

set -euo pipefail

ROOT="${DSH_VOICE_CALL_HOME:-${DSH_HOME:-$HOME/.dsh}/voice-call}"
RELEASE="${RELEASE_BASE:-https://github.com/408428/dsh-voice-call/releases/download/v0.3.0}"
# Upstream mirrors, used only when the release is unreachable. hf-mirror is the
# default because the official hosts are blocked from some networks.
MIRROR="${HF_ENDPOINT:-https://hf-mirror.com}"

# The expected archive hashes, so a truncated or substituted download is caught
# rather than extracted into a broken model.
SHA_PIPER='d2e0d7cbfca6918dbe484e34e0b2e19f736d902e3cd5d135110c0aeddf657754'
SHA_PORTRAIT='d0a6fd4112ef9431e9b653f486982bcf16e959cbdf30b0af61c0268adeca5e8d'

say() { printf '  %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { say "missing: $1"; exit 1; }; }
have() { [ -f "$1" ] && [ -s "$1" ]; }

# Download one file. Returns non-zero on failure so callers can fall back.
fetch() {
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  if have "$out"; then say "have $(basename "$out")"; return 0; fi
  say "fetching $(basename "$out")"
  # --fail so an HTML error page is not saved as a model; -C - resumes.
  if curl -fL --retry 3 --retry-delay 2 -C - -o "$out" "$url" 2>/dev/null && have "$out"; then
    return 0
  fi
  rm -f "$out"
  return 1
}

# Download an archive, check its hash, and extract it.
#
# The hash is checked before extraction on purpose: a half-written archive would
# otherwise unpack into a model the engine loads and then fails on, which looks
# like a plugin bug rather than a download problem.
fetch_archive() {
  local url="$1" out="$2" want="$3" dest="$4" strip="${5:-0}"
  mkdir -p "$dest"
  local got=''
  if have "$out"; then got=$(sha256sum "$out" | cut -d' ' -f1); fi
  if [ "$got" != "$want" ]; then
    have "$out" && say "checksum mismatch, re-downloading"
    fetch "$url" "$out" || return 1
    got=$(sha256sum "$out" | cut -d' ' -f1)
  fi
  if [ "$got" != "$want" ]; then
    say "checksum is wrong even after a fresh download; refusing to unpack"
    rm -f "$out"
    return 1
  fi
  say "unpacking into $dest"
  tar -xzf "$out" -C "$dest" --strip-components="$strip"
}

voice() {
  need curl; need tar
  say "Piper voice (zh_CN-huayan-medium, ~56 MB)"
  local dest="$ROOT/models" tmp="$ROOT/.downloads"
  if fetch_archive "$RELEASE/piper-zh_CN-huayan-medium.tar.gz" "$tmp/piper.tar.gz" "$SHA_PIPER" "$dest" 1; then
    say "done: $dest"
    return 0
  fi
  say "the release was unreachable; trying the upstream host"
  local base="$MIRROR/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium"
  fetch "$base/zh_CN-huayan-medium.onnx"      "$dest/zh_CN-huayan-medium.onnx" || return 1
  fetch "$base/zh_CN-huayan-medium.onnx.json" "$dest/zh_CN-huayan-medium.onnx.json" || return 1
  say "done: $dest"
}

portrait() {
  need curl; need tar
  say "LivePortrait (mouth animation, ~583 MB)"
  local dest="$ROOT/liveportrait/pretrained_weights" tmp="$ROOT/.downloads"
  if fetch_archive "$RELEASE/liveportrait-weights.tar.gz" "$tmp/liveportrait.tar.gz" "$SHA_PORTRAIT" "$dest" 0; then
    say "weights ready"
  else
    say "the release was unreachable; trying the upstream host"
    local w="$dest/liveportrait" base="$MIRROR/KlingTeam/LivePortrait/resolve/main/liveportrait"
    fetch "$base/base_models/appearance_feature_extractor.pth" "$w/base_models/appearance_feature_extractor.pth" || return 1
    fetch "$base/base_models/motion_extractor.pth"             "$w/base_models/motion_extractor.pth" || return 1
    fetch "$base/base_models/spade_generator.pth"              "$w/base_models/spade_generator.pth" || return 1
    fetch "$base/base_models/warping_module.pth"               "$w/base_models/warping_module.pth" || return 1
    fetch "$base/retargeting_models/stitching_retargeting_module.pth" "$w/retargeting_models/stitching_retargeting_module.pth" || return 1
    fetch "$base/landmark.onnx" "$w/landmark.onnx" || return 1
    local face="$MIRROR/KlingTeam/LivePortrait/resolve/main/insightface/models/buffalo_l"
    fetch "$face/det_10g.onnx"  "$dest/insightface/models/buffalo_l/det_10g.onnx" || return 1
    fetch "$face/2d106det.onnx" "$dest/insightface/models/buffalo_l/2d106det.onnx" || return 1
  fi

  # LivePortrait ships its own source, which the worker imports. It is not a
  # model, so it is cloned rather than attached to the release.
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
    say ""
    say "LivePortrait still needs its own Python environment:"
    say "  python3 -m venv $ROOT/lp-venv"
    say "  $ROOT/lp-venv/bin/pip install numpy==1.26.4 torch torchvision \\"
    say "      scipy imageio imageio-ffmpeg opencv-python-headless onnx onnxruntime pyyaml"
  fi
  say "done: $ROOT/liveportrait"
}

clone() {
  need curl
  say "XTTS v2 (voice cloning, about 1.8 GB)"
  # The weights live inside the Python environment and are fetched by coqui's own
  # downloader, so there is nothing to attach to the release. The environment has
  # to exist first.
  if [ ! -x "$ROOT/venv/bin/python" ]; then
    say "XTTS needs a Python environment first:"
    say "  python3 -m venv $ROOT/venv"
    say "  $ROOT/venv/bin/pip install coqui-tts torch torchaudio pypinyin"
    say ""
    say "the weights download on first use once that exists"
    return 0
  fi
  say "fetching weights through the installed coqui-tts"
  COQUI_TOS_AGREED=1 "$ROOT/venv/bin/python" - <<'PY' || say "could not pre-fetch; the first clone will download instead"
import os
os.environ.setdefault("COQUI_TOS_AGREED", "1")
try:
    from TTS.utils.manage import ModelManager
    ModelManager().download_model("tts_models/multilingual/multi-dataset/xtts_v2")
    print("  weights ready")
except Exception as error:
    print(f"  skipped: {error}")
PY
  say "done"
}

status() {
  say "voice-call models under $ROOT"
  local v='missing'; [ -n "$(ls "$ROOT/models"/*.onnx 2>/dev/null)" ] && v='present'
  say "  voice      $v"
  local p='missing'
  have "$ROOT/liveportrait/pretrained_weights/liveportrait/base_models/spade_generator.pth" && p='present'
  say "  portrait   $p"
  local s='missing'; [ -d "$ROOT/liveportrait/src" ] && s='present'
  say "  lp source  $s"
  local e='missing'; [ -x "$ROOT/venv/bin/python" ] && e='present'
  say "  speech env $e"
  local le='missing'; [ -x "$ROOT/lp-venv/bin/python" ] && le='present'
  say "  lp env     $le"
  say ""
  say "speech recognition needs nothing: the plugin uses the Harness's own service"
}

case "${1:-all}" in
  voice)    voice ;;
  clone)    clone ;;
  portrait) portrait ;;
  status)   status ;;
  all)      voice; clone; portrait; status ;;
  *)        say "usage: $0 {voice|portrait|clone|all|status}"; exit 2 ;;
esac

say ""
say "Restart the harness (~/dsh-start.sh) and the plugin will pick these up."