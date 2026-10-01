// Small 2D vector helpers. Pure functions, no DOM. All units are centimetres.

export const GRID = 10;
export const EPS = 1e-6;

export const vec = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const length = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const perp = (a) => ({ x: -a.y, y: a.x });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const angleOf = (d) => Math.atan2(d.y, d.x);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalize(a) {
  const l = length(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Round a value to the nearest multiple of `step`. A step of 0 (or less) disables snapping. */
export function snap(value, step = GRID) {
  if (!(step > 0)) return value;
  const r = Math.round(value / step) * step;
  return Object.is(r, -0) ? 0 : r;
}

export function snapPoint(p, step = GRID) {
  return { x: snap(p.x, step), y: snap(p.y, step) };
}

/**
 * Project point p onto segment a-b.
 * Returns { t (0..1, clamped), rawT, point, dist, along (cm from a), length }.
 */
export function projectOnSegment(p, a, b) {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  const len = Math.sqrt(len2);
  const rawT = len2 < EPS ? 0 : dot(sub(p, a), ab) / len2;
  const t = clamp(rawT, 0, 1);
  const point = add(a, scale(ab, t));
  return { t, rawT, point, dist: dist(p, point), along: t * len, length: len };
}

export function distToSegment(p, a, b) {
  return projectOnSegment(p, a, b).dist;
}

/** Intersection of the lines p1 + s*d1 and p2 + s*d2, or null if parallel. */
export function lineIntersect(p1, d1, p2, d2) {
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return null;
  const s = cross(sub(p2, p1), d2) / den;
  return add(p1, scale(d1, s));
}

/** Signed area of a polygon (shoelace). Positive when the points run clockwise on screen (y down). */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) a += cross(pts[i], pts[(i + 1) % n]);
  return a / 2;
}

