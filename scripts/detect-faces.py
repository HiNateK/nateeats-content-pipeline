#!/usr/bin/env python3
"""
detect-faces.py — face detection + blurring helper for publish-article (best-effort).

Called by scripts/publish-article.mjs. Two modes:

  detect <img> [<img> ...]
      Print JSON {"<path>": {"faces": N, "maxWidthFrac": f}, ...}.
      Used to decide whether an image is face-free (cover pick / validation).

  blur <src> <dst> [--keep-largest]
      Blur every detected face in <src>, write to <dst>.
      --keep-largest leaves the single biggest face unblurred (a selfie subject);
      everyone else is blurred. <dst> ending in .webp keeps EXIF + sets quality;
      any other extension is saved as-is (e.g. lossless .png intermediate).
      Print JSON {"faces": N, "blurred": M, "kept": K}.

Requires python3 + opencv-python(-headless) + numpy + Pillow. The YuNet model is
downloaded once to scripts/.cache/. If a dependency or the model is missing it
exits with code 3 (+ a message on stderr) so the Node caller can skip gracefully.
"""
import sys, os, json, urllib.request

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
MODEL = os.path.join(CACHE, "face_detection_yunet_2023mar.onnx")
MODEL_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
             "face_detection_yunet/face_detection_yunet_2023mar.onnx")

SCORE = 0.5        # detection confidence — privacy-first recall; raise to trim food/signage FPs
NMS = 0.3
WFRAC_CAP = 0.18   # boxes wider than this fraction of the image are treated as FPs
SCALES = (1.0, 1.6)  # native + upscaled pass, to catch small/distant faces


def die_skip(msg):
    sys.stderr.write("detect-faces: " + msg + "\n")
    sys.exit(3)  # signal "skip, but don't fail the publish" to the Node caller


try:
    import numpy as np
    import cv2
    from PIL import Image, ImageFilter
except Exception as e:  # noqa: BLE001
    die_skip("missing dependency (%s) — `pip install opencv-python numpy Pillow` to enable face blur" % e)


def ensure_model():
    if os.path.exists(MODEL):
        return
    os.makedirs(CACHE, exist_ok=True)
    try:
        urllib.request.urlretrieve(MODEL_URL, MODEL)
    except Exception as e:  # noqa: BLE001
        die_skip("could not download YuNet model (%s) — connect once or drop it at %s" % (e, MODEL))


def _iou(a, b):
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter == 0:
        return 0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0


def detect_boxes(bgr):
    h, w = bgr.shape[:2]
    boxes = []
    for scale in SCALES:
        sw, sh = int(w * scale), int(h * scale)
        img = cv2.resize(bgr, (sw, sh)) if scale != 1.0 else bgr
        det = cv2.FaceDetectorYN.create(MODEL, "", (sw, sh),
                                        score_threshold=SCORE, nms_threshold=NMS, top_k=5000)
        det.setInputSize((sw, sh))
        _, faces = det.detect(img)
        if faces is not None:
            for f in faces:
                x, y, fw, fh = f[0] / scale, f[1] / scale, f[2] / scale, f[3] / scale
                boxes.append([x, y, x + fw, y + fh, float(f[14])])
    # size cap (drop oversized FPs on out-of-focus foreground) + NMS merge
    boxes = [b for b in boxes if (b[2] - b[0]) / w <= WFRAC_CAP]
    boxes.sort(key=lambda b: -b[4])
    kept = []
    for b in boxes:
        if all(_iou(b, k) < 0.3 for k in kept):
            kept.append(b)
    return kept, w, h


def anonymize(img, box, pad=0.35):
    w, h = img.size
    x0, y0, x1, y1 = box[:4]
    bw, bh = x1 - x0, y1 - y0
    x0 = max(0, int(x0 - bw * pad)); y0 = max(0, int(y0 - bh * pad))
    x1 = min(w, int(x1 + bw * pad)); y1 = min(h, int(y1 + bh * pad))
    if x1 <= x0 or y1 <= y0:
        return
    region = img.crop((x0, y0, x1, y1))
    rw, rh = region.size
    small = region.resize((max(3, rw // 12), max(3, rh // 12)), Image.BILINEAR)
    mosaic = small.resize((rw, rh), Image.NEAREST).filter(ImageFilter.GaussianBlur(radius=max(5, rw / 7)))
    img.paste(mosaic, (x0, y0))


def cmd_detect(paths):
    ensure_model()
    out = {}
    for p in paths:
        try:
            im = Image.open(p).convert("RGB")
            bgr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
            boxes, w, _ = detect_boxes(bgr)
            out[p] = {"faces": len(boxes),
                      "maxWidthFrac": round(float(max([(b[2] - b[0]) / w for b in boxes], default=0)), 3)}
        except Exception as e:  # noqa: BLE001
            out[p] = {"error": str(e)}
    print(json.dumps(out))


def cmd_blur(src, dst, keep_largest):
    ensure_model()
    im = Image.open(src).convert("RGB")
    exif = im.info.get("exif")
    bgr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    boxes, _, _ = detect_boxes(bgr)
    kept = 0
    if keep_largest and boxes:
        biggest = max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        boxes = [b for b in boxes if b is not biggest]
        kept = 1
    for b in boxes:
        anonymize(im, b)
    if dst.lower().endswith(".webp"):
        kw = dict(quality=82, method=6)
        if exif:
            kw["exif"] = exif
        im.save(dst, "WEBP", **kw)
    else:
        im.save(dst)
    print(json.dumps({"faces": len(boxes) + kept, "blurred": len(boxes), "kept": kept}))


def main():
    if len(sys.argv) < 2:
        die_skip("usage: detect-faces.py detect|blur ...")
    mode = sys.argv[1]
    if mode == "detect":
        cmd_detect(sys.argv[2:])
    elif mode == "blur":
        args = sys.argv[2:]
        keep = "--keep-largest" in args
        pos = [a for a in args if not a.startswith("--")]
        if len(pos) < 2:
            die_skip("blur needs <src> <dst>")
        cmd_blur(pos[0], pos[1], keep)
    else:
        die_skip("unknown mode: " + mode)


if __name__ == "__main__":
    main()
