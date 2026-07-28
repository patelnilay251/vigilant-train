// Builds the player character as a rigged, animated GLB.
//
// Pipeline: an implicit surface (blended SDF primitives) is meshed with surface
// nets, painted per-vertex from a region classifier, bound to a hand-authored
// skeleton with distance-falloff weights, and finally given four animation clips
// baked from analytic pose functions. Nothing is hand-modelled; changing a
// number in ANATOMY below changes both the silhouette and the rig, because the
// field and the skeleton read from the same table.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLTFBuilder } from './lib/glb.mjs';
import { surfaceNets } from './lib/surfacenets.mjs';
import {
  smin, sdSphere, sdEllipsoid, sdRoundCone, distanceToSegment, clamp, smoothstep,
} from './lib/sdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../web/public/assets');

// ---------------------------------------------------------------------------
// Palette. Authored in sRGB because that is how anyone reasons about colour,
// then converted once at write time: glTF vertex colours are linear.
// ---------------------------------------------------------------------------

const YELLOW = [0.988, 0.792, 0.129];
const BROWN = [0.396, 0.220, 0.086];
const DARK = [0.106, 0.086, 0.078];
const RED = [0.878, 0.157, 0.129];
const WHITE = [1.0, 1.0, 1.0];
const TONGUE = [0.706, 0.239, 0.286];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ---------------------------------------------------------------------------
// Anatomy. +Y up, +Z forward. Roughly 1.19 units from floor to ear tip.
// ---------------------------------------------------------------------------

const ANATOMY = {
  torsoUpper: { c: [0, 0.425, 0.005], r: 0.175 },
  torsoLower: { c: [0, 0.255, 0.0], r: 0.215 },
  head: { c: [0, 0.66, 0.015], r: [0.25, 0.235, 0.235] },
  cheek: { c: [0.172, 0.605, 0.092], r: 0.09 },
  ear: {
    root: [0.108, 0.845, -0.02],
    mid: [0.2, 1.02, -0.09],
    tip: [0.295, 1.19, -0.175],
    rRoot: 0.066, rMid: 0.048, rTip: 0.024,
  },
  arm: { shoulder: [0.165, 0.455, 0.01], hand: [0.248, 0.312, 0.058], rTop: 0.062, rEnd: 0.053 },
  leg: { hip: [0.1, 0.198, 0.0], ankle: [0.125, 0.052, 0.0], rTop: 0.092, rEnd: 0.074 },
  foot: { c: [0.128, 0.046, 0.048], r: [0.08, 0.048, 0.116] },
  // Strong direction reversals; the tip stays just under the crown of the head
  // so it does not poke through the silhouette from the front.
  tail: {
    pts: [
      [0, 0.24, -0.17],
      [0, 0.17, -0.34],
      [0, 0.42, -0.27],
      [0, 0.34, -0.52],
      [0, 0.76, -0.38],
    ],
    radii: [0.038, 0.062, 0.085, 0.100, 0.130],
    flatten: 3.0,
  },
};

const MIRROR = [1, -1];

// ---------------------------------------------------------------------------
// Shape field. Negative inside.
// ---------------------------------------------------------------------------

function tailField(x, y, z) {
  const { pts, radii, flatten } = ANATOMY.tail;
  // Evaluating in a space stretched along X yields a shape that is thin along X.
  // Dividing the result by the stretch keeps the field a conservative (Lipschitz
  // <= 1) distance bound, which is what the mesher's Newton step relies on.
  const fx = x * flatten;
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = sdRoundCone(fx, y, z, a[0], a[1], a[2], b[0], b[1], b[2], radii[i], radii[i + 1]);
    // Hard union, not smin: the creases between segments are the whole point.
    // Smoothing them is what turns a lightning bolt into a paddle.
    d = Math.min(d, seg);
  }
  return d / flatten;
}