/** True if p lies inside the polygon (even-odd ray casting). Points exactly on an edge are unreliable. */
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Round to a fixed number of decimals, avoiding float noise like 299.99999. */
export function round(v, decimals = 2) {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

// -------------------------------------------------------------------- circular arcs
//
// A curved wall is a circular arc through its two nodes. The shape is one signed number, the
// sagitta ("bulge"): how far the middle of the arc sits off the middle of the chord, measured
// along perp(unit(b - a)). Zero is a straight wall. Everything below works on the record that
// arcFromChord builds, so straight and curved walls share one set of queries.

/** Longest segment used when an arc has to be turned into a polyline, in cm. */
export const ARC_SAMPLE = 20;

/**
 * Arc record for the chord a -> b with sagitta `bulge` (clamped to the chord length).
 * Straight: { curved: false, a, b, u, n, length }.
 * Curved:   { curved: true, a, b, u, n, length, bulge, centre, R, t0, sweep } where the arc runs
 * from angle t0 by `sweep` radians about `centre`.
 */
export function arcFromChord(a, b, bulge = 0) {
  const d = sub(b, a);
  const L = length(d);
  const u = L < EPS ? { x: 1, y: 0 } : scale(d, 1 / L);
  const n = perp(u);
  const s = Number.isFinite(+bulge) ? clamp(+bulge, -L, L) : 0;
  if (L < EPS || Math.abs(s) < 1e-4) return { curved: false, a, b, u, n, length: L };
  const mid = lerp(a, b, 0.5);
  const k = (s * s - (L * L) / 4) / (2 * s); // centre offset from the chord midpoint, along n
  const centre = add(mid, scale(n, k));
  const R = Math.abs(s - k);
  // Plan coordinates have y downwards, so a positive sagitta sweeps through decreasing angles.
  const sweep = -4 * Math.atan((2 * s) / L);
  return { curved: true, a, b, u, n, bulge: s, length: Math.abs(R * sweep), centre, R, t0: angleOf(sub(a, centre)), sweep };
}

/** The sagitta an arc with this chord length and sweep angle has (the inverse of arcFromChord). */
export function bulgeFromSweep(chordLength, sweep) {
  return -(chordLength / 2) * Math.tan(sweep / 4);
}

/** Point and unit tangent `along` cm from a, clamped to the ends. */
export function arcPointAt(arc, along) {
  if (!arc.curved) {
    return { point: add(arc.a, scale(arc.u, clamp(along, 0, arc.length))), tangent: arc.u };
  }
  const f = arc.length < EPS ? 0 : clamp(along, 0, arc.length) / arc.length;
  const ang = arc.t0 + arc.sweep * f;
  const radial = { x: Math.cos(ang), y: Math.sin(ang) };
  const tangent = arc.sweep >= 0 ? perp(radial) : scale(perp(radial), -1);
  return { point: add(arc.centre, scale(radial, arc.R)), tangent };
}

/**
 * Project p onto the arc, clamped to its ends. Returns { along, dist, point, rawT, length }.
 * rawT is the position as a fraction of the arc: outside 0..1 when p is past an end (negative
 * past the start), so callers can tell "beside the wall" from "past it" as they do for a segment.
 */
export function arcProject(arc, p) {
  if (!arc.curved) {
    const r = projectOnSegment(p, arc.a, arc.b);
    return { along: r.along, dist: r.dist, point: r.point, rawT: r.rawT, length: arc.length };
  }
  const TAU = Math.PI * 2;
  let delta = angleOf(sub(p, arc.centre)) - arc.t0;
  // Into [0, 2pi) when the sweep is positive, (-2pi, 0] when it is negative.
  delta = ((delta % TAU) + TAU) % TAU;
  if (arc.sweep < 0) delta -= TAU * (delta > 0 ? 1 : 0);
  let rawT = arc.sweep === 0 ? 0 : delta / arc.sweep;
  let t = clamp(rawT, 0, 1);
  if (rawT > 1) {
    // Past the end: the nearer end wins, and rawT keeps the sign that says which one.
    const nearStart = dist(p, arc.a) <= dist(p, arc.b);
    t = nearStart ? 0 : 1;
    if (nearStart) rawT = 1 - rawT;
  }
  const point = arcPointAt(arc, t * arc.length).point;
  return { along: t * arc.length, dist: dist(p, point), point, rawT, length: arc.length };
}

/** The arc as a polyline, including both ends. A straight arc gives its two ends. */
export function arcSamples(arc, maxSeg = ARC_SAMPLE) {
  if (!arc.curved) return [arc.a, arc.b];
  const n = Math.max(1, Math.ceil(arc.length / Math.max(1, maxSeg)));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(arcPointAt(arc, (arc.length * i) / n).point);
  return pts;
}

/** The path `d` cm to the perp(tangent) side of the arc (d < 0 for the other side). */
export function arcOffset(arc, d) {
  if (!arc.curved) {
    const o = scale(arc.n, d);
    return { curved: false, a: add(arc.a, o), b: add(arc.b, o), u: arc.u, n: arc.n, length: arc.length };
  }
  const R = Math.max(0.01, arc.R - Math.sign(arc.sweep) * d);
  const at = (ang) => add(arc.centre, { x: Math.cos(ang) * R, y: Math.sin(ang) * R });
  const a = at(arc.t0), b = at(arc.t0 + arc.sweep);
  return {
    curved: true, a, b, u: arc.u, n: arc.n, bulge: arc.bulge,
    length: Math.abs(R * arc.sweep), centre: arc.centre, R, t0: arc.t0, sweep: arc.sweep,
  };
}

/** Signed sagitta of the arc from a to b that passes through m. */
export function sagittaThrough(a, b, m) {
  const d = sub(b, a);
  const L = length(d);
  if (L < EPS) return 0;
  return dot(sub(m, lerp(a, b, 0.5)), perp(scale(d, 1 / L)));
}

/**
 * Sagittas that bend the segments of a polyline into a Catmull-Rom spline through its points:
 * one per segment, so pts.length - 1 of them. The spline's midpoint fixes each arc.
 */
export function splineBulges(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    // Uniform Catmull-Rom at t = 0.5.
    const mid = {
      x: 0.5625 * (p1.x + p2.x) - 0.0625 * (p0.x + p3.x),
      y: 0.5625 * (p1.y + p2.y) - 0.0625 * (p0.y + p3.y),
    };
    out.push(sagittaThrough(p1, p2, mid));
  }
  return out;
}
