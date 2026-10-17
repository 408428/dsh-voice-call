#!/usr/bin/env python3
"""Turn one photograph into a 3D relief mesh for the call screen.

The photograph itself becomes the surface: a depth model estimates how near
each pixel is, the pixels are pushed along that axis, and the result is a mesh
whose vertices carry their own colour. Nothing is invented, so the figure looks
like the person in the picture -- which is the point, and also the limit: this
is a relief, not a round reconstruction. Turning it sideways shows the back of
the plane, and the call keeps it within a modest angle for that reason.

Protocol, one JSON request per line on stdin and one reply per line on stdout:

Request:  {"id": "<opaque>", "image": "<path>", "grid": 160, "depth": 0.22}
Reply:    {"id": "<opaque>", "mesh": {...}}
          {"id": "<opaque>", "error": "<message>"}

The reply carries a square grid of vertices in row-major order: `position` is
XYZ, `color` is RGB as bytes, and `index` is the triangle list. Colours live on
the vertices rather than in a texture so the client needs no UV unwrapping and
no second download.
"""

import base64
import io
import json
import os
import sys

# The depth model and its preprocessor constants. Kept here rather than fetched,
# because a call must not depend on a network round trip.
MODEL_NAME = "depth-anything-v2-small.onnx"
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
# The model expects both sides to be a multiple of this.
MULTIPLE_OF = 14
# The long side the model is run at: bigger costs time and buys little, because
# the result is resampled onto the grid anyway.
LONG_SIDE = 518


def emit(payload):
    """Write one protocol line."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def log(message):
    """Write a diagnostic to stderr, which the Host does not parse."""
    sys.stderr.write(f"relief: {message}\n")
    sys.stderr.flush()


def load_session(path):
    """Open the depth model once, for every request this process serves."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # CPU is the deliberate choice: measured at 0.3-0.5 s per image here, which
    # is under the time the upload itself takes, and it leaves the GPU free for
    # the speech models that run during a call.
    return ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])


def estimate_depth(session, image):
    """Estimate a normalized depth map for one image.

    @param session - the ONNX session.
    @param image - a PIL image in RGB.
    @returns a float array in 0..1, larger meaning nearer.
    """
    import numpy as np
    from PIL import Image

    width, height = image.size
    scale = min(1.0, LONG_SIDE / max(width, height))
    grid_w = max(MULTIPLE_OF, int(round(width * scale / MULTIPLE_OF)) * MULTIPLE_OF)
    grid_h = max(MULTIPLE_OF, int(round(height * scale / MULTIPLE_OF)) * MULTIPLE_OF)
    small = image.resize((grid_w, grid_h), Image.BICUBIC)
    pixels = np.asarray(small, dtype=np.float32) / 255.0
    pixels = (pixels - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    tensor = pixels.transpose(2, 0, 1)[None].astype(np.float32)
    raw = np.asarray(session.run(None, {session.get_inputs()[0].name: tensor})[0]).squeeze()
    span = float(raw.max() - raw.min())
    if span <= 1e-6:
        # A flat image (a solid colour, a blank scan) has no relief to find.
        # Returning a flat map is honest; inventing one would be a fake face.
        return np.zeros_like(raw, dtype=np.float32)
    return ((raw - raw.min()) / span).astype(np.float32)


def find_face_from_depth(depth):
    """Locate the head using the depth map alone.

    A portrait is a near object against a far background, so the nearest blob is
    the subject. That is enough to place the mouth and the eyes, which drive the
    lip movement and the blink -- and unlike a face detector it costs nothing,
    needs no second model, and still gives a sensible answer for a picture that
    is not a face at all (the nearest part of whatever it is becomes the "face",
    which is the right guess for a picture of an object).

    @param depth - the normalized depth map, larger meaning nearer.
    @returns a dict of normalized boxes, or None when there is no structure.
    """
    import numpy as np

    span = float(depth.max() - depth.min())
    if span <= 1e-6:
        return None
    # The near half of the range, which separates a subject from its backdrop
    # without needing a threshold tuned per picture.
    near = depth >= (depth.min() + span * 0.55)
    rows = np.where(near.any(axis=1))[0]
    cols = np.where(near.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return None
    height, width = depth.shape
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])
    box_w = max(1, right - left)
    box_h = max(1, bottom - top)
    # The near blob spans head AND shoulders, so the head is the upper part of
    # it. These proportions come from the blob, not from the whole picture.
    head_top = top
    head_h = max(1, int(box_h * 0.62))
    face = [left / width, head_top / height, box_w / width, head_h / height]
    return {
        "face": face,
        "mouth": [(left + box_w * 0.30) / width, (head_top + head_h * 0.60) / height, (box_w * 0.40) / width, (head_h * 0.13) / height],
        "leftEye": [(left + box_w * 0.20) / width, (head_top + head_h * 0.34) / height, (box_w * 0.20) / width, (head_h * 0.10) / height],
        "rightEye": [(left + box_w * 0.58) / width, (head_top + head_h * 0.34) / height, (box_w * 0.20) / width, (head_h * 0.10) / height],
    }


