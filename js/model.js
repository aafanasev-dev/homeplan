// Plan data model and geometry operations. No DOM: runs in the browser and under node.
// Units are centimetres. Plan coordinates: x to the right, y downwards (screen-like).
//
//
//   levels:   { id, name, height }  ordered bottom to top; elevations are computed (levelElevation)
//   nodes:    { id, x, y, level }
//   walls:    { id, a: nodeId, b: nodeId, thickness, height, level, bulge? }  both nodes are on `level`
//             bulge is the sagitta of a curved wall in cm: how far the middle of the arc sits off
//             the middle of the chord, along perp(unit(b - a)). Absent or 0 means a straight wall,
//             and openings measure `t` along the arc, so nothing else has to know the difference.
//   openings: { id, wallId, type, t /* centre offset along wall, cm from node a */, width, swing? }
//             openings take their level from their wall
//   floors:   { id, level, kind: 'slab' | 'cutout', points: [{x,y}], thickness }
//             a slab spans elevation - thickness .. elevation; a cutout is a hole punched in the
//             slabs of its own level (it is never built, in 2D or in 3D)
//   stairs:   { id, level, x, y, width, length, angle }  (x, y) is the start of the flight's centre
//             line; it runs `length` cm in direction `angle` (degrees, 0/90/180/270) up to the next level
//
// activeLevel is UI state: the level that editing queries default to. It is not part of toJSON(),
// so undo snapshots never record level switches.

import {
  sub, add, scale, dist, perp, normalize, lineIntersect, angleOf, snap, clamp,
  polygonArea, pointInPolygon, distToSegment, EPS,
  arcFromChord, arcPointAt, arcProject, arcSamples, arcOffset, bulgeFromSweep, ARC_SAMPLE,
} from './geometry.js';
import {
  WALL_DEFAULTS, FLOOR_DEFAULTS, STAIR_DEFAULTS, MIN_OPENING_WIDTH, OPENING_TYPES, isOpeningType,
  openingSpec,
} from './catalog.js';

export const NODE_SNAP_RADIUS = 10; // cm
export const MIN_SPLIT_SEGMENT = 1; // cm, the shortest piece splitWall will create

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Snap an angle in degrees to 0, 90, 180 or 270. */
const quarterTurn = (deg) => ((Math.round(num(+deg, 0) / 90) * 90) % 360 + 360) % 360;
const levelName = (i) => `Level ${i + 1}`;

/**
 * Copy of a floor outline with finite { x, y } points and no repeated consecutive points.
 * Returns null unless at least 3 points and a non-zero area remain.
 */
function cleanPolygon(points) {
  const out = [];
  for (const p of points) {
    const x = num(p?.x, NaN), y = num(p?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (out.length && dist(out[out.length - 1], { x, y }) < EPS) continue;
    out.push({ x, y });
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) < EPS) out.pop();
  if (out.length < 3 || Math.abs(polygonArea(out)) < 1) return null;
  return out;
}

export class Model {
  constructor(data) {
    this.listeners = new Set();
    this._batch = 0;
    this._pending = false;
    this.reset();
    if (data) { this.activeLevel = null; this.load(data, { emit: false }); }
  }

