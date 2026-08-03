// Signed-distance primitives and the small amount of vector math the character
// builder needs. Distances are exact where cheap and bounded-conservative where
// not (ellipsoids), which is fine because the mesher only needs the zero level
// set plus a usable gradient direction.

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function length3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Polynomial smooth minimum. k controls the blend width in world units. */
export function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}

/** Smooth maximum, used for carving. */
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

export function sdSphere(px, py, pz, cx, cy, cz, r) {
  return length3(px - cx, py - cy, pz - cz) - r;
}

/**
 * Axis-aligned ellipsoid. This is the standard bounded approximation: exact on
 * the surface up to first order, and monotonic, which is all the mesher needs.
 */
export function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const z = (pz - cz) / rz;
  const k0 = length3(x, y, z);
  if (k0 === 0) return -Math.min(rx, ry, rz);
  const k1 = length3(x / rx, y / ry, z / rz);
  return (k0 * (k0 - 1.0)) / k1;
}

/** Capsule between a and b with constant radius r. */
export function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz;
  const h = denom === 0 ? 0 : clamp((pax * bax + pay * bay + paz * baz) / denom, 0, 1);
  return length3(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

/**
 * Tapered capsule (round cone) from a with radius ra to b with radius rb.
 * This is the workhorse for limbs, ears and tail segments.
 */
export function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 === 0) return length3(px - ax, py - ay, pz - az) - Math.max(ra, rb);

  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1.0 / l2;

  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;

  // Everything below is kept in the l2-scaled space and divided out at the end,
  // which is what keeps the three branches consistent with each other.
  const qx = pax * l2 - bax * y;
  const qy = pay * l2 - bay * y;
  const qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;

  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(Math.max(x2 * a2 * il2, 0)) + y * rr) * il2 - ra;
}

/** Rounded box, half-extents h, corner radius r. */
export function sdRoundBox(px, py, pz, cx, cy, cz, hx, hy, hz, r) {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  const qz = Math.abs(pz - cz) - hz + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return length3(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

/**
 * 2D oriented box: a rectangle whose centreline runs a -> b, with the given
 * half-width. Straight edges and square corners, which is what distinguishes a
 * lightning bolt from a chain of capsules.
 */
export function sdSegmentBox2D(px, py, ax, ay, bx, by, halfWidth) {
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey);
  if (len < 1e-9) return Math.hypot(px - ax, py - ay) - halfWidth;

  const dx = ex / len;
  const dy = ey / len;

  // Into the segment's own frame, centred on its midpoint.
  const cx = px - (ax + bx) * 0.5;
  const cy = py - (ay + by) * 0.5;
  const qx = Math.abs(cx * dx + cy * dy) - len * 0.5;
  const qy = Math.abs(-cx * dy + cy * dx) - halfWidth;

  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0);
}

/**
 * Extrudes a 2D field along X into a slab of the given half-thickness, with
 * corners rounded by `radius`. The 2D distance must be shrunk by the radius
 * first so the rounding grows inwards rather than inflating the silhouette.
 */
export function extrudeX(distance2D, x, halfThickness, radius = 0) {
  const wx = distance2D + radius;
  const wy = Math.abs(x) - (halfThickness - radius);
  const ox = Math.max(wx, 0);
  const oy = Math.max(wy, 0);
  return Math.min(Math.max(wx, wy), 0) + Math.hypot(ox, oy) - radius;
}

/** Numerical gradient of a scalar field; returns a unit vector. */
export function gradient(field, x, y, z, eps = 1e-3) {
  const dx = field(x + eps, y, z) - field(x - eps, y, z);
  const dy = field(x, y + eps, z) - field(x, y - eps, z);
  const dz = field(x, y, z + eps) - field(x, y, z - eps);
  const len = length3(dx, dy, dz);
  if (len < 1e-12) return [0, 1, 0];
  return [dx / len, dy / len, dz / len];
}

/** Shortest distance from p to segment ab, plus the parameter along the segment. */
export function distanceToSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz;
  const h = denom === 0 ? 0 : clamp((pax * bax + pay * bay + paz * baz) / denom, 0, 1);
  return {
    distance: length3(pax - bax * h, pay - bay * h, paz - baz * h),
    t: h,
  };
}