function shape(x, y, z) {
  const A = ANATOMY;

  // Pear-shaped torso from two spheres.
  let d = smin(
    sdSphere(x, y, z, A.torsoUpper.c[0], A.torsoUpper.c[1], A.torsoUpper.c[2], A.torsoUpper.r),
    sdSphere(x, y, z, A.torsoLower.c[0], A.torsoLower.c[1], A.torsoLower.c[2], A.torsoLower.r),
    0.1,
  );

  d = smin(d, sdEllipsoid(x, y, z, A.head.c[0], A.head.c[1], A.head.c[2], A.head.r[0], A.head.r[1], A.head.r[2]), 0.055);

  for (const s of MIRROR) {
    d = smin(d, sdSphere(x, y, z, s * A.cheek.c[0], A.cheek.c[1], A.cheek.c[2], A.cheek.r), 0.05);

    const e = A.ear;
    const lower = sdRoundCone(x, y, z, s * e.root[0], e.root[1], e.root[2], s * e.mid[0], e.mid[1], e.mid[2], e.rRoot, e.rMid);
    const upper = sdRoundCone(x, y, z, s * e.mid[0], e.mid[1], e.mid[2], s * e.tip[0], e.tip[1], e.tip[2], e.rMid, e.rTip);
    d = smin(d, Math.min(lower, upper), 0.042);

    const a = A.arm;
    d = smin(d, sdRoundCone(x, y, z, s * a.shoulder[0], a.shoulder[1], a.shoulder[2], s * a.hand[0], a.hand[1], a.hand[2], a.rTop, a.rEnd), 0.05);

    const l = A.leg;
    const f = A.foot;
    let limb = sdRoundCone(x, y, z, s * l.hip[0], l.hip[1], l.hip[2], s * l.ankle[0], l.ankle[1], l.ankle[2], l.rTop, l.rEnd);
    limb = smin(limb, sdEllipsoid(x, y, z, s * f.c[0], f.c[1], f.c[2], f.r[0], f.r[1], f.r[2]), 0.04);
    d = smin(d, limb, 0.055);
  }

  // Small blend so the tail joins the rump cleanly without eroding its notches.
  return smin(d, tailField(x, y, z), 0.035);
}

// ---------------------------------------------------------------------------
// Region classifier: which colour a point on the surface should take.
// ---------------------------------------------------------------------------

function surfaceColor(x, y, z) {
  const A = ANATOMY;

  for (const s of MIRROR) {
    const e = A.ear;
    const { distance, t } = distanceToSegment(
      x, y, z,
      s * e.root[0], e.root[1], e.root[2],
      s * e.tip[0], e.tip[1], e.tip[2],
    );
    if (distance < 0.12 && t > 0.58) return BROWN;
  }

  const t0 = A.tail.pts[0];
  const t1 = A.tail.pts[1];
  if (z < -0.15) {
    const { distance } = distanceToSegment(x, y, z, t0[0], t0[1], t0[2], t1[0], t1[1], t1[2]);
    if (distance < 0.10) return BROWN;
  }

  // Two bands across the back only.
  if (z < -0.03 && Math.abs(x) < 0.19) {
    if ((y > 0.335 && y < 0.402) || (y > 0.448 && y < 0.508)) return BROWN;
  }

  return YELLOW;
}

// ---------------------------------------------------------------------------
// Skeleton. Rest pose is translation-only, which makes every inverse bind
// matrix a plain negated translation.
// ---------------------------------------------------------------------------

