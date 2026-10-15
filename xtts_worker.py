"""Persistent local voice-cloning worker (Coqui XTTS v2) for the voice-call plugin.

XTTS clones a voice from a short reference recording, which is what makes an
uploaded sample usable as a call's voice. It is far heavier than Piper: loading
the model takes about 70 seconds and about 1.8 GB of weights, while synthesizing
one sentence then costs 0.4-1.4 seconds. That load cost is the whole reason this
is a resident worker rather than a one-shot script -- paying 70 seconds per
sentence would make a call unusable.

The protocol matches `piper_worker.py` so the Host half can drive either engine
with one code path:

Request:  {"id": "<opaque>", "text": "<utf8 text>", "speaker_wav": "<path>", "rate": 1.0, "language": "zh"}
Reply:    {"id": "<opaque>", "wav": "<base64 PCM16 WAV>"}
          {"id": "<opaque>", "error": "<message>"}

The reference recording is fixed at startup (`sys.argv[2]`), because a call uses
one voice for its whole length and re-reading the sample per sentence would only
add work. `rate` is a speaking-rate multiplier passed to XTTS as `speed`.

@module voice-call/xtts_worker
"""

import base64
import io
import json
import os
import sys
import wave

# XTTS ships under the Coqui Public Model License and prompts for agreement on
# first download. The model is already on disk here, and a worker has no console
# to answer a prompt, so agreement is recorded through the environment. Set
# before importing TTS, which reads it during model resolution.
os.environ.setdefault("COQUI_TOS_AGREED", "1")
# This machine reaches Hugging Face through a mirror; the library builds its
# download URLs from the host name, so the endpoint variable is what redirects
# a first-run fetch.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"


def emit(payload):
    """Write one protocol line and flush it, so the parent never waits on a buffer."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        emit({"id": None, "error": "usage: xtts_worker.py <speaker_wav> [language]"})
        return 2
    speaker_wav = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "zh"
    if not os.path.exists(speaker_wav):
        emit({"id": None, "error": f"reference audio not found: {speaker_wav}"})
        return 1

    try:
        from TTS.api import TTS

        # A GPU is a large win here and XTTS runs on CPU only as a fallback.
        device = "cuda" if _cuda_available() else "cpu"
        model = TTS(MODEL_NAME).to(device)
    except Exception as error:  # noqa: BLE001 - the parent needs the reason verbatim
        emit({"id": None, "error": f"clone model load failed: {error}"})
        return 1

    # Readiness line: the parent waits for this before sending the first request.
    emit({"id": None, "ready": True, "device": device, "sampleRate": 24000})

    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"id": None, "error": f"invalid request JSON: {error}"})
            continue

        request_id = request.get("id")
        text = request.get("text") or ""
        if text.strip() == "":
            emit({"id": request_id, "error": "empty text"})
            continue

        try:
            rate = float(request.get("rate") or 1.0)
            # XTTS takes any path-like target, and an in-memory buffer keeps the
            # whole exchange inside this process: the reply is one base64 JSON
            # line, so no temp file has to be named or cleaned up.
            buffer = io.BytesIO()
            model.tts_to_file(
                text=text,
                speaker_wav=request.get("speaker_wav") or speaker_wav,
                language=request.get("language") or language,
                file_path=buffer,
                speed=rate,
            )
            emit({"id": request_id, "wav": base64.b64encode(buffer.getvalue()).decode("ascii")})
        except Exception as error:  # noqa: BLE001 - one bad utterance must not kill the worker
            emit({"id": request_id, "error": f"clone synthesis failed: {error}"})

    return 0


def _cuda_available():
    """Report whether a CUDA device is usable, without failing the worker."""
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 - a CPU-only fallback is the point
        return False


if __name__ == "__main__":
    sys.exit(main())
