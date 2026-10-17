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
# A YOLO detector trained on DRAWN faces, which is what makes automatic
# placement work for an illustration. A photograph detector does not fire on
# ink: measured here, YuNet scored 0.18 on a cel against a 0.6 threshold.
FACE_MODEL_NAME = "anime-face-v1.1s.onnx"
FACE_SIZE = 640
FACE_CONF = 0.25
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


FACE_MODEL_NAME = "anime-face-v1.1s.onnx"
FACE_SIZE = 640
FACE_CONF = 0.25


def load_face_session(path):
    """Open the anime face detector, or return None when it is not installed."""
    import onnxruntime as ort

    if not os.path.exists(path):
        log(f"face model not found at {path}; falling back to the depth guess")
        return None
    try:
        return ort.InferenceSession(path, ort.SessionOptions(), providers=["CPUExecutionProvider"])
    except Exception as error:
        log(f"face model failed to load: {error}")
        return None


def detect_face_box(session, image):
    """Find the drawn face, as a normalized box.

    A YOLOv8 detector trained on DRAWN faces, which is what makes automatic
    placement work for an illustration. A photograph detector does not fire on
    ink: measured here, YuNet scored 0.18 on a cel against a 0.6 threshold.

    @param session - the face detector session.
    @param image - a PIL image in RGB.
    @returns the box as [x, y, w, h] in 0..1, or None.
    """
    import numpy as np
    from PIL import Image

    if session is None:
        return None
    width, height = image.size
    scale = min(FACE_SIZE / width, FACE_SIZE / height)
    resized_w = max(1, int(round(width * scale)))
    resized_h = max(1, int(round(height * scale)))
    # Letterbox with grey, the padding Ultralytics trains with.
    canvas = Image.new("RGB", (FACE_SIZE, FACE_SIZE), (114, 114, 114))
    offset_x = (FACE_SIZE - resized_w) // 2
    offset_y = (FACE_SIZE - resized_h) // 2
    canvas.paste(image.resize((resized_w, resized_h), Image.BILINEAR), (offset_x, offset_y))
    pixels = np.asarray(canvas, dtype=np.float32) / 255.0
    tensor = pixels.transpose(2, 0, 1)[None]
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    # [1, 4 + classes, anchors] -> anchors x (4 + classes).
    predictions = output[0].T
    scores = predictions[:, 4:].max(axis=1)
    keep = scores >= FACE_CONF
    if not keep.any():
        return None
    predictions = predictions[keep]
    scores = scores[keep]
    cx, cy, bw, bh = predictions[:, 0], predictions[:, 1], predictions[:, 2], predictions[:, 3]
    x1, y1 = cx - bw / 2, cy - bh / 2
    x2, y2 = cx + bw / 2, cy + bh / 2
    order = scores.argsort()[::-1]
    kept = []
    for i in order:
        ok = True
        for j in kept:
            ix = max(0.0, min(x2[i], x2[j]) - max(x1[i], x1[j]))
            iy = max(0.0, min(y2[i], y2[j]) - max(y1[i], y1[j]))
            inter = ix * iy
            union = (x2[i]-x1[i])*(y2[i]-y1[i]) + (x2[j]-x1[j])*(y2[j]-y1[j]) - inter
            if union > 0 and inter / union > 0.45:
                ok = False
                break
        if ok:
            kept.append(i)
    if not kept:
        return None
    best = kept[0]
    # Back out of the letterbox.
    bx = (x1[best] - offset_x) / scale / width
    by = (y1[best] - offset_y) / scale / height
    bwid = (x2[best] - x1[best]) / scale / width
    bhei = (y2[best] - y1[best]) / scale / height
    if bwid <= 0.02 or bhei <= 0.02:
        return None
    return [float(bx), float(by), float(bwid), float(bhei)]


def features_in_box(box):
    """Place the eyes and the mouth inside a face box.

    Proportions rather than a second model, because they were measured against a
    real cel: with a correct face box the eyes sit about 40% down it and the
    mouth about 71%, and both span most of its width.

    @param box - the face box, normalized.
    @returns the mouth and eye boxes, with the face box itself.
    """
    bx, by, bw, bh = box
    return {
        "face": [bx, by, bw, bh],
        "leftEye": [bx + bw * 0.119, by + bh * 0.347, bw * 0.716, bh * 0.11],
        "rightEye": [bx + bw * 0.119, by + bh * 0.347, bw * 0.716, bh * 0.11],
        "mouth": [bx + bw * 0.313, by + bh * 0.657, bw * 0.21, bh * 0.10],
    }



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
    # The face detector sits beside the depth model and is optional: without it
    # placement falls back to the depth guess, which the marks can still correct.
    face_path = os.path.join(os.path.dirname(model_path), FACE_MODEL_NAME)
    face_session = load_face_session(face_path)
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
                # Detector first: it is trained on drawings, so it works where
                # the depth guess does not. The guess stands in when there is no
                # model or no face, and the marks override both.
                "face": (lambda box: features_in_box(box) if box else find_face_from_depth(depth))(
                    detect_face_box(face_session, image)),
            })
        except Exception as error:
            emit({"id": request_id, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
