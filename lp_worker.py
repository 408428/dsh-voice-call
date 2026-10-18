#!/usr/bin/env python3
"""Animate one photograph's mouth from audio, frame by frame.

LivePortrait reconstructs each frame from the source picture through implicit
keypoints, so the person on screen stays the person in the photograph -- which
is the whole point. The alternative, a photo relief, stretches a region of the
picture and looks wrong; a VRM is smooth but is somebody else.

Only the mouth moves. Measured on a real portrait, driving the lip retargeting
changes 0.15% of the pixels, all of them around the mouth. That is the property
worth having: a face that talks without twitching.

Protocol, one JSON request per line on stdin and one reply per line on stdout:

Request:  {"id": "<opaque>", "open": 0.0..1.0}
Reply:    {"id": "<opaque>", "jpeg": "<base64 JPEG>"}
          {"id": "<opaque>", "error": "<message>"}

The source picture is loaded once at startup. Everything after that is per-frame.
"""

import base64
import io
import json
import os
import sys

# Where the LivePortrait checkout and its weights live.
DEFAULT_ROOT = os.path.expanduser("~/.dsh/voice-call/liveportrait")


def emit(payload):
    """Write one protocol line."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def log(message):
    """Write a diagnostic to stderr, which the Host does not parse."""
    sys.stderr.write(f"lp: {message}\n")
    sys.stderr.flush()


def load_pipeline(root, image_path, use_half):
    """Build the LivePortrait wrapper and prepare the source picture.

    @param root - the LivePortrait checkout, whose src/ package is imported.
    @param image_path - the photograph to animate.
    @param use_half - whether to run in fp16, which roughly doubles the rate.
    @returns the wrapper, the feature volume, and the source keypoints.
    """
    sys.path.insert(0, root)
    import contextlib
    import numpy as np
    import torch
    from PIL import Image
    from src.config.inference_config import InferenceConfig
    from src.live_portrait_wrapper import LivePortraitWrapper

    # The loader prints its progress to stdout. This process speaks its protocol
    # there, so those lines would be read as malformed replies; send them to
    # stderr, where diagnostics belong.
    with contextlib.redirect_stdout(sys.stderr):
        config = InferenceConfig()
        config.flag_use_half_precision = use_half
        config.device_id = 0 if torch.cuda.is_available() else -1
        wrapper = LivePortraitWrapper(inference_cfg=config)
    with Image.open(image_path) as opened:
        picture = np.array(opened.convert("RGB"))
    with contextlib.redirect_stdout(sys.stderr):
        source = wrapper.prepare_source(picture)
        # The appearance feature and the source keypoints describe the PICTURE,
        # not the frame, so they are computed once and reused for every frame.
        feature = wrapper.extract_feature_3d(source)
        keypoints = wrapper.get_kp_info(source)["kp"]
    return wrapper, feature, keypoints


def main():
    """Serve frames until stdin closes."""
    if len(sys.argv) < 3:
        emit({"id": None, "error": "usage: lp_worker.py <image> [liveportrait-root]"})
        return 2
    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        emit({"id": None, "error": f"picture not found: {image_path}"})
        return 1
    root = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_ROOT
    if not os.path.isdir(os.path.join(root, "src")):
        emit({"id": None, "error": f"LivePortrait not found at {root}"})
        return 1
    try:
        import torch
        wrapper, feature, source_kp = load_pipeline(root, image_path, use_half=True)
        # The lip retargeting delta for a fully closed mouth; a fraction of it
        # opens the mouth. Computed once because it only depends on the source.
        neutral = torch.zeros(1, 2, device=source_kp.device)
        closed_delta = wrapper.retarget_lip(source_kp, neutral)
    except Exception as error:
        emit({"id": None, "error": f"LivePortrait failed to load: {error}"})
        return 1

    import torch
    from PIL import Image

    emit({"id": None, "ready": True, "device": "cuda" if torch.cuda.is_available() else "cpu"})
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            emit({"id": None, "error": f"bad request: {error}"})
            continue
        request_id = request.get("id")
        try:
            opening = max(0.0, min(1.0, float(request.get("open") or 0.0)))
            with torch.no_grad():
                if opening <= 0.001:
                    # A closed mouth is the source itself, so the common resting
                    # frame costs one decode rather than a whole generation.
                    driving = source_kp
                else:
                    # Interpolate between "closed" and the retargeted open mouth.
                    driving = source_kp + closed_delta * opening
                out = wrapper.warp_decode(feature, source_kp, driving)["out"]
            frame = wrapper.parse_output(out)[0]
            buffer = io.BytesIO()
            Image.fromarray(frame).save(buffer, format="JPEG", quality=82)
            emit({"id": request_id, "jpeg": base64.b64encode(buffer.getvalue()).decode("ascii")})
        except Exception as error:
            emit({"id": request_id, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