function buildSkeleton() {
  const A = ANATOMY;
  const ear = A.ear;
  const arm = A.arm;
  const leg = A.leg;
  const tail = A.tail.pts;

  const bones = [
    { name: 'root', parent: -1, pos: [0, 0, 0] },
    { name: 'hips', parent: 0, pos: [0, 0.235, -0.01], seg: [[0, 0.195, -0.01], [0, 0.335, 0]], r: 0.185 },
    { name: 'spine', parent: 1, pos: [0, 0.395, 0], seg: [[0, 0.335, 0], [0, 0.46, 0.005]], r: 0.16 },
    { name: 'chest', parent: 2, pos: [0, 0.5, 0.005], seg: [[0, 0.46, 0.005], [0, 0.575, 0.01]], r: 0.16 },
    { name: 'head', parent: 3, pos: [0, 0.615, 0.01], seg: [[0, 0.6, 0.01], [0, 0.775, 0.015]], r: 0.215 },
  ];

  const index = (name) => bones.findIndex((b) => b.name === name);

  for (const [suffix, s] of [['L', 1], ['R', -1]]) {
    const m = (p) => [s * p[0], p[1], p[2]];
    bones.push({
      name: `ear.${suffix}`, parent: index('head'), pos: m(ear.root),
      seg: [m(ear.root), m(ear.mid)], r: 0.075,
    });
    bones.push({
      name: `earTip.${suffix}`, parent: bones.length - 1, pos: m(ear.mid),
      seg: [m(ear.mid), m(ear.tip)], r: 0.075,
    });
  }

  for (const [suffix, s] of [['L', 1], ['R', -1]]) {
    const m = (p) => [s * p[0], p[1], p[2]];
    bones.push({
      name: `arm.${suffix}`, parent: index('chest'), pos: m(arm.shoulder),
      seg: [m(arm.shoulder), m(arm.hand)], r: 0.08,
    });
    bones.push({
      name: `hand.${suffix}`, parent: bones.length - 1, pos: m(arm.hand),
      seg: [m(arm.hand), m(arm.hand)], r: 0.062,
    });
  }

  for (const [suffix, s] of [['L', 1], ['R', -1]]) {
    const m = (p) => [s * p[0], p[1], p[2]];
    bones.push({
      name: `leg.${suffix}`, parent: index('hips'), pos: m(leg.hip),
      seg: [m(leg.hip), m(leg.ankle)], r: 0.095,
    });
    bones.push({
      name: `foot.${suffix}`, parent: bones.length - 1, pos: m(leg.ankle),
      seg: [m(ANATOMY.foot.c), m(ANATOMY.foot.c)], r: 0.09,
    });
  }

  // The tail bones sit close enough to the lower back that a pure distance
  // falloff would drag the body with them; the mask fades them in behind it.
  const tailMask = (x, y, z) => smoothstep(-0.185, -0.31, z);
  const tailRadii = [0.075, 0.1, 0.115, 0.14];
  for (let i = 0; i < 4; i++) {
    bones.push({
      name: `tail${i + 1}`,
      parent: i === 0 ? index('hips') : bones.length - 1,
      pos: tail[i],
      seg: [tail[i], tail[i + 1]],
      r: tailRadii[i],
      mask: tailMask,
    });
  }

  return bones;
}

const BONES = buildSkeleton();
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b.name, i]));

function skinWeights(x, y, z) {
  const candidates = [];
  for (let i = 0; i < BONES.length; i++) {
    const bone = BONES[i];
    if (!bone.seg) continue;
    const [a, b] = bone.seg;
    const { distance } = distanceToSegment(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2]);
    let w = Math.exp(-2.2 * (distance / bone.r) ** 2);
    if (bone.mask) w *= bone.mask(x, y, z);
    if (w > 1e-4) candidates.push([i, w]);
  }

  candidates.sort((p, q) => q[1] - p[1]);
  const top = candidates.slice(0, 4);

  if (top.length === 0) {
    // Fall back to the nearest bone outright so no vertex is left unbound.
    let best = BONE_INDEX.hips;
    let bestD = Infinity;
    for (let i = 0; i < BONES.length; i++) {
      const bone = BONES[i];
      if (!bone.seg) continue;
      const [a, b] = bone.seg;
      const { distance } = distanceToSegment(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2]);
      if (distance < bestD) { bestD = distance; best = i; }
    }
    return { joints: [best, 0, 0, 0], weights: [1, 0, 0, 0] };
  }

  const total = top.reduce((sum, [, w]) => sum + w, 0);
  const joints = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  top.forEach(([i, w], k) => { joints[k] = i; weights[k] = w / total; });
  return { joints, weights };
}

// ---------------------------------------------------------------------------
// Mesh accumulation.
// ---------------------------------------------------------------------------

function createMesh() {
  return { positions: [], normals: [], colors: [], joints: [], weights: [], indices: [] };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-12 ? [0, 1, 0] : [v[0] / l, v[1] / l, v[2] / l];
}

function orthonormalBasis(n) {
  const up = Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const t = normalize(cross(up, n));
  return [t, cross(n, t), n];
}

