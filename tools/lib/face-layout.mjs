// Single source of truth for the face texture and the UVs that sample it.
//
// The texture generator and the mesh builder both read this table, so the
// drawing and the projection cannot drift apart — moving an eye here moves it
// in both places.

/** The body's base yellow, in sRGB. Everything else is expressed against it. */
export const SKIN = [1.000, 0.800, 0.090];

/**
 * Spherical projection of the head onto the texture.
 *
 * Direction from the head's centre becomes longitude and latitude, then those
 * map linearly into UV. A plain planar projection would smear badly towards the
 * cheeks, which sit ~40 degrees off centre; a spherical one keeps the face
 * roughly evenly spaced across the image.
 *
 *     lon = atan2(dir.x, dir.z)     0 straight ahead
 *     lat = asin(dir.y)
 *     u   = 0.5 + lon / lonSpan
 *     v   = 0.5 - (lat - latCentre) / latSpan
 *
 * Anything falling outside [0,1] is sent to `restUV` instead, a corner of the
 * texture that is plain skin — that is how the back of the head, the body and
 * the tail all end up untextured without needing a second material.
 */
export const FACE_PROJECTION = {
  // These spans decide how much of the head the drawn face covers. Too wide and
  // the features compress into a small cluster in the middle of the face; at
  // 2.9 the cheeks land around 43 degrees off centre, which matches the
  // reference. Because the texture is drawn in UV space, changing these rescales
  // the face on the head without redrawing anything.
  lonSpan: 2.45,
  latCentre: -0.09,
  latSpan: 1.65,
  // Hard bounds on where the projection may apply at all. Without them the
  // mapping reaches down the belly, where longitude wraps through +/-pi and
  // leaves a seam straight down the front of the character.
  maxLon: 1.15,
  minLat: -0.60,
  maxRadius: 1.28,
  restUV: [0.015, 0.015],

  // Positions are in UV space. The eyes sit at +/- eye.u, so the distance
  // between them is 2 * eye.u = 0.42, and every other feature below is sized
  // and placed as a fraction of that, matching how the reference was measured.
  layout: {
    eye: { u: 0.235, v: 0.375, rx: 0.095, ry: 0.112 },
    glint: { du: 0.030, dv: 0.038, rx: 0.036, ry: 0.036 },
    cheek: { u: 0.268, v: 0.615, r: 0.104 },
    mouth: {
      v: 0.645,
      rx: 0.145,
      ry: 0.115,
      // The notch in the upper lip is the INTERSECTION of two discs, not their
      // union. A union meets in a cusp that points up, which rounds the lip off
      // the wrong way; an intersection gives the downward point the reference
      // has. The lens it forms is bitten out of the top of the opening.
      biteU: 0.090,
      biteV: 0.177,
      biteR: 0.160,
    },
    nose: { v: 0.520, rx: 0.021, ry: 0.015 },
  },
};

/** Longitude and latitude of a point, relative to the head centre. */
export function faceUV(x, y, z, headCentre, headRadii) {
  const dx = (x - headCentre[0]) / headRadii[0];
  const dy = (y - headCentre[1]) / headRadii[1];
  const dz = (z - headCentre[2]) / headRadii[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return null;

  const lon = Math.atan2(dx / len, dz / len);
  const lat = Math.asin(Math.max(-1, Math.min(1, dy / len)));

  const { lonSpan, latCentre, latSpan, maxLon, minLat, maxRadius } = FACE_PROJECTION;
  // Off the head entirely, round the back, or below the chin.
  if (len > maxRadius || Math.abs(lon) > maxLon || lat < minLat) return null;
  const u = 0.5 + lon / lonSpan;
  const v = 0.5 - (lat - latCentre) / latSpan;

  // A margin inside the edge keeps bilinear filtering from reaching past the
  // border of the drawn region.
  if (u < 0.02 || u > 0.98 || v < 0.02 || v > 0.98) return null;
  return [u, v];
}
