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

/** Round to a fixed number of decimals, avoiding float noise like 299.99999. */
export function round(v, decimals = 2) {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}