/** Ellipsoid whose local +Z is aligned to `normal`, rigidly bound to one joint. */
function addOrientedEllipsoid(mesh, center, radii, normal, color, joint, segments = 28, rings = 18) {
  const n = normalize(normal);
  const [tx, ty, tz] = orthonormalBasis(n);
  const base = mesh.positions.length / 3;

  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const lx = sinPhi * Math.cos(theta);
      const ly = sinPhi * Math.sin(theta);
      const lz = cosPhi;

      const sx = lx * radii[0];
      const sy = ly * radii[1];
      const sz = lz * radii[2];
      mesh.positions.push(
        center[0] + tx[0] * sx + ty[0] * sy + tz[0] * sz,
        center[1] + tx[1] * sx + ty[1] * sy + tz[1] * sz,
        center[2] + tx[2] * sx + ty[2] * sy + tz[2] * sz,
      );

      const g = normalize([lx / radii[0], ly / radii[1], lz / radii[2]]);
      mesh.normals.push(
        tx[0] * g[0] + ty[0] * g[1] + tz[0] * g[2],
        tx[1] * g[0] + ty[1] * g[1] + tz[1] * g[2],
        tx[2] * g[0] + ty[2] * g[1] + tz[2] * g[2],
      );

      mesh.colors.push(color[0], color[1], color[2]);
      mesh.joints.push(joint, 0, 0, 0);
      mesh.weights.push(1, 0, 0, 0);
    }
  }

  const stride = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = base + i * stride + j;
      const b = a + stride;
      mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/**
 * Places a feature on the head ellipsoid given a direction in normalised
 * ellipsoid space, returning both the surface point and the true outward normal.
 */
function headSurface(dir, sideSign = 1) {
  const { c, r } = ANATOMY.head;
  const u = normalize([dir[0] * sideSign, dir[1], dir[2]]);
  const point = [c[0] + r[0] * u[0], c[1] + r[1] * u[1], c[2] + r[2] * u[2]];
  const normal = normalize([u[0] / r[0], u[1] / r[1], u[2] / r[2]]);
  return { point, normal };
}

function addFace(mesh) {
  const head = BONE_INDEX.head;

  for (const s of MIRROR) {
    // Eye: a dark dome sunk slightly into the skull, with a specular dot.
    const eye = headSurface([0.452, 0.181, 0.874], s);
    const eyeCenter = [
      eye.point[0] - eye.normal[0] * 0.026,
      eye.point[1] - eye.normal[1] * 0.026,
      eye.point[2] - eye.normal[2] * 0.026,
    ];
    addOrientedEllipsoid(mesh, eyeCenter, [0.055, 0.058, 0.055], eye.normal, DARK, head);

    const [bx, by] = orthonormalBasis(eye.normal);
    const glint = [
      eyeCenter[0] + eye.normal[0] * 0.048 + bx[0] * 0.016 * s + by[0] * 0.018,
      eyeCenter[1] + eye.normal[1] * 0.048 + bx[1] * 0.016 * s + by[1] * 0.018,
      eyeCenter[2] + eye.normal[2] * 0.048 + bx[2] * 0.016 * s + by[2] * 0.018,
    ];
    addOrientedEllipsoid(mesh, glint, [0.019, 0.019, 0.012], eye.normal, WHITE, head, 16, 10);

    // Cheek pouch: a flat red disc lying on the skull.
    const cheek = headSurface([0.857, -0.299, 0.419], s);
    const cheekCenter = [
      cheek.point[0] + cheek.normal[0] * 0.004,
      cheek.point[1] + cheek.normal[1] * 0.004,
      cheek.point[2] + cheek.normal[2] * 0.004,
    ];
    addOrientedEllipsoid(mesh, cheekCenter, [0.079, 0.079, 0.028], cheek.normal, RED, head);
  }

  const nose = headSurface([0, 0.02, 1]);
  addOrientedEllipsoid(mesh, nose.point, [0.019, 0.014, 0.014], nose.normal, DARK, head, 16, 12);

  const mouth = headSurface([0, -0.319, 0.948]);
  const mouthCenter = [
    mouth.point[0] - mouth.normal[0] * 0.012,
    mouth.point[1] - mouth.normal[1] * 0.012,
    mouth.point[2] - mouth.normal[2] * 0.012,
  ];
  addOrientedEllipsoid(mesh, mouthCenter, [0.042, 0.028, 0.026], mouth.normal, DARK, head, 24, 16);
  addOrientedEllipsoid(
    mesh,
    [
      mouthCenter[0] - mouth.normal[0] * 0.003,
      mouthCenter[1] - mouth.normal[1] * 0.003 - 0.009,
      mouthCenter[2] - mouth.normal[2] * 0.003,
    ],
    [0.026, 0.014, 0.020], mouth.normal, TONGUE, head, 20, 12,
  );
}

// ---------------------------------------------------------------------------
// Animation. Poses are analytic; keyframes are just samples of them.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const mirrorEuler = ([x, y, z]) => [x, -y, -z];

