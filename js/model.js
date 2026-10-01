// Plan data model and geometry operations. No DOM: runs in the browser and under node.
// Units are centimetres. Plan coordinates: x to the right, y downwards (screen-like).
//
//   nodes:    { id, x, y }
//   walls:    { id, a: nodeId, b: nodeId, thickness, height }
//   openings: { id, wallId, type, t /* centre offset along wall, cm from node a */, width, swing? }

import {
  sub, add, scale, dist, perp, normalize, projectOnSegment, lineIntersect, angleOf, snap, clamp, EPS,
} from './geometry.js';
import { WALL_DEFAULTS, MIN_OPENING_WIDTH, OPENING_TYPES, isOpeningType } from './catalog.js';

export const NODE_SNAP_RADIUS = 10; // cm
export const MIN_SPLIT_SEGMENT = 1; // cm, the shortest piece splitWall will create

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export class Model {
  constructor(data) {
    this.listeners = new Set();
    this._batch = 0;
    this._pending = false;
    this.reset();
    if (data) this.load(data, { emit: false });
  }

  reset() {
    this.nodes = [];
    this.walls = [];
    this.openings = [];
    this.nextId = 1;
  }

  clear() {
    this.reset();
    this.emit();
  }

  // ---------------------------------------------------------------- events

  /** Subscribe to 'change'. Returns an unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    if (this._batch > 0) { this._pending = true; return; }
    for (const fn of this.listeners) fn(this);
  }

  /** Run fn with change events coalesced into a single emit at the end. */
  batch(fn) {
    this._batch++;
    try { return fn(); } finally {
      this._batch--;
      if (this._batch === 0 && this._pending) { this._pending = false; this.emit(); }
    }
  }

  newId(prefix) {
    return `${prefix}${this.nextId++}`;
  }

  // ---------------------------------------------------------------- serialisation

  toJSON() {
    return {
      version: 1,
      nextId: this.nextId,
      nodes: this.nodes.map((n) => ({ ...n })),
      walls: this.walls.map((w) => ({ ...w })),
      openings: this.openings.map((o) => ({ ...o })),
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON());
  }

  /** Replace the model with `data` (object or JSON string). Invalid entries are dropped. */
  load(data, { emit = true } = {}) {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    if (!d || typeof d !== 'object') throw new Error('Plan data must be an object');
    const nodes = [];
    const walls = [];
    const openings = [];
    const ids = new Set();
    for (const n of Array.isArray(d.nodes) ? d.nodes : []) {
      if (!n || n.id == null || ids.has(String(n.id))) continue;
      const x = num(n.x, NaN), y = num(n.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ids.add(String(n.id));
      nodes.push({ id: String(n.id), x, y });
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const w of Array.isArray(d.walls) ? d.walls : []) {
      if (!w || w.id == null || ids.has(String(w.id))) continue;
      const a = String(w.a), b = String(w.b);
      if (!nodeIds.has(a) || !nodeIds.has(b) || a === b) continue;
      ids.add(String(w.id));
      walls.push({
        id: String(w.id), a, b,
        thickness: clamp(num(w.thickness, WALL_DEFAULTS.thickness), 1, 200),
        height: clamp(num(w.height, WALL_DEFAULTS.height), 10, 2000),
      });
    }
    const wallIds = new Set(walls.map((w) => w.id));
    for (const o of Array.isArray(d.openings) ? d.openings : []) {
      if (!o || o.id == null || ids.has(String(o.id))) continue;
      if (!wallIds.has(String(o.wallId)) || !isOpeningType(o.type)) continue;
      ids.add(String(o.id));
      const op = {
        id: String(o.id), wallId: String(o.wallId), type: o.type,
        t: num(o.t, 0),
        width: Math.max(MIN_OPENING_WIDTH, num(o.width, OPENING_TYPES[o.type].width)),
      };
      if (o.swing != null) op.swing = (num(o.swing, 0) | 0) & 3;
      openings.push(op);
    }
    let maxId = 0;
    for (const id of ids) {
      const m = /(\d+)$/.exec(id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
    }
    this.nodes = nodes;
    this.walls = walls;
    this.openings = openings;
    this.nextId = Math.max(num(d.nextId, 1), maxId + 1);
    for (const w of this.walls) this.clampWallOpenings(w.id);
    if (emit) this.emit();
    return this;
  }

  // ---------------------------------------------------------------- lookups

  getNode(id) { return this.nodes.find((n) => n.id === id) || null; }
  getWall(id) { return this.walls.find((w) => w.id === id) || null; }
  getOpening(id) { return this.openings.find((o) => o.id === id) || null; }

  getEntity(kind, id) {
    if (kind === 'node') return this.getNode(id);
    if (kind === 'wall') return this.getWall(id);
    if (kind === 'opening') return this.getOpening(id);
    return null;
  }

  wallsAtNode(nodeId) { return this.walls.filter((w) => w.a === nodeId || w.b === nodeId); }
  openingsOnWall(wallId) { return this.openings.filter((o) => o.wallId === wallId); }

  _wall(w) { return typeof w === 'string' ? this.getWall(w) : w; }

  wallEnds(w) {
    w = this._wall(w);
    return { a: this.getNode(w.a), b: this.getNode(w.b) };
  }

  wallLength(w) {
    const { a, b } = this.wallEnds(w);
    return dist(a, b);
  }

  /** Unit direction from node a to node b. */
  wallDir(w) {
    const { a, b } = this.wallEnds(w);
    return normalize(sub(b, a));
  }

  /** Point `along` cm from node a, on the wall's centre line. */
  pointOnWall(w, along) {
    const { a } = this.wallEnds(w);
    return add(a, scale(this.wallDir(w), along));
  }

  /** Projection of p onto wall w (see geometry.projectOnSegment). */
  projectOnWall(w, p) {
    const { a, b } = this.wallEnds(w);
    return projectOnSegment(p, a, b);
  }

  wallBetween(n1, n2) {
    return this.walls.find((w) => (w.a === n1 && w.b === n2) || (w.a === n2 && w.b === n1)) || null;
  }

  /** Nearest node within radius of p (excluding excludeId), or null. */
  nodeNear(p, radius = NODE_SNAP_RADIUS, excludeId = null) {
    let best = null, bestD = radius + EPS;
    for (const n of this.nodes) {
      if (n.id === excludeId) continue;
      const d = dist(n, p);
      if (d <= bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /** Nearest wall to p whose centre line is within maxDist. Returns { wall, proj } or null. */
  nearestWall(p, maxDist = Infinity, exclude = null) {
    let best = null;
    for (const w of this.walls) {
      if (exclude && exclude.has && exclude.has(w.id)) continue;
      const proj = this.projectOnWall(w, p);
      if (proj.dist <= maxDist && (!best || proj.dist < best.proj.dist)) best = { wall: w, proj };
    }
    return best;
  }

  bounds() {
    if (!this.nodes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
    }
    let maxH = 0;
    for (const w of this.walls) maxH = Math.max(maxH, w.height);
    return { minX, minY, maxX, maxY, maxHeight: maxH || WALL_DEFAULTS.height };
  }

  // ---------------------------------------------------------------- nodes & walls

  addNode(x, y) {
    const n = { id: this.newId('n'), x, y };
    this.nodes.push(n);
    return n;
  }

  /**
   * Return an existing node within `radius` of p, or (with splitWalls) a new node made by
   * splitting a wall that passes through p, or else a brand new node.
   */
  getOrCreateNode(p, radius = NODE_SNAP_RADIUS, { splitWalls = false } = {}) {
    const near = this.nodeNear(p, radius);
    if (near) return near;
    if (splitWalls) {
      for (const w of this.walls) {
        const proj = this.projectOnWall(w, p);
        if (proj.dist <= Math.max(w.thickness / 2, radius) &&
            proj.along > MIN_SPLIT_SEGMENT && proj.along < proj.length - MIN_SPLIT_SEGMENT) {
          const res = this._split(w, proj.along);
          if (res) return res.node;
        }
      }
    }
    return this.addNode(p.x, p.y);
  }

  /**
   * Add a wall from p1 to p2, reusing nodes within the snap radius.
   * Returns the new (or already existing identical) wall, or null if it would have zero length.
   */
  addWall(p1, p2, opts = {}) {
    const radius = opts.snapRadius ?? NODE_SNAP_RADIUS;
    if (dist(p1, p2) < EPS) return null;
    return this.batch(() => {
      const na = this.getOrCreateNode(p1, radius, opts);
      const nb = this.getOrCreateNode(p2, radius, opts);
      if (na === nb) { this.pruneOrphanNodes(); this.emit(); return null; }
      const existing = this.wallBetween(na.id, nb.id);
      if (existing) { this.emit(); return existing; }
      const w = {
        id: this.newId('w'), a: na.id, b: nb.id,
        thickness: opts.thickness ?? WALL_DEFAULTS.thickness,
        height: opts.height ?? WALL_DEFAULTS.height,
      };
      this.walls.push(w);
      this.emit();
      return w;
    });
  }

  moveNode(id, x, y) {
    const n = this.getNode(id);
    if (!n) return false;
    n.x = x; n.y = y;
    for (const w of this.wallsAtNode(id)) this.clampWallOpenings(w.id);
    this.emit();
    return true;
  }

  /** Translate a wall (both nodes) by dx, dy. Connected walls stretch. */
  moveWall(id, dx, dy) {
    const w = this.getWall(id);
    if (!w) return false;
    for (const nid of [w.a, w.b]) {
      const n = this.getNode(nid);
      n.x += dx; n.y += dy;
    }
    const touched = new Set([...this.wallsAtNode(w.a), ...this.wallsAtNode(w.b)]);
    for (const tw of touched) this.clampWallOpenings(tw.id);
    this.emit();
    return true;
  }

  /** Merge node srcId into dstId: walls are re-attached, degenerate and duplicate walls removed. */
  mergeNodes(srcId, dstId) {
    if (srcId === dstId) return false;
    const src = this.getNode(srcId), dst = this.getNode(dstId);
    if (!src || !dst) return false;
    for (const w of this.walls) {
      if (w.a === srcId) w.a = dstId;
      if (w.b === srcId) w.b = dstId;
    }
    // Walls that collapsed to a point.
    for (const w of this.walls.filter((x) => x.a === x.b)) this._removeWall(w.id);
    // Duplicate walls between the same pair of nodes: keep the first, move openings across.
    const seen = new Map();
    for (const w of [...this.walls]) {
      const key = [w.a, w.b].sort().join('|');
      const keep = seen.get(key);
      if (!keep) { seen.set(key, w); continue; }
      const L = this.wallLength(keep);
      for (const o of this.openingsOnWall(w.id)) {
        o.wallId = keep.id;
        if (w.a !== keep.a) o.t = L - o.t;
      }
      this.walls = this.walls.filter((x) => x !== w);
      for (const o of this.openingsOnWall(keep.id)) {
        if (this.fitOpening(keep.id, o.t, o.width, o.id) == null) this._removeOpening(o.id);
      }
    }
    this.nodes = this.nodes.filter((n) => n.id !== srcId);
    for (const w of this.wallsAtNode(dstId)) this.clampWallOpenings(w.id);
    this.pruneOrphanNodes();
    this.emit();
    return true;
  }

  /** If another node lies within radius of node `id`, merge `id` into it. Returns the surviving id or null. */
  mergeNodeIfNear(id, radius = NODE_SNAP_RADIUS) {
    const n = this.getNode(id);
    if (!n) return null;
    const other = this.nodeNear(n, radius, id);
    if (!other) return null;
    this.mergeNodes(id, other.id);
    return other.id;
  }

  /**
   * Split wall `id` at the projection of `point`. With opts.snap (cm step) the split position is
   * snapped along the wall. Returns { node, walls: [w1, w2] } or null.
   */
  splitWall(id, point, opts = {}) {
    const w = this.getWall(id);
    if (!w) return null;
    const proj = this.projectOnWall(w, point);
    let along = proj.along;
    if (opts.snap) along = snap(along, opts.snap);
    const res = this._split(w, along);
    if (res) this.emit();
    return res;
  }

  _split(w, along) {
    const L = this.wallLength(w);
    if (along < MIN_SPLIT_SEGMENT || along > L - MIN_SPLIT_SEGMENT) return null;
    const p = this.pointOnWall(w, along);
    const node = this.addNode(p.x, p.y);
    const w1 = { id: this.newId('w'), a: w.a, b: node.id, thickness: w.thickness, height: w.height };
    const w2 = { id: this.newId('w'), a: node.id, b: w.b, thickness: w.thickness, height: w.height };
    const idx = this.walls.indexOf(w);
    this.walls.splice(idx, 1, w1, w2);
    for (const o of this.openingsOnWall(w.id)) {
      if (o.t < along) o.wallId = w1.id;
      else { o.wallId = w2.id; o.t -= along; }
    }
    this.clampWallOpenings(w1.id, { allowShrink: true });
    this.clampWallOpenings(w2.id, { allowShrink: true });
    return { node, walls: [w1, w2] };
  }

  updateWall(id, props = {}) {
    const w = this.getWall(id);
    if (!w) return false;
    if (props.thickness != null && Number.isFinite(+props.thickness)) w.thickness = clamp(+props.thickness, 1, 200);
    if (props.height != null && Number.isFinite(+props.height)) w.height = clamp(+props.height, 10, 2000);
    this.clampWallOpenings(id);
    this.emit();
    return true;
  }

  /** Remove nodes that no wall references. */
  pruneOrphanNodes() {
    const used = new Set();
    for (const w of this.walls) { used.add(w.a); used.add(w.b); }
    this.nodes = this.nodes.filter((n) => used.has(n.id));
  }

  _removeWall(id) {
    this.openings = this.openings.filter((o) => o.wallId !== id);
    this.walls = this.walls.filter((w) => w.id !== id);
  }

  _removeOpening(id) {
    this.openings = this.openings.filter((o) => o.id !== id);
  }

  /** Delete a node (with its walls), a wall (with its openings), or an opening. */
  deleteEntity(kind, id) {
    if (!this.getEntity(kind, id)) return false;
    if (kind === 'opening') {
      this._removeOpening(id);
    } else if (kind === 'wall') {
      this._removeWall(id);
      this.pruneOrphanNodes();
    } else if (kind === 'node') {
      for (const w of this.wallsAtNode(id)) this._removeWall(w.id);
      this.nodes = this.nodes.filter((n) => n.id !== id);
      this.pruneOrphanNodes();
    }
    this.emit();
    return true;
  }

  // ---------------------------------------------------------------- openings

  /** Free intervals [lo, hi] along the wall not taken by other openings. */
  freeGaps(wallId, excludeId = null) {
    const L = this.wallLength(wallId);
    const others = this.openingsOnWall(wallId)
      .filter((o) => o.id !== excludeId)
      .map((o) => [o.t - o.width / 2, o.t + o.width / 2])
      .sort((p, q) => p[0] - q[0]);
    const gaps = [];
    let cursor = 0;
    for (const [s, e] of others) {
      if (s > cursor) gaps.push({ lo: cursor, hi: Math.min(s, L) });
      cursor = Math.max(cursor, e);
    }
    if (L > cursor) gaps.push({ lo: cursor, hi: L });
    return gaps;
  }

  /**
   * Nearest centre offset to `t` where an opening of `width` fits on the wall without leaving it
   * or overlapping another opening. Returns null if there is no room.
   */
  fitOpening(wallId, t, width, excludeId = null) {
    let best = null, bestD = Infinity;
    for (const g of this.freeGaps(wallId, excludeId)) {
      if (g.hi - g.lo + EPS < width) continue;
      const tc = clamp(t, g.lo + width / 2, g.hi - width / 2);
      const d = Math.abs(tc - t);
      if (d < bestD) { best = tc; bestD = d; }
    }
    return best;
  }

  addOpening(wallId, type, t, width) {
    if (!isOpeningType(type) || !this.getWall(wallId)) return null;
    width = Math.max(MIN_OPENING_WIDTH, width ?? OPENING_TYPES[type].width);
    const tFit = this.fitOpening(wallId, t, width);
    if (tFit == null) return null;
    const o = { id: this.newId('o'), wallId, type, t: tFit, width };
    if (type === 'door') o.swing = 0;
    this.openings.push(o);
    this.emit();
    return o;
  }

  /** Slide an opening to `t` on `wallId` (default: its current wall). Returns false if it cannot fit. */
  moveOpening(id, t, wallId) {
    const o = this.getOpening(id);
    if (!o) return false;
    wallId = wallId ?? o.wallId;
    if (!this.getWall(wallId)) return false;
    const tFit = this.fitOpening(wallId, t, o.width, id);
    if (tFit == null) return false;
    o.wallId = wallId;
    o.t = tFit;
    this.emit();
    return true;
  }

  /**
   * Resize an opening. anchor: 'center' (symmetric), 'start' (keep the edge nearest node a)
   * or 'end' (keep the edge nearest node b). Clamped by the wall ends and neighbouring openings.
   */
  resizeOpening(id, width, anchor = 'center') {
    const o = this.getOpening(id);
    if (!o || !Number.isFinite(+width)) return false;
    width = Math.max(MIN_OPENING_WIDTH, +width);
    const gaps = this.freeGaps(o.wallId, id);
    const L = this.wallLength(o.wallId);
    const gap = gaps.find((g) => o.t >= g.lo - EPS && o.t <= g.hi + EPS) || { lo: 0, hi: L };
    let t = o.t, w;
    if (anchor === 'start') {
      const s = Math.max(gap.lo, o.t - o.width / 2);
      w = Math.min(width, gap.hi - s);
      t = s + w / 2;
    } else if (anchor === 'end') {
      const e = Math.min(gap.hi, o.t + o.width / 2);
      w = Math.min(width, e - gap.lo);
      t = e - w / 2;
    } else {
      w = Math.min(width, 2 * Math.min(o.t - gap.lo, gap.hi - o.t));
    }
    if (w < MIN_OPENING_WIDTH - EPS) return false;
    o.width = w;
    o.t = t;
    this.emit();
    return true;
  }

  updateOpening(id, props = {}) {
    const o = this.getOpening(id);
    if (!o) return false;
    return this.batch(() => {
      if (props.type && isOpeningType(props.type) && props.type !== o.type) {
        o.type = props.type;
        if (o.type === 'door' && o.swing == null) o.swing = 0;
      }
      if (props.swing != null) o.swing = (props.swing | 0) & 3;
      if (props.width != null) this.resizeOpening(id, props.width, 'center');
      this.emit();
      return true;
    });
  }

  /**
   * Keep every opening of the wall inside it and free of overlaps. Openings that do not fit are
   * left centred (opts.allowShrink narrows them to the largest free gap if possible).
   */
  clampWallOpenings(wallId, { allowShrink = false } = {}) {
    const w = this.getWall(wallId);
    if (!w) return;
    const L = this.wallLength(w);
    const list = this.openingsOnWall(wallId).sort((p, q) => p.t - q.t);
    // Re-place one by one against the already placed ones, so earlier ones win.
    const placed = new Set();
    for (const o of list) {
      const savedOthers = this.openings;
      this.openings = this.openings.filter((x) => x.wallId !== wallId || placed.has(x.id) || x.id === o.id);
      let t = this.fitOpening(wallId, o.t, o.width, o.id);
      if (t == null && allowShrink) {
        const gaps = this.freeGaps(wallId, o.id).filter((g) => g.hi - g.lo >= MIN_OPENING_WIDTH);
        if (gaps.length) {
          const g = gaps.reduce((p, q) => (q.hi - q.lo > p.hi - p.lo ? q : p));
          o.width = g.hi - g.lo;
          t = (g.lo + g.hi) / 2;
        }
      }
      this.openings = savedOthers;
      if (t != null) o.t = t;
      else o.t = o.width >= L ? L / 2 : clamp(o.t, o.width / 2, L - o.width / 2);
      placed.add(o.id);
    }
  }

  clampAll() {
    for (const w of this.walls) this.clampWallOpenings(w.id);
    this.emit();
  }
}

// -------------------------------------------------------------------- mitred wall outlines

/**
 * Compute the 2D outline of every wall with mitred joins at shared nodes.
 * Returns Map wallId -> { aPlus, bPlus, bMinus, aMinus, u, n, length } where "plus" is the side
 * the wall normal n = perp(u) points to and u is the unit direction a -> b.
 * The polygon in order is [aPlus, bPlus, bMinus, aMinus].
 */
export function computeWallPolygons(model) {
  const out = new Map();
  const ends = new Map(); // nodeId -> [{ wall, dir (outward), half, atA }]
  for (const w of model.walls) {
    const { a, b } = model.wallEnds(w);
    const u = normalize(sub(b, a));
    const n = perp(u);
    out.set(w.id, { u, n, length: dist(a, b), a, b });
    const h = w.thickness / 2;
    if (!ends.has(w.a)) ends.set(w.a, []);
    if (!ends.has(w.b)) ends.set(w.b, []);
    ends.get(w.a).push({ wall: w, dir: u, half: h, atA: true });
    ends.get(w.b).push({ wall: w, dir: scale(u, -1), half: h, atA: false });
  }
  for (const [nodeId, list] of ends) {
    const node = model.getNode(nodeId);
    list.sort((p, q) => angleOf(p.dir) - angleOf(q.dir));
    const k = list.length;
    for (let i = 0; i < k; i++) {
      const e = list[i];
      const left = perp(e.dir); // CCW side relative to the outward direction
      const leftLine = add(node, scale(left, e.half));
      const rightLine = add(node, scale(left, -e.half));
      let leftCorner = leftLine, rightCorner = rightLine;
      if (k > 1) {
        const next = list[(i + 1) % k];
        const prev = list[(i - 1 + k) % k];
        const nl = perp(next.dir), pl = perp(prev.dir);
        // Left edge of e meets right edge of the next wall (CCW order).
        const pL = lineIntersect(leftLine, e.dir, add(node, scale(nl, -next.half)), next.dir);
        // Right edge of e meets left edge of the previous wall.
        const pR = lineIntersect(rightLine, e.dir, add(node, scale(pl, prev.half)), prev.dir);
        const limit = Math.max(e.half, next.half, prev.half) * 4;
        if (pL && dist(pL, node) <= limit) leftCorner = pL;
        if (pR && dist(pR, node) <= limit) rightCorner = pR;
      }
      const rec = out.get(e.wall.id);
      // At node a the outward dir is u, so "left" is +n. At node b it is -u, so "left" is -n.
      if (e.atA) { rec.aPlus = leftCorner; rec.aMinus = rightCorner; }
      else { rec.bMinus = leftCorner; rec.bPlus = rightCorner; }
    }
  }
  return out;
}

// -------------------------------------------------------------------- undo / redo

/** Snapshot history of a model. Call commit() after each completed user action. */
export class History {
  constructor(model, limit = 200) {
    this.model = model;
    this.limit = limit;
    this.stack = [model.serialize()];
    this.index = 0;
  }

  /** Record the current state. Returns true if it differed from the last snapshot. */
  commit() {
    const snap = this.model.serialize();
    if (snap === this.stack[this.index]) return false;
    this.stack.length = this.index + 1;
    this.stack.push(snap);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  /** Forget the past and start from the current state (e.g. after "New" or import). */
  reset() {
    this.stack = [this.model.serialize()];
    this.index = 0;
  }

  canUndo() { return this.index > 0; }
  canRedo() { return this.index < this.stack.length - 1; }

  undo() {
    if (!this.canUndo()) return false;
    this.index--;
    this.model.load(this.stack[this.index]);
    return true;
  }

  redo() {
    if (!this.canRedo()) return false;
    this.index++;
    this.model.load(this.stack[this.index]);
    return true;
  }
}

/** A small sample room used when nothing is saved yet. */
export function createSampleModel() {
  const m = new Model();
  m.batch(() => {
    const pts = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }];
    const walls = pts.map((p, i) => m.addWall(p, pts[(i + 1) % pts.length]));
    m.addOpening(walls[0].id, 'window', 300);
    m.addOpening(walls[1].id, 'window_full', 200);
    m.addOpening(walls[2].id, 'door', 450);
    m.addOpening(walls[3].id, 'window_tall', 200);
  });
  return m;
}
