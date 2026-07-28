#!/usr/bin/env python3
"""Measures facial feature placement from an image by colour segmentation.

The point is to remove eyeballing from the loop. The same routine runs against
the reference artwork and against our own render, so the two are measured by
identical code and the difference between them is a set of numbers rather than
an impression.

Everything is expressed in multiples of the eye separation, with the origin at
the midpoint between the eyes. That frame is invariant to image size, crop and
zoom, and unlike a head bounding box it survives a posed three-quarter view.

Usage:
    measure-face.py <image> [--label NAME] [--json OUT]
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image


def load_rgba(path):
    image = Image.open(path).convert('RGBA')
    return np.asarray(image).astype(np.float32) / 255.0


def largest_component(mask):
    """Flood-fills to keep only the biggest blob, which drops stray pixels
    picked up by a loose colour threshold (outlines, anti-aliasing, noise)."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    current = 0
    best_label, best_size = 0, 0

    height, width = mask.shape
    for sy in range(height):
        for sx in range(width):
            if not mask[sy, sx] or labels[sy, sx]:
                continue
            current += 1
            stack = [(sy, sx)]
            labels[sy, sx] = current
            size = 0
            while stack:
                y, x = stack.pop()
                size += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = current
                        stack.append((ny, nx))
            if size > best_size:
                best_size, best_label = size, current

    return labels == best_label if best_label else mask