function applyMirrored(pose, baseName, euler) {
  pose[`${baseName}.L`] = { euler };
  pose[`${baseName}.R`] = { euler: mirrorEuler(euler) };
}

function idlePose(u) {
  const p = u * TAU;
  const breathe = Math.sin(p * 2);
  const pose = {
    hips: { euler: [0, 0, 0], offset: [0, 0.007 * breathe, 0] },
    spine: { euler: [0.018 * breathe, 0, 0] },
    chest: { euler: [0.016 * breathe, 0, 0] },
    head: { euler: [0.028 * Math.sin(p * 2 + 0.5), 0.07 * Math.sin(p), 0] },
  };
  applyMirrored(pose, 'ear', [0.06 * Math.sin(p + 0.3), 0, -0.12 + 0.1 * Math.sin(p)]);
  applyMirrored(pose, 'earTip', [0, 0, 0.16 * Math.sin(p + 0.9)]);
  applyMirrored(pose, 'arm', [0.05 * Math.sin(p), 0, -0.07 + 0.05 * Math.sin(p + 0.4)]);
  for (let i = 0; i < 4; i++) {
    pose[`tail${i + 1}`] = { euler: [0.03 * Math.sin(p + i * 0.5), 0.11 * Math.sin(p + i * 0.6), 0] };
  }
  return pose;
}

function strideePose(u, { swing, armSwing, lean, bob, earBounce, tailSway }) {
  const p = u * TAU;
  const pose = {
    hips: {
      euler: [0, 0.07 * Math.sin(p), 0],
      offset: [0, bob * Math.sin(p * 2), 0],
    },
    spine: { euler: [lean, 0, 0] },
    chest: { euler: [lean * 0.5, -0.06 * Math.sin(p), 0] },
    head: { euler: [-lean * 0.9, 0.05 * Math.sin(p), 0] },
  };

  pose['leg.L'] = { euler: [-swing * Math.sin(p), 0, 0] };
  pose['leg.R'] = { euler: [-swing * Math.sin(p + Math.PI), 0, 0] };
  pose['foot.L'] = { euler: [0.12 + 0.3 * Math.sin(p - 0.7), 0, 0] };
  pose['foot.R'] = { euler: [0.12 + 0.3 * Math.sin(p + Math.PI - 0.7), 0, 0] };

  pose['arm.L'] = { euler: [-armSwing * Math.sin(p + Math.PI), 0, -0.12] };
  pose['arm.R'] = { euler: [-armSwing * Math.sin(p), 0, 0.12] };

  applyMirrored(pose, 'ear', [-0.1 + earBounce * Math.sin(p * 2 + 0.4), 0, -0.16]);
  applyMirrored(pose, 'earTip', [earBounce * 1.4 * Math.sin(p * 2 + 1.1), 0, 0]);

  for (let i = 0; i < 4; i++) {
    pose[`tail${i + 1}`] = {
      euler: [-0.05 + 0.04 * Math.sin(p * 2 + i * 0.4), tailSway * Math.sin(p + i * 0.55), 0],
    };
  }
  return pose;
}

const walkPose = (u) => strideePose(u, {
  swing: 0.6, armSwing: 0.42, lean: 0.06, bob: 0.016, earBounce: 0.09, tailSway: 0.13,
});

const runPose = (u) => strideePose(u, {
  swing: 0.95, armSwing: 0.75, lean: 0.26, bob: 0.032, earBounce: 0.16, tailSway: 0.2,
});