  /** Empty plan with a single level. */
  reset() {
    this.nextId = 1;
    this.levels = [{ id: this.newId('l'), name: levelName(0), height: WALL_DEFAULTS.height }];
    this.activeLevel = this.levels[0].id;
    this.nodes = [];
    this.walls = [];
    this.openings = [];
    this.floors = [];
    this.stairs = [];
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
      version: 2,
      nextId: this.nextId,
      levels: this.levels.map((l) => ({ ...l })),
      nodes: this.nodes.map((n) => ({ ...n })),
      walls: this.walls.map((w) => ({ ...w })),
      openings: this.openings.map((o) => ({ ...o })),
      floors: this.floors.map((f) => ({ ...f, points: f.points.map((p) => ({ x: p.x, y: p.y })) })),
      stairs: this.stairs.map((st) => ({ ...st })),
    };
  }

  serialize() {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Replace the model with `data` (object or JSON string). Invalid entries are dropped.
   * Version 1 data (no levels) is migrated: everything goes onto a single default level.
   * Entities without a level go onto the first level; entities on an unknown level are dropped.
   */
  load(data, { emit = true } = {}) {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    if (!d || typeof d !== 'object') throw new Error('Plan data must be an object');
    const list = (v) => (Array.isArray(v) ? v : []);
    const levels = [];
    const nodes = [];
    const walls = [];
    const openings = [];
    const floors = [];
    const stairs = [];
    const ids = new Set();
    for (const l of list(d.levels)) {
      if (!l || l.id == null || ids.has(String(l.id))) continue;
      ids.add(String(l.id));
      const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : levelName(levels.length);
      levels.push({ id: String(l.id), name, height: clamp(num(l.height, WALL_DEFAULTS.height), 10, 2000) });
    }
    if (!levels.length) {
      // v1 data: one default level, with an id that no other entity uses.
      const taken = new Set();
      for (const key of ['nodes', 'walls', 'openings', 'floors', 'stairs']) {
        for (const e of list(d[key])) if (e && e.id != null) taken.add(String(e.id));
      }
      let k = 1;
      while (taken.has(`l${k}`)) k++;
      ids.add(`l${k}`);
      levels.push({ id: `l${k}`, name: levelName(0), height: WALL_DEFAULTS.height });
    }
    const levelIds = new Set(levels.map((l) => l.id));
    // Missing level -> first level (migration); a level that does not exist -> null (dropped).
    const levelOf = (e) => (e.level == null ? levels[0].id : levelIds.has(String(e.level)) ? String(e.level) : null);

    for (const n of list(d.nodes)) {
      if (!n || n.id == null || ids.has(String(n.id))) continue;
      const x = num(n.x, NaN), y = num(n.y, NaN);
      const level = levelOf(n);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !level) continue;
      ids.add(String(n.id));
      nodes.push({ id: String(n.id), x, y, level });
    }
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const w of list(d.walls)) {
      if (!w || w.id == null || ids.has(String(w.id))) continue;
      const a = String(w.a), b = String(w.b);
      const na = nodeById.get(a), nb = nodeById.get(b);
      if (!na || !nb || a === b || na.level !== nb.level) continue;
      ids.add(String(w.id));
      const wall = {
        id: String(w.id), a, b,
        thickness: clamp(num(w.thickness, WALL_DEFAULTS.thickness), 1, 200),
        height: clamp(num(w.height, WALL_DEFAULTS.height), 10, 2000),
        level: na.level,
      };
      const chord = dist(na, nb);
      const bulge = clamp(num(w.bulge, 0), -chord, chord);
      if (Math.abs(bulge) >= 1e-4) wall.bulge = bulge;
      walls.push(wall);
    }
    const wallIds = new Set(walls.map((w) => w.id));
    for (const o of list(d.openings)) {
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
    for (const f of list(d.floors)) {
      if (!f || f.id == null || ids.has(String(f.id))) continue;
      const level = levelOf(f);
      const points = cleanPolygon(list(f.points));
      if (!level || !points) continue;
      ids.add(String(f.id));
      floors.push({
        id: String(f.id), level, kind: f.kind === 'cutout' ? 'cutout' : 'slab', points,
        thickness: clamp(num(f.thickness, FLOOR_DEFAULTS.thickness), 1, 200),
      });
    }
    for (const st of list(d.stairs)) {
      if (!st || st.id == null || ids.has(String(st.id))) continue;
      const x = num(st.x, NaN), y = num(st.y, NaN);
      const level = levelOf(st);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !level) continue;
      ids.add(String(st.id));
      stairs.push({
        id: String(st.id), level, x, y,
        width: clamp(num(st.width, STAIR_DEFAULTS.width), 30, 1000),
        length: clamp(num(st.length, STAIR_DEFAULTS.length), 50, 2000),
        angle: quarterTurn(st.angle),
      });
    }
    let maxId = 0;
    for (const id of ids) {
      const m = /(\d+)$/.exec(id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
    }
    this.levels = levels;
    this.nodes = nodes;
    this.walls = walls;
    this.openings = openings;
    this.floors = floors;
    this.stairs = stairs;
    this.nextId = Math.max(num(d.nextId, 1), maxId + 1);
    if (!levelIds.has(this.activeLevel)) this.activeLevel = levels[0].id;
    for (const w of this.walls) this.clampWallOpenings(w.id);
    if (emit) this.emit();
    return this;
  }

  // ---------------------------------------------------------------- lookups

  getNode(id) { return this.nodes.find((n) => n.id === id) || null; }
  getWall(id) { return this.walls.find((w) => w.id === id) || null; }
  getOpening(id) { return this.openings.find((o) => o.id === id) || null; }
  getFloor(id) { return this.floors.find((f) => f.id === id) || null; }
  getStairs(id) { return this.stairs.find((s) => s.id === id) || null; }
  getLevel(id) { return this.levels.find((l) => l.id === id) || null; }

  getEntity(kind, id) {
    if (kind === 'node') return this.getNode(id);
    if (kind === 'wall') return this.getWall(id);
    if (kind === 'opening') return this.getOpening(id);
    if (kind === 'floor') return this.getFloor(id);
    if (kind === 'stairs') return this.getStairs(id);
    return null;
  }

  /** Level an entity belongs to (openings take it from their wall), or null. */
  levelOfEntity(kind, id) {
    const e = this.getEntity(kind, id);
    if (!e) return null;
    if (kind === 'opening') return this.getWall(e.wallId)?.level ?? null;
    return e.level ?? null;
  }

  wallsAtNode(nodeId) { return this.walls.filter((w) => w.a === nodeId || w.b === nodeId); }
  openingsOnWall(wallId) { return this.openings.filter((o) => o.wallId === wallId); }

  _wall(w) { return typeof w === 'string' ? this.getWall(w) : w; }

  wallEnds(w) {
    w = this._wall(w);
    return { a: this.getNode(w.a), b: this.getNode(w.b) };
  }

  /** The wall's centre line as an arc record (straight when it has no bulge). */
  wallArc(w) {
    w = this._wall(w);
    const { a, b } = this.wallEnds(w);
    return arcFromChord(a, b, w.bulge || 0);
  }

  /** Length of the centre line: the chord for a straight wall, the arc length for a curved one. */
  wallLength(w) {
    return this.wallArc(w).length;
  }

  /** Unit direction of the chord, from node a to node b. */
  wallDir(w) {
    const { a, b } = this.wallEnds(w);
    return normalize(sub(b, a));
  }

  /** Unit tangent of the wall `along` cm from node a. A straight wall has one tangent everywhere. */
  wallDirAt(w, along) {
    return arcPointAt(this.wallArc(w), along).tangent;
  }

  /** Point `along` cm from node a, on the wall's centre line. */
  pointOnWall(w, along) {
    return arcPointAt(this.wallArc(w), along).point;
  }

  /** Projection of p onto wall w (see geometry.arcProject / projectOnSegment). */
  projectOnWall(w, p) {
    return arcProject(this.wallArc(w), p);
  }

  /** The wall's centre line as a polyline: two points when straight, the sampled arc when curved. */
  wallSamples(w, maxSeg = ARC_SAMPLE) {
    return arcSamples(this.wallArc(w), maxSeg);
  }

  wallBetween(n1, n2) {
    return this.walls.find((w) => (w.a === n1 && w.b === n2) || (w.a === n2 && w.b === n1)) || null;
  }

  /** Nearest node on `level` (default: the active level) within radius of p, excluding excludeId. */
  nodeNear(p, radius = NODE_SNAP_RADIUS, excludeId = null, level = this.activeLevel) {
    let best = null, bestD = radius + EPS;
    for (const n of this.nodes) {
      if (n.id === excludeId || n.level !== level) continue;
      const d = dist(n, p);
      if (d <= bestD) { best = n; bestD = d; }
    }
    return best;
  }

  /**
   * Nearest wall on `level` (default: the active level) whose centre line is within maxDist of p.
   * Returns { wall, proj } or null.
   */
  nearestWall(p, maxDist = Infinity, exclude = null, level = this.activeLevel) {
    let best = null;
    for (const w of this.walls) {
      if (w.level !== level) continue;
      if (exclude && exclude.has && exclude.has(w.id)) continue;
      const proj = this.projectOnWall(w, p);
      if (proj.dist <= maxDist && (!best || proj.dist < best.proj.dist)) best = { wall: w, proj };
    }
    return best;
  }

  /** Plan extent of `level` (nodes, floors and stairs), or of every level when level is omitted. */
  bounds(level) {
    const on = (e) => level == null || e.level === level;
    const pts = this.nodes.filter(on);
    for (const w of this.walls) if (on(w) && w.bulge) pts.push(...this.wallSamples(w));
    for (const f of this.floors) if (on(f)) pts.push(...f.points);
    for (const s of this.stairs) if (on(s)) pts.push(...this.stairsFootprint(s));
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
    }
    let maxH = 0;
    for (const w of this.walls) if (on(w)) maxH = Math.max(maxH, w.height);
    return { minX, minY, maxX, maxY, maxHeight: maxH || WALL_DEFAULTS.height };
  }

  // ---------------------------------------------------------------- levels

  levelIndex(id) { return this.levels.findIndex((l) => l.id === id); }
  levelAbove(id) { const i = this.levelIndex(id); return i < 0 ? null : this.levels[i + 1] || null; }
  levelBelow(id) { const i = this.levelIndex(id); return i <= 0 ? null : this.levels[i - 1]; }

  /** Height of the level's floor above the ground: the sum of the heights of the levels below. */
  levelElevation(id) {
    let e = 0;
    for (const l of this.levels) {
      if (l.id === id) return e;
      e += l.height;
    }
    return 0;
  }

  /** Make `id` the level that editing queries default to. UI state: not saved, not in undo. */
  setActiveLevel(id) {
    if (!this.getLevel(id) || id === this.activeLevel) return false;
    this.activeLevel = id;
    this.emit();
    return true;
  }

  /** Add an empty level on top. Returns it. */
  addLevel() {
    const names = new Set(this.levels.map((l) => l.name));
    let i = this.levels.length;
    while (names.has(levelName(i))) i++;
    const l = { id: this.newId('l'), name: levelName(i), height: WALL_DEFAULTS.height };
    this.levels.push(l);
    this.emit();
    return l;
  }

  /**
   * Rename a level or change its height. Walls on the level that were exactly the old level height
   * follow the new height, so they keep reaching the floor above.
   */
  updateLevel(id, props = {}) {
    const l = this.getLevel(id);
    if (!l) return false;
    if (typeof props.name === 'string' && props.name.trim()) l.name = props.name.trim();
    if (props.height != null && Number.isFinite(+props.height)) {
      const h = clamp(+props.height, 10, 2000);
      for (const w of this.walls) {
        if (w.level === id && Math.abs(w.height - l.height) < EPS) { w.height = h; this.clampWallOpenings(w.id); }
      }
      l.height = h;
    }
    this.emit();
    return true;
  }

  /** Delete a level and everything on it. The last remaining level cannot be deleted. */
  deleteLevel(id) {
    const i = this.levelIndex(id);
    if (i < 0 || this.levels.length <= 1) return false;
    const wallIds = new Set(this.walls.filter((w) => w.level === id).map((w) => w.id));
    this.openings = this.openings.filter((o) => !wallIds.has(o.wallId));
    this.walls = this.walls.filter((w) => w.level !== id);
    this.nodes = this.nodes.filter((n) => n.level !== id);
    this.floors = this.floors.filter((f) => f.level !== id);
    this.stairs = this.stairs.filter((s) => s.level !== id);
    this.levels.splice(i, 1);
    if (this.activeLevel === id) this.activeLevel = (this.levels[i - 1] || this.levels[0]).id;
    this.emit();
    return true;
  }

  // ---------------------------------------------------------------- nodes & walls

  addNode(x, y, level = this.activeLevel) {
    const n = { id: this.newId('n'), x, y, level };
    this.nodes.push(n);
    return n;
  }

  /**
   * Return an existing node within `radius` of p, or (with splitWalls) a new node made by
   * splitting a wall that passes through p, or else a brand new node. Only nodes and walls on
   * `level` (default: the active level) are considered.
   */
  getOrCreateNode(p, radius = NODE_SNAP_RADIUS, { splitWalls = false, level = this.activeLevel } = {}) {
    const near = this.nodeNear(p, radius, null, level);
    if (near) return near;
    if (splitWalls) {
      for (const w of this.walls) {
        if (w.level !== level) continue;
        const proj = this.projectOnWall(w, p);
        if (proj.dist <= Math.max(w.thickness / 2, radius) &&
            proj.along > MIN_SPLIT_SEGMENT && proj.along < proj.length - MIN_SPLIT_SEGMENT) {
          const res = this._split(w, proj.along);
          if (res) return res.node;
        }
      }
    }
    return this.addNode(p.x, p.y, level);
  }

  /**
   * Add a wall from p1 to p2 on opts.level (default: the active level), reusing nodes within the
   * snap radius. Returns the new (or already existing identical) wall, or null if it would have zero length.
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
        level: na.level,
      };
      this.walls.push(w);
      if (opts.bulge) this.setWallBulge(w, opts.bulge);
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

  /** If another node on the same level lies within radius of node `id`, merge `id` into it. Returns the surviving id or null. */
  mergeNodeIfNear(id, radius = NODE_SNAP_RADIUS) {
    const n = this.getNode(id);
    if (!n) return null;
    const other = this.nodeNear(n, radius, id, n.level);
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
    const arc = this.wallArc(w);
    const L = arc.length;
    if (along < MIN_SPLIT_SEGMENT || along > L - MIN_SPLIT_SEGMENT) return null;
    const p = arcPointAt(arc, along).point;
    const node = this.addNode(p.x, p.y, w.level);
    const w1 = { id: this.newId('w'), a: w.a, b: node.id, thickness: w.thickness, height: w.height, level: w.level };
    const w2 = { id: this.newId('w'), a: node.id, b: w.b, thickness: w.thickness, height: w.height, level: w.level };
    if (arc.curved) {
      // Both halves keep the curvature: each takes its share of the sweep over its own chord.
      const sweep1 = arc.sweep * (along / L);
      const b1 = bulgeFromSweep(dist(arc.a, p), sweep1);
      const b2 = bulgeFromSweep(dist(p, arc.b), arc.sweep - sweep1);
      if (Math.abs(b1) >= 1e-4) w1.bulge = b1;
      if (Math.abs(b2) >= 1e-4) w2.bulge = b2;
    }
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

  /** Bend (or straighten) a wall. The sagitta is clamped to the chord length; 0 drops the property. */
  setWallBulge(w, bulge) {
    w = this._wall(w);
    if (!w) return false;
    const { a, b } = this.wallEnds(w);
    const chord = dist(a, b);
    const s = Number.isFinite(+bulge) ? clamp(+bulge, -chord, chord) : 0;
    if (Math.abs(s) < 1e-4) delete w.bulge;
    else w.bulge = s;
    return true;
  }

  updateWall(id, props = {}) {
    const w = this.getWall(id);
    if (!w) return false;
    if (props.thickness != null && Number.isFinite(+props.thickness)) w.thickness = clamp(+props.thickness, 1, 200);
    if (props.height != null && Number.isFinite(+props.height)) w.height = clamp(+props.height, 10, 2000);
    if (props.bulge != null) this.setWallBulge(w, props.bulge);
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

  /** Delete a node (with its walls), a wall (with its openings), an opening, a floor or stairs. */
  deleteEntity(kind, id) {
    if (!this.getEntity(kind, id)) return false;
    if (kind === 'floor') {
      this.floors = this.floors.filter((f) => f.id !== id);
    } else if (kind === 'stairs') {
      this.stairs = this.stairs.filter((s) => s.id !== id);
    } else if (kind === 'opening') {
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
    if (openingSpec(type).kind === 'door') o.swing = 0;
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
        if (openingSpec(o.type).kind === 'door' && o.swing == null) o.swing = 0;
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

  // ---------------------------------------------------------------- floors

  /**
   * Add a floor polygon on opts.level (default: the active level). Needs at least 3 distinct points
   * and a non-zero area; returns the floor or null. opts.kind 'cutout' makes it a hole instead of a slab.
   */
  addFloor(points, opts = {}) {
    const pts = cleanPolygon(Array.isArray(points) ? points : []);
    const level = opts.level ?? this.activeLevel;
    if (!pts || !this.getLevel(level)) return null;
    const f = {
      id: this.newId('f'), level, kind: opts.kind === 'cutout' ? 'cutout' : 'slab', points: pts,
      thickness: clamp(num(opts.thickness, FLOOR_DEFAULTS.thickness), 1, 200),
    };
    this.floors.push(f);
    this.emit();
    return f;
  }

  moveFloor(id, dx, dy) {
    const f = this.getFloor(id);
    if (!f) return false;
    for (const p of f.points) { p.x += dx; p.y += dy; }
    this.emit();
    return true;
  }

  moveFloorVertex(id, i, x, y) {
    const f = this.getFloor(id);
    if (!f || !f.points[i] || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    f.points[i].x = x;
    f.points[i].y = y;
    this.emit();
    return true;
  }

  updateFloor(id, props = {}) {
    const f = this.getFloor(id);
    if (!f) return false;
    if (props.thickness != null && Number.isFinite(+props.thickness)) f.thickness = clamp(+props.thickness, 1, 200);
    this.emit();
    return true;
  }

  floorArea(f) {
    f = typeof f === 'string' ? this.getFloor(f) : f;
    return f ? Math.abs(polygonArea(f.points)) : 0;
  }

  /** True if every point of `pts` lies inside floor `f` or on its outline. */
  polygonInFloor(pts, f) {
    f = typeof f === 'string' ? this.getFloor(f) : f;
    if (!f || !Array.isArray(pts) || pts.length < 3) return false;
    const onEdge = (p) => f.points.some((a, i) => distToSegment(p, a, f.points[(i + 1) % f.points.length]) < 0.01);
    return pts.every((p) => onEdge(p) || pointInPolygon(p, f.points));
  }

  /**
   * Holes in a floor slab, as polygons: the footprints of stairs on the level directly below, then
   * the outlines of cutout floors on the same level. Only shapes that lie entirely inside the slab
   * count, because a partial overlap has no well-defined hole. Cutouts themselves have no holes.
   */
  floorHoles(f) {
    f = typeof f === 'string' ? this.getFloor(f) : f;
    if (!f || f.kind === 'cutout') return [];
    const holes = [];
    const below = this.levelBelow(f.level);
    if (below) {
      for (const s of this.stairs) {
        if (s.level !== below.id) continue;
        const fp = this.stairsFootprint(s);
        if (this.polygonInFloor(fp, f)) holes.push(fp);
      }
    }
    for (const c of this.floors) {
      if (c.kind !== 'cutout' || c.level !== f.level) continue;
      if (this.polygonInFloor(c.points, f)) holes.push(c.points.map((p) => ({ x: p.x, y: p.y })));
    }
    return holes;
  }

  /** The slabs that `cutout` actually punches through (empty when it is not inside one). */
  floorsCutBy(cutout) {
    const c = typeof cutout === 'string' ? this.getFloor(cutout) : cutout;
    if (!c || c.kind !== 'cutout') return [];
    return this.floors.filter((f) => f.kind !== 'cutout' && f.level === c.level && this.polygonInFloor(c.points, f));
  }

  // ---------------------------------------------------------------- rooms

  /**
   * Outline of the room that contains `point` on `level`: the inner faces of the walls that enclose
   * it, mitred at the corners, ready for addFloor. Returns null when the point is not inside a
   * closed loop of walls.
   *
   * Every face of the wall graph is traced (at each node the walk takes the neighbour next to the
   * way back, in angle order), dead-end walls are pruned first, and the smallest face containing
   * the point wins. Which side of a wall faces the room is decided per wall by testing an offset
   * midpoint against the face, so the result does not depend on the winding of the walk.
   */
  roomPolygonAt(point, level = this.activeLevel) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const edges = [];              // half-edges, twins adjacent: 2i and 2i+1
    const out = new Map();         // nodeId -> half-edge indices leaving it
    for (const w of this.walls) {
      if (w.level !== level || this.wallLength(w) < EPS) continue;
      for (const [from, to] of [[w.a, w.b], [w.b, w.a]]) {
        const i = edges.length;
        edges.push({ wall: w, from, to, twin: i % 2 === 0 ? i + 1 : i - 1 });
        if (!out.has(from)) out.set(from, []);
        out.get(from).push(i);
      }
    }
    if (edges.length < 6) return null; // a room needs at least three walls
    // Prune dead ends: a node with one wall cannot bound a room.
    const alive = edges.map(() => true);
    for (let pass = 0; pass < edges.length; pass++) {
      const deg = new Map();
      for (let i = 0; i < edges.length; i++) if (alive[i]) deg.set(edges[i].from, (deg.get(edges[i].from) || 0) + 1);
      let changed = false;
      for (let i = 0; i < edges.length; i++) {
        if (!alive[i]) continue;
        if ((deg.get(edges[i].from) || 0) <= 1 || (deg.get(edges[i].to) || 0) <= 1) {
          alive[i] = false; alive[edges[i].twin] = false; changed = true;
        }
      }
      if (!changed) break;
    }
    // Direction each half-edge leaves its node in (the tangent, so curved walls sort correctly).
    const dirOf = (e) => (e.from === e.wall.a
      ? this.wallDirAt(e.wall, 0)
      : scale(this.wallDirAt(e.wall, this.wallLength(e.wall)), -1));
    for (const [node, list] of out) {
      out.set(node, list.filter((i) => alive[i]).sort((i, j) => angleOf(dirOf(edges[i])) - angleOf(dirOf(edges[j]))));
    }
    const seen = edges.map(() => false);
    let best = null;
    for (let i = 0; i < edges.length; i++) {
      if (!alive[i] || seen[i]) continue;
      const cycle = [];
      let cur = i;
      while (!seen[cur]) {
        seen[cur] = true;
        cycle.push(cur);
        const list = out.get(edges[cur].to) || [];
        const k = list.indexOf(edges[cur].twin);
        if (k < 0) { cycle.length = 0; break; }
        cur = list[(k - 1 + list.length) % list.length];
      }
      if (cycle.length < 3) continue;
      const pts = cycle.map((j) => this.getNode(edges[j].from)).filter(Boolean);
      if (pts.length !== cycle.length || !pointInPolygon(point, pts)) continue;
      const area = Math.abs(polygonArea(pts));
      if (area > 1 && (!best || area < best.area)) best = { cycle, pts, area };
    }
    if (!best) return null;
    const polys = computeWallPolygons(this, level);
    const outline = [];
    for (const j of best.cycle) {
      const e = edges[j];
      const pg = polys.get(e.wall.id);
      if (!pg) return null;
      const L = this.wallLength(e.wall);
      const mid = this.pointOnWall(e.wall, L / 2);
      const n = perp(this.wallDirAt(e.wall, L / 2));
      // Which side of this wall the room is on.
      let plus = null;
      for (const probe of [e.wall.thickness / 2, 1]) {
        const a = pointInPolygon(add(mid, scale(n, probe)), best.pts);
        const b = pointInPolygon(add(mid, scale(n, -probe)), best.pts);
        if (a !== b) { plus = a; break; }
      }
      if (plus == null) plus = polygonArea(best.pts) > 0 === (e.from === e.wall.a);
      const first = e.from === e.wall.a ? (plus ? pg.aPlus : pg.aMinus) : (plus ? pg.bPlus : pg.bMinus);
      const last = e.from === e.wall.a ? (plus ? pg.bPlus : pg.bMinus) : (plus ? pg.aPlus : pg.aMinus);
      if (!first || !last) return null;
      outline.push(first, ...this.wallSideSamples(e.wall, plus, e.from === e.wall.a), last);
    }
    return cleanPolygon(outline);
  }

  /**
   * Intermediate points along one side of a wall, between its two mitred end corners: empty for a
   * straight wall, the sampled offset arc for a curved one. `plus` picks the perp(tangent) side and
   * `forward` the a -> b direction.
   */
  wallSideSamples(w, plus, forward) {
    const arc = this.wallArc(w);
    if (!arc.curved) return [];
    const pts = arcSamples(arcOffset(arc, plus ? w.thickness / 2 : -w.thickness / 2));
    const inner = pts.slice(1, -1); // the ends are the mitred corners the caller already has
    return forward ? inner : inner.reverse();
  }

  // ---------------------------------------------------------------- stairs

  /** Add a straight flight starting at (x, y) on opts.level (default: the active level). */
  addStairs(x, y, opts = {}) {
    const level = opts.level ?? this.activeLevel;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.getLevel(level)) return null;
    const s = {
      id: this.newId('s'), level, x, y,
      width: clamp(num(opts.width, STAIR_DEFAULTS.width), 30, 1000),
      length: clamp(num(opts.length, STAIR_DEFAULTS.length), 50, 2000),
      angle: quarterTurn(opts.angle ?? 0),
    };
    this.stairs.push(s);
    this.emit();
    return s;
  }

  moveStairs(id, dx, dy) {
    const s = this.getStairs(id);
    if (!s) return false;
    s.x += dx; s.y += dy;
    this.emit();
    return true;
  }

  /** Change width, length or angle. A new angle turns the flight about its footprint centre. */
  updateStairs(id, props = {}) {
    const s = this.getStairs(id);
    if (!s) return false;
    if (props.width != null && Number.isFinite(+props.width)) s.width = clamp(+props.width, 30, 1000);
    if (props.length != null && Number.isFinite(+props.length)) s.length = clamp(+props.length, 50, 2000);
    if (props.angle != null && Number.isFinite(+props.angle)) {
      const angle = quarterTurn(props.angle);
      if (angle !== s.angle) {
        const c = add(s, scale(this.stairsDir(s), s.length / 2));
        s.angle = angle;
        const start = sub(c, scale(this.stairsDir(s), s.length / 2));
        s.x = start.x; s.y = start.y;
      }
    }
    this.emit();
    return true;
  }

  /** Unit direction the flight climbs in (plan coords). */
  stairsDir(s) {
    const r = (s.angle * Math.PI) / 180;
    return { x: Math.round(Math.cos(r) * 1e9) / 1e9, y: Math.round(Math.sin(r) * 1e9) / 1e9 };
  }

  /** The 4 footprint corners: bottom-left, top-left, top-right, bottom-right (seen walking up). */
  stairsFootprint(s) {
    const u = this.stairsDir(s), n = perp(u);
    const start = { x: s.x, y: s.y };
    const end = add(start, scale(u, s.length));
    const h = s.width / 2;
    return [add(start, scale(n, h)), add(end, scale(n, h)), add(end, scale(n, -h)), add(start, scale(n, -h))];
  }

  /**
   * Rise and step count. The flight climbs to the next level's elevation, or by the level's own
   * height when there is no level above. Returns { rise, steps, riser, going }.
   */
  stairsInfo(s) {
    const level = this.getLevel(s.level);
    const above = this.levelAbove(s.level);
    const rise = above ? this.levelElevation(above.id) - this.levelElevation(s.level) : (level?.height ?? WALL_DEFAULTS.height);
    const steps = Math.max(1, Math.round(rise / STAIR_DEFAULTS.riser));
    return { rise, steps, riser: rise / steps, going: s.length / steps };
  }
}

// -------------------------------------------------------------------- mitred wall outlines

/**
 * Compute the 2D outline of every wall with mitred joins at shared nodes.
 * Returns Map wallId -> { aPlus, bPlus, bMinus, aMinus, u, n, length, arc } where "plus" is the
 * side the wall normal n = perp(u) points to and u is the unit tangent at node a. `arc` is the
 * centre line (see geometry.arcFromChord), so a curved wall's sides can be drawn as arcs between
 * the mitred corners.
 * The polygon in order is [aPlus, bPlus, bMinus, aMinus].
 * With `level`, only that level's walls are computed. Walls never join across levels, because
 * nodes belong to a single level.
 */
export function computeWallPolygons(model, level = null) {
  const out = new Map();
  const ends = new Map(); // nodeId -> [{ wall, dir (outward), half, atA }]
  for (const w of model.walls) {
    if (level != null && w.level !== level) continue;
    const { a, b } = model.wallEnds(w);
    const arc = model.wallArc(w);
    // At a joint a curved wall is mitred against its end tangent, exactly like a straight one.
    const u = arcPointAt(arc, 0).tangent;
    const uEnd = arcPointAt(arc, arc.length).tangent;
    const n = perp(u);
    out.set(w.id, { u, n, length: arc.length, a, b, arc });
    const h = w.thickness / 2;
    if (!ends.has(w.a)) ends.set(w.a, []);
    if (!ends.has(w.b)) ends.set(w.b, []);
    ends.get(w.a).push({ wall: w, dir: u, half: h, atA: true });
    ends.get(w.b).push({ wall: w, dir: scale(uEnd, -1), half: h, atA: false });
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

/** A small sample room (one level, with a floor) used when nothing is saved yet. */
export function createSampleModel() {
  const m = new Model();
  m.batch(() => {
    const pts = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }];
    m.addFloor(pts);
    const walls = pts.map((p, i) => m.addWall(p, pts[(i + 1) % pts.length]));
    m.addOpening(walls[0].id, 'window', 300);
    m.addOpening(walls[1].id, 'window_full', 200);
    m.addOpening(walls[2].id, 'door', 450);
    m.addOpening(walls[3].id, 'window_tall', 200);
  });
  return m;
}
