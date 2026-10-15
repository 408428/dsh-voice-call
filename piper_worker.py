"""Persistent local text-to-speech worker for the voice-call plugin.

Loading a Piper voice costs about a second; synthesizing one sentence costs
about eighty milliseconds. The voice therefore stays resident and this process
serves many utterances instead of paying the load cost per request.

The protocol is one JSON object per line on stdin and one per line on stdout,
so the Host half can hold one long-lived child and match replies by id.

Request:  {"id": "<opaque>", "text": "<utf8 text>", "speaker": 0, "rate": 1.0}
Reply:    {"id": "<opaque>", "wav": "<base64 PCM16 WAV>"}
          {"id": "<opaque>", "error": "<message>"}

`rate` is a speaking-rate multiplier: 1.0 is the voice's own pace, below 1.0 is
slower and above is faster. Piper calls this `length_scale` and defines it
inversely, so the multiplier is inverted on the way in.

@module voice-call/piper_worker
"""

import base64
import io
import json
import sys
import wave


def emit(payload):
    """Write one protocol line and flush it, so the parent never waits on a buffer."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"id": None, "error": "usage: piper_worker.py <model.onnx> [config.json]"})
        return 2
    model = sys.argv[1]
    config = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        from piper import PiperVoice, SynthesisConfig

        voice = PiperVoice.load(model, config_path=config)
    except Exception as error:  # noqa: BLE001 - the parent needs the reason verbatim
        emit({"id": None, "error": f"voice load failed: {error}"})
        return 1

    # Readiness line: the parent waits for this before sending the first request.
    emit({"id": None, "ready": True, "sampleRate": voice.config.sample_rate})

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
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as stream:
                # A speaker id selects a multi-speaker voice's timbre; single
                # speaker models ignore it, so it is only passed when present.
                speaker = request.get("speaker")
                rate = float(request.get("rate") or 1.0)
                # Piper's length_scale is the inverse of a rate multiplier: a
                # larger scale stretches each phoneme, which sounds slower.
                config = SynthesisConfig(length_scale=1.0 / rate) if rate > 0 and rate != 1.0 else None
                if speaker is None:
                    voice.synthesize_wav(text, stream, syn_config=config)
                else:
                    voice.synthesize_wav(text, stream, syn_config=config, speaker_id=int(speaker))
            emit({"id": request_id, "wav": base64.b64encode(buffer.getvalue()).decode("ascii")})
        except Exception as error:  # noqa: BLE001 - one bad utterance must not kill the worker
            emit({"id": request_id, "error": f"synthesis failed: {error}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