function jumpPose(u) {
  // crouch -> extend -> tuck -> absorb
  const crouch = smoothstep(0.0, 0.16, u) * (1 - smoothstep(0.16, 0.3, u));
  const extend = smoothstep(0.18, 0.34, u) * (1 - smoothstep(0.55, 0.78, u));
  const land = smoothstep(0.78, 0.88, u) * (1 - smoothstep(0.88, 1.0, u));
  const tuck = smoothstep(0.34, 0.5, u) * (1 - smoothstep(0.62, 0.8, u));

  const squash = crouch * 0.9 + land * 0.7;
  const pose = {
    hips: { euler: [0, 0, 0], offset: [0, -0.075 * squash, 0] },
    spine: { euler: [0.28 * squash - 0.18 * extend, 0, 0] },
    chest: { euler: [0.12 * squash - 0.1 * extend, 0, 0] },
    head: { euler: [-0.2 * squash + 0.16 * extend, 0, 0] },
  };

  const legBend = 0.95 * squash - 0.25 * extend + 1.15 * tuck;
  pose['leg.L'] = { euler: [legBend, 0, 0] };
  pose['leg.R'] = { euler: [legBend, 0, 0] };
  pose['foot.L'] = { euler: [-0.5 * legBend + 0.35 * extend, 0, 0] };
  pose['foot.R'] = { euler: [-0.5 * legBend + 0.35 * extend, 0, 0] };

  applyMirrored(pose, 'arm', [-1.5 * extend + 0.5 * squash, 0, -0.2 - 0.3 * extend]);
  applyMirrored(pose, 'ear', [0.45 * squash - 0.5 * extend, 0, -0.14]);
  applyMirrored(pose, 'earTip', [0.5 * squash - 0.7 * extend, 0, 0]);

  for (let i = 0; i < 4; i++) {
    pose[`tail${i + 1}`] = { euler: [-0.25 * extend + 0.2 * squash, 0.05 * Math.sin(u * TAU + i), 0] };
  }
  return pose;
}

const CLIPS = [
  { name: 'idle', duration: 2.8, fps: 20, pose: idlePose },
  { name: 'walk', duration: 0.85, fps: 26, pose: walkPose },
  { name: 'run', duration: 0.52, fps: 30, pose: runPose },
  { name: 'jump', duration: 0.95, fps: 30, pose: jumpPose, loop: false },
];