def components(mask, min_pixels=30):
    """All blobs above a size floor, largest first."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    current = 0
    found = []

    height, width = mask.shape
    for sy in range(height):
        for sx in range(width):
            if not mask[sy, sx] or labels[sy, sx]:
                continue
            current += 1
            stack = [(sy, sx)]
            labels[sy, sx] = current
            pixels = []
            while stack:
                y, x = stack.pop()
                pixels.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = current
                        stack.append((ny, nx))
            if len(pixels) >= min_pixels:
                found.append(np.array(pixels))

    found.sort(key=len, reverse=True)
    return found


def blob_stats(pixels, origin, scale):
    ys = pixels[:, 0]
    xs = pixels[:, 1]
    return {
        'u': round(float((xs.mean() - origin[0]) / scale[0]), 4),
        'v': round(float((ys.mean() - origin[1]) / scale[1]), 4),
        'width': round(float((xs.max() - xs.min() + 1) / scale[0]), 4),
        'height': round(float((ys.max() - ys.min() + 1) / scale[1]), 4),
        'area': int(len(pixels)),
    }


def compactness(pixels):
    """Filled fraction of the blob's bounding box. Round features approach 0.79;
    outlines and thin strokes sit far below."""
    h = pixels[:, 0].max() - pixels[:, 0].min() + 1
    w = pixels[:, 1].max() - pixels[:, 1].min() + 1
    return len(pixels) / float(h * w)


def measure(path, label):
    """Normalises against the eyes rather than a head bounding box.

    A head box sounds simpler but is not robust: the reference art is a posed
    three-quarter view with an outstretched arm and raised tail, so "widest row
    in the upper half" lands on the arm, not the head. Interocular distance is
    the standard facial reference frame precisely because it survives pose.

        origin = midpoint between the eyes
        unit   = distance between eye centroids
    """
    rgba = load_rgba(path)
    r, g, b, a = rgba[..., 0], rgba[..., 1], rgba[..., 2], rgba[..., 3]
    opaque = a > 0.5

    body = opaque & ~((b > r) & (b > g))
    body_area = max(1, int(body.sum()))

    red = opaque & (r > 0.45) & (r - g > 0.22) & (r - b > 0.22)
    dark = opaque & (r < 0.42) & (g < 0.40) & (b < 0.40)

    # Size window keeps out both speckle and the character outline, which in the
    # official artwork is a single enormous connected dark component.
    lo = max(12, int(body_area * 0.0008))
    hi = int(body_area * 0.06)

    def candidates(mask, min_compact):
        out = []
        for pixels in components(mask, min_pixels=lo):
            if len(pixels) > hi:
                continue
            if compactness(pixels) < min_compact:
                continue
            out.append(pixels)
        return out

    dark_blobs = candidates(dark, 0.52)
    if len(dark_blobs) < 2:
        raise SystemExit(f'{path}: found {len(dark_blobs)} compact dark blobs, need 2 for eyes')

    # Eyes are the pair that is most alike in size and most level with each
    # other. Ear tips are dark and sit higher, but they are elongated and
    # unequal once foreshortened, so this scores them out.
    best, best_score = None, 1e9
    for i in range(len(dark_blobs)):
        for j in range(i + 1, len(dark_blobs)):
            p1, p2 = dark_blobs[i], dark_blobs[j]
            y1, x1 = p1[:, 0].mean(), p1[:, 1].mean()
            y2, x2 = p2[:, 0].mean(), p2[:, 1].mean()
            separation = abs(x2 - x1)
            if separation < 4:
                continue
            size_ratio = min(len(p1), len(p2)) / max(len(p1), len(p2))
            level = abs(y2 - y1) / separation          # 0 when perfectly level
            score = (1 - size_ratio) * 2.0 + level * 1.5
            if score < best_score:
                best_score, best = score, (p1, p2)

    if best is None:
        raise SystemExit(f'{path}: could not pair up eyes')

    eyes = sorted(best, key=lambda p: p[:, 1].mean())
    ex = [float(p[:, 1].mean()) for p in eyes]
    ey = [float(p[:, 0].mean()) for p in eyes]
    unit = float(np.hypot(ex[1] - ex[0], ey[1] - ey[0]))
    origin = ((ex[0] + ex[1]) / 2.0, (ey[0] + ey[1]) / 2.0)
    scale = (unit, unit)

    result = {
        'label': label,
        'image': path,
        'interocularPx': round(unit, 2),
        'eyePairScore': round(best_score, 3),
        'features': {},
    }
    for name, pixels in zip(('eye.L', 'eye.R'), eyes):
        result['features'][name] = blob_stats(pixels, origin, scale)

    # Both references have an open mouth with a pink tongue, which trips the
    # red threshold. Cheeks are laterally displaced by definition, so anything
    # sitting near the midline is the mouth and not a pouch.
    red_blobs = candidates(red, 0.45)
    cheeks = [q for q in red_blobs
              if abs((q[:, 1].mean() - origin[0]) / unit) > 0.34]
    cheeks = sorted(cheeks, key=len, reverse=True)[:2]
    cheeks.sort(key=lambda p: p[:, 1].mean())

    # Whatever red sits near the midline below the eyes is the mouth.
    for q in red_blobs:
        u = (q[:, 1].mean() - origin[0]) / unit
        v = (q[:, 0].mean() - origin[1]) / unit
        if abs(u) <= 0.34 and v > 0.15:
            result['features']['mouth'] = blob_stats(q, origin, scale)
            break
    for name, pixels in zip(('cheek.L', 'cheek.R'), cheeks):
        result['features'][name] = blob_stats(pixels, origin, scale)

    return result


def report(measurement):
    print(f"\n=== {measurement['label']} ({measurement['image']}) ===")
    print(f"  interocular {measurement['interocularPx']:.1f}px  "
          f"(eye-pair score {measurement['eyePairScore']:.3f}, lower is a cleaner match)")
    print(f"  {'feature':10} {'u':>7} {'v':>7} {'w':>7} {'h':>7}   (multiples of eye separation)")
    for name, f in measurement['features'].items():
        if not isinstance(f, dict):
            print(f"  {name:10} {f:>7}")
            continue
        print(f"  {name:10} {f['u']:>7.3f} {f['v']:>7.3f} {f['width']:>7.3f} {f['height']:>7.3f}")


def compare(reference, ours):
    print('\n=== delta (ours - reference), in fractions of head width/height ===')
    print(f"  {'feature':10} {'du':>8} {'dv':>8} {'dw':>8} {'dh':>8}")
    for name, ref in reference['features'].items():
        if not isinstance(ref, dict):
            continue
        got = ours['features'].get(name)
        if not got:
            print(f"  {name:10}  MISSING from ours")
            continue
        print(f"  {name:10} {got['u'] - ref['u']:>+8.3f} {got['v'] - ref['v']:>+8.3f} "
              f"{got['width'] - ref['width']:>+8.3f} {got['height'] - ref['height']:>+8.3f}")



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('images', nargs='+')
    parser.add_argument('--labels', nargs='*', default=None)
    parser.add_argument('--json', default=None)
    args = parser.parse_args()

    labels = args.labels or [f'image{i}' for i in range(len(args.images))]
    results = [measure(p, labels[i] if i < len(labels) else p)
               for i, p in enumerate(args.images)]
    for r in results:
        report(r)
    if len(results) == 2:
        compare(results[0], results[1])
    if args.json:
        with open(args.json, 'w') as fh:
            json.dump(results, fh, indent=2)
        print(f'\nwrote {args.json}')


if __name__ == '__main__':
    sys.exit(main())