def find_face(image):
    """Locate the face in one image, if a detector is available.

    Used only to place the mouth and the eyes, which drive the lip movement and
    the blink. When no face is found the client falls back to a centre-weighted
    guess, so a picture of an object still renders.

    @param image - a PIL image in RGB.
    @returns a dict of normalized boxes, or None.
    """
    try:
        import cv2
        import numpy as np
    except Exception:
        return None
    try:
        gray = np.asarray(image.convert("L"), dtype=np.uint8)
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            return None
        # The detector works on a modest width; a 4000-pixel photo would only be
        # slower without being more accurate.
        scale = min(1.0, 640 / max(image.size))
        if scale < 1.0:
            small = cv2.resize(gray, (int(gray.shape[1] * scale), int(gray.shape[0] * scale)))
        else:
            small = gray
        faces = cascade.detectMultiScale(small, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
        if len(faces) == 0:
            return None
        # The largest box is the subject, not a face in the background.
        x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
        height, width = small.shape
        # The mouth sits in the lower third of a face box and the eyes near the
        # upper third. These are proportions of the box, not of the image.
        return {
            "face": [x / width, y / height, w / width, h / height],
            "mouth": [(x + w * 0.28) / width, (y + h * 0.66) / height, (w * 0.44) / width, (h * 0.16) / height],
            "leftEye": [(x + w * 0.18) / width, (y + h * 0.30) / height, (w * 0.22) / width, (h * 0.12) / height],
            "rightEye": [(x + w * 0.60) / width, (y + h * 0.30) / height, (w * 0.22) / width, (h * 0.12) / height],
        }
    except Exception as error:
        log(f"face detection failed: {error}")
        return None


def build_mesh(image, depth, grid, relief):
    """Build the relief mesh.

    @param image - a PIL image in RGB.
    @param depth - the normalized depth map.
    @param grid - vertex count along the longer side.
    @param relief - how far the nearest pixel is pushed out.
    @returns the mesh, as arrays ready for JSON.
    """
    import numpy as np
    from PIL import Image

    width, height = image.size
    aspect = width / height
    if aspect >= 1:
        grid_w, grid_h = grid, max(2, int(round(grid / aspect)))
    else:
        grid_w, grid_h = max(2, int(round(grid * aspect))), grid
    # Colour and depth are resampled onto the SAME grid, so vertex (i, j) has
    # both its own colour and its own displacement without a texture.
    colour = np.asarray(image.resize((grid_w, grid_h), Image.LANCZOS), dtype=np.uint8)
    relief_map = np.asarray(
        Image.fromarray((depth * 255).astype(np.uint8)).resize((grid_w, grid_h), Image.BICUBIC),
        dtype=np.float32,
    ) / 255.0

    # A plane in XY, centred on the origin, with the picture upright: the
    # client's camera looks down -Z, so a larger depth is a smaller Z.
    span_x = 2.0 * (grid_w / max(grid_w, grid_h))
    span_y = 2.0 * (grid_h / max(grid_w, grid_h))
    xs = np.linspace(-span_x / 2, span_x / 2, grid_w, dtype=np.float32)
    ys = np.linspace(span_y / 2, -span_y / 2, grid_h, dtype=np.float32)
    gx, gy = np.meshgrid(xs, ys)
    position = np.stack([gx, gy, (0.5 - relief_map) * relief], axis=-1).astype(np.float32)
    return {
        "grid": [grid_w, grid_h],
        "position": position.reshape(-1, 3),
        "color": colour.reshape(-1, 3),
    }


def build_index(grid_w, grid_h):
    """Build the triangle list for a grid, wound so the front face is visible.

    @param grid_w - vertices across.
    @param grid_h - vertices down.
    @returns the indices, as a flat list.
    """
    import numpy as np

    cells = (grid_h - 1, grid_w - 1)
    rows = np.arange(cells[0], dtype=np.int32)[:, None]
    cols = np.arange(cells[1], dtype=np.int32)[None, :]
    top_left = rows * grid_w + cols
    top_right = top_left + 1
    bottom_left = top_left + grid_w
    bottom_right = bottom_left + 1
    # Counter-clockwise seen from +Z, which is the side the camera is on.
    first = np.stack([top_left, bottom_left, top_right], axis=-1).reshape(-1)
    second = np.stack([top_right, bottom_left, bottom_right], axis=-1).reshape(-1)
    return np.concatenate([first, second]).astype(np.uint32)


def encode(array, kind):
    """Encode one array for transport.

    @param array - the numpy array.
    @param kind - 'f32' for positions, 'u8' for colours, 'index' for triangles.
    @returns a dict naming the type and the base64 payload.
    """
    import numpy as np

    if kind == "f32":
        data = np.ascontiguousarray(array, dtype="<f4")
        name = "f32"
    elif kind == "u8":
        data = np.ascontiguousarray(array, dtype="u1")
        name = "u8"
    elif kind == "index":
        # A 160-grid mesh stays under 65 536 vertices, so 16-bit indices halve
        # the largest part of the payload. Larger grids fall back to 32-bit
        # rather than silently wrapping.
        if array.size == 0 or int(array.max()) < 65536:
            data = np.ascontiguousarray(array, dtype="<u2")
            name = "u16"
        else:
            data = np.ascontiguousarray(array, dtype="<u4")
            name = "u32"
    else:
        raise ValueError(f"unknown encoding: {kind}")
    return {"type": name, "base64": base64.b64encode(data.tobytes()).decode("ascii")}


def main():
    """Serve mesh requests until stdin closes."""
    if len(sys.argv) < 2:
        emit({"id": None, "error": "usage: relief_worker.py <model.onnx>"})
        return 2
    model_path = sys.argv[1]
    if not os.path.exists(model_path):
        emit({"id": None, "error": f"depth model not found: {model_path}"})
        return 1
    try:
        session = load_session(model_path)
    except Exception as error:
        emit({"id": None, "error": f"depth model failed to load: {error}"})
        return 1
    from PIL import Image

    emit({"id": None, "ready": True})
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
            path = request.get("image")
            if not path or not os.path.exists(path):
                emit({"id": request_id, "error": f"image not found: {path}"})
                continue
            grid = max(32, min(400, int(request.get("grid") or 160)))
            relief = max(0.0, min(1.0, float(request.get("depth") or 0.22)))
            with Image.open(path) as opened:
                image = opened.convert("RGB")
            # A portrait taller than the model's window still works; the resize
            # keeps the aspect and the grid is independent of it.
            depth = estimate_depth(session, image)
            mesh = build_mesh(image, depth, grid, relief)
            index = build_index(mesh["grid"][0], mesh["grid"][1])
            emit({
                "id": request_id,
                "grid": mesh["grid"],
                "position": encode(mesh["position"], "f32"),
                "color": encode(mesh["color"], "u8"),
                "index": encode(index, "index"),
                # Depth first: it always answers, needs no second model, and a
                # face detector is only a refinement when one happens to be
                # installed.
                "face": find_face_from_depth(depth) or find_face(image),
            })
        except Exception as error:
            emit({"id": request_id, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