function eulerToQuat([x, y, z]) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function main() {
  const started = Date.now();
  // 150 samples puts the cell size around 9mm on a 1.2m character, which
  // resolves the ear taper and the tail notches without spending 100k triangles
  // on a model that is usually a few hundred pixels tall.
  const resolution = Number(process.env.CHAR_RES || 150);

  console.log(`[character] meshing implicit surface at ${resolution} samples/longest axis`);
  const bounds = { min: [-0.40, -0.04, -0.70], max: [0.40, 1.28, 0.34] };
  const surface = surfaceNets(shape, { ...bounds, resolution });
  console.log(
    `[character] surface: ${surface.positions.length / 3} verts, ${surface.indices.length / 3} tris`,
  );

  const mesh = createMesh();
  for (let i = 0; i < surface.positions.length; i += 3) {
    const x = surface.positions[i];
    const y = surface.positions[i + 1];
    const z = surface.positions[i + 2];
    mesh.positions.push(x, y, z);
    mesh.normals.push(surface.normals[i], surface.normals[i + 1], surface.normals[i + 2]);
    const c = surfaceColor(x, y, z);
    mesh.colors.push(c[0], c[1], c[2]);
    const { joints, weights } = skinWeights(x, y, z);
    mesh.joints.push(...joints);
    mesh.weights.push(...weights);
  }
  // Spreading here would overflow the call stack at this element count.
  for (let i = 0; i < surface.indices.length; i++) mesh.indices.push(surface.indices[i]);

  addFace(mesh);
  console.log(`[character] with face features: ${mesh.positions.length / 3} verts, ${mesh.indices.length / 3} tris`);

  // ---- assemble glTF
  const gltf = new GLTFBuilder();

  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const colors = new Uint8Array(mesh.colors.map((c) => Math.round(clamp(srgbToLinear(c), 0, 1) * 255)));
  const colors4 = new Uint8Array((colors.length / 3) * 4);
  for (let i = 0, j = 0; i < colors.length; i += 3, j += 4) {
    colors4[j] = colors[i];
    colors4[j + 1] = colors[i + 1];
    colors4[j + 2] = colors[i + 2];
    colors4[j + 3] = 255;
  }
  const joints = new Uint8Array(mesh.joints);
  const weights = new Float32Array(mesh.weights);
  const indices = new Uint32Array(mesh.indices);

  const material = gltf.addMaterial({
    name: 'character',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0.0,
      roughnessFactor: 0.72,
    },
  });

  const meshIndex = gltf.addMesh({
    name: 'character',
    primitives: [{
      attributes: {
        POSITION: gltf.addVertexAccessor(positions, 'VEC3', { computeBounds: true }),
        NORMAL: gltf.addVertexAccessor(normals, 'VEC3'),
        COLOR_0: gltf.addVertexAccessor(colors4, 'VEC4', { normalized: true }),
        JOINTS_0: gltf.addVertexAccessor(joints, 'VEC4'),
        WEIGHTS_0: gltf.addVertexAccessor(weights, 'VEC4'),
      },
      indices: gltf.addIndexAccessor(indices),
      material,
    }],
  });

  // Bone nodes. Local translation is the offset from the parent's rest position.
  const nodeOf = BONES.map(() => 0);
  BONES.forEach((bone, i) => {
    const parentPos = bone.parent >= 0 ? BONES[bone.parent].pos : [0, 0, 0];
    nodeOf[i] = gltf.addNode({
      name: bone.name,
      translation: [
        bone.pos[0] - parentPos[0],
        bone.pos[1] - parentPos[1],
        bone.pos[2] - parentPos[2],
      ],
      rotation: [0, 0, 0, 1],
    });
  });
  BONES.forEach((bone, i) => {
    if (bone.parent < 0) return;
    const parent = gltf.json.nodes[nodeOf[bone.parent]];
    (parent.children ||= []).push(nodeOf[i]);
  });

  // Rest pose has no rotation, so the inverse bind matrix is a pure negative
  // translation (column-major, per the glTF convention).
  const ibm = new Float32Array(BONES.length * 16);
  BONES.forEach((bone, i) => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.pos[0], -bone.pos[1], -bone.pos[2], 1];
    ibm.set(m, i * 16);
  });

  const skin = gltf.addSkin({
    name: 'rig',
    joints: nodeOf,
    skeleton: nodeOf[0],
    inverseBindMatrices: gltf.addAccessor(ibm, 'MAT4'),
  });

  const meshNode = gltf.addNode({ name: 'characterMesh', mesh: meshIndex, skin });
  gltf.addSceneNode(nodeOf[0]);
  gltf.addSceneNode(meshNode);

  // ---- animations
  for (const clip of CLIPS) {
    const frameCount = Math.max(2, Math.round(clip.duration * clip.fps) + 1);
    const times = new Float32Array(frameCount);
    const rotationTracks = new Map();
    const translationTracks = new Map();

    for (let f = 0; f < frameCount; f++) {
      const u = f / (frameCount - 1);
      times[f] = u * clip.duration;
      const pose = clip.pose(clip.loop === false ? u : u % 1);

      for (const [boneName, value] of Object.entries(pose)) {
        const boneIdx = BONE_INDEX[boneName];
        if (boneIdx === undefined) throw new Error(`clip ${clip.name} targets unknown bone ${boneName}`);

        if (value.euler) {
          if (!rotationTracks.has(boneIdx)) rotationTracks.set(boneIdx, new Float32Array(frameCount * 4));
          rotationTracks.get(boneIdx).set(eulerToQuat(value.euler), f * 4);
        }
        if (value.offset) {
          if (!translationTracks.has(boneIdx)) translationTracks.set(boneIdx, new Float32Array(frameCount * 3));
          const bone = BONES[boneIdx];
          const parentPos = bone.parent >= 0 ? BONES[bone.parent].pos : [0, 0, 0];
          translationTracks.get(boneIdx).set([
            bone.pos[0] - parentPos[0] + value.offset[0],
            bone.pos[1] - parentPos[1] + value.offset[1],
            bone.pos[2] - parentPos[2] + value.offset[2],
          ], f * 3);
        }
      }
    }

    const timeAccessor = gltf.addAccessor(times, 'SCALAR');
    const samplers = [];
    const channels = [];

    for (const [boneIdx, data] of rotationTracks) {
      samplers.push({ input: timeAccessor, output: gltf.addAccessor(data, 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[boneIdx], path: 'rotation' } });
    }
    for (const [boneIdx, data] of translationTracks) {
      samplers.push({ input: timeAccessor, output: gltf.addAccessor(data, 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[boneIdx], path: 'translation' } });
    }

    gltf.addAnimation({ name: clip.name, samplers, channels });
    console.log(`[character] clip "${clip.name}": ${frameCount} frames, ${channels.length} channels`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'character.glb');
  const glb = gltf.toGLB();
  fs.writeFileSync(outPath, glb);

  console.log(
    `[character] wrote ${path.relative(process.cwd(), outPath)} `
    + `(${(glb.length / 1024).toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main();
