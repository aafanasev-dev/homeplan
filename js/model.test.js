// Assertions for model.js / geometry.js. No DOM: used by tests.html and run-tests.mjs (node).

import { Model, History, computeWallPolygons, createSampleModel } from './model.js';
import {
  snap, projectOnSegment, lineIntersect, dist, pointInPolygon, polygonArea,
  arcFromChord, arcPointAt, arcProject, arcSamples, arcOffset, sagittaThrough, splineBulges,
} from './geometry.js';
import {
  openingDims, openingSpec, OPENING_TYPES, WALL_STYLES, wallSpec, BARRIER_HEIGHT, MIN_OPENING_WIDTH,
  STAIR_KINDS, FURNITURE_TYPES, furnitureSpec, furnitureParts,
} from './catalog.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class AssertionError extends Error {}
function assert(cond, msg = 'assertion failed') { if (!cond) throw new AssertionError(msg); }
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new AssertionError(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(actual, expected, msg = '', tol = 1e-6) {
  if (!(Math.abs(actual - expected) <= tol)) throw new AssertionError(`${msg} expected ~${expected}, got ${actual}`);
}
function nearPt(p, q, msg = '') { near(p.x, q.x, `${msg} x`); near(p.y, q.y, `${msg} y`); }

/** 600 x 400 rectangle, walls in order top, right, bottom, left. */
function rect(w = 600, h = 400) {
  const m = new Model();
  const pts = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const walls = pts.map((p, i) => m.addWall(p, pts[(i + 1) % 4]));
  return { m, walls };
}

// ------------------------------------------------------------------ geometry

test('geometry: snap to 10 cm', () => {
  eq(snap(14), 10); eq(snap(15), 20); eq(snap(-4), 0); eq(snap(123.4, 0), 123.4);
});

test('geometry: project point on segment', () => {
  const r = projectOnSegment({ x: 30, y: 40 }, { x: 0, y: 0 }, { x: 100, y: 0 });
  near(r.along, 30); near(r.dist, 40); near(r.t, 0.3);
  const c = projectOnSegment({ x: -50, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 });
  near(c.along, 0, 'clamped');
});

test('geometry: line intersection', () => {
  const p = lineIntersect({ x: 0, y: 5 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 1 });
  nearPt(p, { x: 3, y: 5 });
  eq(lineIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 0 }), null, 'parallel');
});

// ------------------------------------------------------------------ walls & nodes

test('addWall reuses shared corner nodes', () => {
  const { m } = rect();
  eq(m.nodes.length, 4, 'nodes'); eq(m.walls.length, 4, 'walls');
  for (const n of m.nodes) eq(m.wallsAtNode(n.id).length, 2, `node ${n.id} degree`);
});

test('addWall snaps to a node within the snap radius', () => {
  const m = new Model();
  m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
  m.addWall({ x: 103, y: 4 }, { x: 100, y: 200 });
  eq(m.nodes.length, 3);
});

test('addWall rejects zero length and leaves no orphan nodes', () => {
  const m = new Model();
  eq(m.addWall({ x: 0, y: 0 }, { x: 0, y: 0 }), null);
  eq(m.addWall({ x: 0, y: 0 }, { x: 3, y: 0 }), null, 'within snap radius');
  eq(m.nodes.length, 0);
});

test('addWall onto a wall body creates a T-junction when splitWalls is set', () => {
  const m = new Model();
  m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  m.addWall({ x: 200, y: 0 }, { x: 200, y: 300 }, { splitWalls: true });
  eq(m.walls.length, 3); eq(m.nodes.length, 4);
  const mid = m.nodeNear({ x: 200, y: 0 }, 1);
  eq(m.wallsAtNode(mid.id).length, 3);
});

test('moveNode moves a shared corner: both walls follow', () => {
  const { m, walls } = rect();
  const corner = m.nodeNear({ x: 600, y: 0 }, 1);
  m.moveNode(corner.id, 700, 0);
  near(m.wallLength(walls[0].id), 700, 'top');
  near(m.wallLength(walls[1].id), Math.hypot(100, 400), 'right');
});

test('moveWall translates both nodes and stretches neighbours', () => {
  const { m, walls } = rect();
  m.moveWall(walls[1].id, 100, 0); // right wall moves right
  near(m.wallLength(walls[1].id), 400, 'moved wall keeps length');
  near(m.wallLength(walls[0].id), 700, 'top stretched');
  near(m.wallLength(walls[2].id), 700, 'bottom stretched');
});

test('mergeNodes joins two chains into one corner', () => {
  const m = new Model();
  m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
  m.addWall({ x: 200, y: 0 }, { x: 200, y: 100 });
  const loose = m.nodeNear({ x: 200, y: 0 }, 1);
  m.moveNode(loose.id, 104, 2);
  const survivor = m.mergeNodeIfNear(loose.id, 10);
  assert(survivor, 'merged');
  eq(m.nodes.length, 3);
  eq(m.wallsAtNode(survivor).length, 2);
});

test('mergeNodes removes collapsed and duplicate walls', () => {
  const { m, walls } = rect();
  const a = m.nodeNear({ x: 600, y: 0 }, 1), b = m.nodeNear({ x: 600, y: 400 }, 1);
  m.addOpening(walls[1].id, 'window', 200);
  m.mergeNodes(a.id, b.id); // collapses the right wall
  eq(m.walls.length, 3);
  eq(m.openings.length, 0, 'opening on collapsed wall removed');
  // Triangle: merge another corner so two walls become duplicates.
  const c = m.nodeNear({ x: 0, y: 400 }, 1), d = m.nodeNear({ x: 0, y: 0 }, 1);
  m.mergeNodes(c.id, d.id);
  eq(m.walls.length, 1, 'duplicates collapsed to one wall');
  eq(m.nodes.length, 2);
});

test('splitWall creates two segments with a shared node', () => {
  const { m, walls } = rect();
  const res = m.splitWall(walls[0].id, { x: 253, y: 12 }, { snap: 10 });
  assert(res, 'split ok');
  eq(m.walls.length, 5);
  eq(m.getWall(walls[0].id), null, 'original replaced');
  nearPt(res.node, { x: 250, y: 0 });
  near(m.wallLength(res.walls[0].id), 250); near(m.wallLength(res.walls[1].id), 350);
  eq(m.wallsAtNode(res.node.id).length, 2);
  // Dragging the new node moves both halves.
  m.moveNode(res.node.id, 250, -50);
  near(m.wallLength(res.walls[0].id), Math.hypot(250, 50));
});

test('splitWall reassigns openings to the half that holds their centre', () => {
  const { m, walls } = rect();
  const o1 = m.addOpening(walls[0].id, 'window', 100);
  const o2 = m.addOpening(walls[0].id, 'door', 450);
  const res = m.splitWall(walls[0].id, { x: 300, y: 0 });
  eq(o1.wallId, res.walls[0].id); near(o1.t, 100);
  eq(o2.wallId, res.walls[1].id); near(o2.t, 150, 't recomputed');
});

test('splitWall keeps a straddling opening inside its half', () => {
  const { m, walls } = rect();
  const o = m.addOpening(walls[0].id, 'door', 310); // 265..355
  const res = m.splitWall(walls[0].id, { x: 300, y: 0 });
  eq(o.wallId, res.walls[1].id);
  near(o.t, 45, 'pushed to start of second half');
});

test('splitWall rejects points at the wall ends', () => {
  const { m, walls } = rect();
  eq(m.splitWall(walls[0].id, { x: 0, y: 0 }), null);
  eq(m.splitWall(walls[0].id, { x: 600.5, y: 0 }), null);
  eq(m.walls.length, 4);
});

// ------------------------------------------------------------------ openings

test('openings are clamped inside the wall', () => {
  const { m, walls } = rect();
  const o = m.addOpening(walls[0].id, 'window', 10); // width 120
  near(o.t, 60, 'clamped at start');
  m.moveOpening(o.id, 9999);
  near(o.t, 540, 'clamped at end');
});

test('openings cannot overlap', () => {
  const { m, walls } = rect();
  const a = m.addOpening(walls[0].id, 'window', 300); // 240..360
  const b = m.addOpening(walls[0].id, 'door', 280);   // must move out of the way
  assert(b, 'placed');
  assert(b.t + b.width / 2 <= a.t - a.width / 2 + 1e-9 || b.t - b.width / 2 >= a.t + a.width / 2 - 1e-9, 'no overlap');
  near(b.t, 195, 'nearest free slot on the left');
  m.moveOpening(b.id, 330);
  near(b.t, 405, 'jumped to the nearest free slot on the right');
});

test('addOpening fails when there is no room', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
  eq(m.addOpening(w.id, 'window', 50), null, 'window 120 on wall 100');
  assert(m.addOpening(w.id, 'door', 50), 'door 90 fits');
  eq(m.addOpening(w.id, 'door', 50, 30), null, 'no room left');
});

test('moveOpening jumps to another wall', () => {
  const { m, walls } = rect();
  const o = m.addOpening(walls[0].id, 'window', 300);
  assert(m.moveOpening(o.id, 200, walls[1].id));
  eq(o.wallId, walls[1].id); near(o.t, 200);
});

test('resizeOpening: symmetric, anchored and min width', () => {
  const { m, walls } = rect();
  const o = m.addOpening(walls[0].id, 'window', 300); // 240..360
  m.resizeOpening(o.id, 200);
  near(o.width, 200); near(o.t, 300);
  m.resizeOpening(o.id, 10);
  near(o.width, MIN_OPENING_WIDTH, 'min width');
  m.resizeOpening(o.id, 100, 'start'); // start edge at 285 stays
  near(o.t - o.width / 2, 285); near(o.width, 100);
  m.resizeOpening(o.id, 10000, 'start');
  near(o.t + o.width / 2, 600, 'clamped at wall end');
  m.resizeOpening(o.id, 100, 'end');
  near(o.t + o.width / 2, 600); near(o.width, 100);
});

test('resizeOpening is clamped by a neighbour', () => {
  const { m, walls } = rect();
  m.addOpening(walls[0].id, 'door', 100);           // 55..145
  const o = m.addOpening(walls[0].id, 'window', 300); // 240..360
  m.resizeOpening(o.id, 1000);
  near(o.width, 2 * (300 - 145), 'symmetric limited by the door');
  near(o.t, 300);
});

test('moving a node clamps openings on the shortened wall', () => {
  const { m, walls } = rect();
  const o = m.addOpening(walls[0].id, 'window', 500);
  const corner = m.nodeNear({ x: 600, y: 0 }, 1);
  m.moveNode(corner.id, 300, 0);
  near(o.t, 240, 'pulled back inside');
});

test('full-height window spans the wall height', () => {
  const d = openingDims('window_full', 270);
  eq(d.sill, 0); eq(d.height, 270);
  const w = openingDims('window', 270);
  eq(w.sill, 90); eq(w.top, 230);
  eq(openingDims('door', 200).height, 200, 'clamped to a low wall');
});

test('deleteEntity: wall removes its openings and orphan nodes', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
  m.addWall({ x: 300, y: 0 }, { x: 300, y: 300 });
  m.addOpening(w.id, 'door', 150);
  m.deleteEntity('wall', w.id);
  eq(m.walls.length, 1); eq(m.openings.length, 0); eq(m.nodes.length, 2);
});

test('deleteEntity: node removes attached walls', () => {
  const { m } = rect();
  const n = m.nodeNear({ x: 0, y: 0 }, 1);
  m.deleteEntity('node', n.id);
  eq(m.walls.length, 2); eq(m.nodes.length, 3);
});

// ------------------------------------------------------------------ rendering helpers

test('computeWallPolygons mitres a square corner', () => {
  const { m, walls } = rect();
  const polys = computeWallPolygons(m);
  const top = polys.get(walls[0].id);
  // Top wall runs +x, n = (0, 1) points into the room. Outer corner at (-7.5, -7.5).
  nearPt(top.aMinus, { x: -7.5, y: -7.5 }, 'outer corner');
  nearPt(top.aPlus, { x: 7.5, y: 7.5 }, 'inner corner');
  nearPt(top.bMinus, { x: 607.5, y: -7.5 });
  nearPt(top.bPlus, { x: 592.5, y: 7.5 });
});

test('computeWallPolygons squares free ends', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
  const p = computeWallPolygons(m).get(w.id);
  nearPt(p.aPlus, { x: 0, y: 7.5 }); nearPt(p.aMinus, { x: 0, y: -7.5 });
  nearPt(p.bPlus, { x: 100, y: 7.5 }); nearPt(p.bMinus, { x: 100, y: -7.5 });
});

// ------------------------------------------------------------------ persistence & history

test('serialize / load round trip keeps ids unique', () => {
  const m = createSampleModel();
  const json = m.serialize();
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  const w = m2.addWall({ x: 0, y: 1000 }, { x: 100, y: 1000 });
  const all = [...m2.nodes, ...m2.walls, ...m2.openings].map((e) => e.id);
  eq(new Set(all).size, all.length, 'unique ids');
  assert(w, 'added');
});

test('load drops dangling references', () => {
  const m = new Model({
    nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 0 }],
    walls: [{ id: 'w1', a: 'n1', b: 'n2' }, { id: 'w2', a: 'n1', b: 'nX' }],
    openings: [{ id: 'o1', wallId: 'w1', type: 'door', t: 50, width: 90 }, { id: 'o2', wallId: 'w2', type: 'door', t: 0, width: 90 }, { id: 'o3', wallId: 'w1', type: 'bogus', t: 0, width: 90 }],
  });
  eq(m.walls.length, 1); eq(m.openings.length, 1);
  eq(m.walls[0].thickness, 15, 'default thickness');
  assert(m.nextId >= 3, 'nextId continues after loaded ids');
});

test('change events fire and batch coalesces them', () => {
  const m = new Model();
  let count = 0;
  m.on(() => count++);
  m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 });
  eq(count, 1, 'addWall emits once');
  m.batch(() => { m.addWall({ x: 100, y: 0 }, { x: 100, y: 100 }); m.addWall({ x: 100, y: 100 }, { x: 0, y: 100 }); });
  eq(count, 2, 'batched');
});

test('History undo / redo', () => {
  const m = new Model();
  const h = new History(m);
  m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 }); h.commit();
  m.addWall({ x: 100, y: 0 }, { x: 100, y: 100 }); h.commit();
  eq(h.commit(), false, 'no-op commit ignored');
  h.undo(); eq(m.walls.length, 1);
  h.undo(); eq(m.walls.length, 0);
  eq(h.undo(), false);
  h.redo(); eq(m.walls.length, 1);
  m.addWall({ x: 0, y: 0 }, { x: 0, y: 50 }); h.commit();
  eq(h.canRedo(), false, 'new action clears redo');
});

test('sample model is valid', () => {
  const m = createSampleModel();
  eq(m.walls.length, 4); eq(m.openings.length, 4);
  for (const o of m.openings) {
    const L = m.wallLength(o.wallId);
    assert(o.t - o.width / 2 >= -1e-9 && o.t + o.width / 2 <= L + 1e-9, `${o.id} inside wall`);
  }
  assert(dist(m.nodes[0], m.nodes[1]) > 0);
});

// ------------------------------------------------------------------ levels, floors & stairs

test('geometry: point in polygon and polygon area', () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  assert(pointInPolygon({ x: 50, y: 50 }, sq), 'inside');
  assert(!pointInPolygon({ x: 150, y: 50 }, sq), 'outside');
  const l = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
  assert(!pointInPolygon({ x: 150, y: 150 }, l), 'notch of an L shape');
  near(Math.abs(polygonArea(sq)), 10000);
});

test('v1 data migrates to a single level', () => {
  const m = new Model({
    version: 1, nextId: 4,
    nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 300, y: 0 }],
    walls: [{ id: 'w3', a: 'n1', b: 'n2', thickness: 15, height: 270 }],
    openings: [],
  });
  eq(m.levels.length, 1, 'levels');
  const L = m.levels[0].id;
  eq(m.activeLevel, L, 'active');
  for (const n of m.nodes) eq(n.level, L, `node ${n.id} level`);
  eq(m.walls[0].level, L, 'wall level');
  eq(m.floors.length, 0); eq(m.stairs.length, 0);
  const all = [...m.levels, ...m.nodes, ...m.walls].map((e) => e.id);
  eq(new Set(all).size, all.length, 'level id unique');
  const w = m.addWall({ x: 0, y: 100 }, { x: 100, y: 100 });
  assert(!all.includes(w.id), 'new ids do not collide');
});

test('load drops entities on unknown levels and walls across levels', () => {
  const m = new Model({
    version: 2,
    levels: [{ id: 'l1', name: 'Ground', height: 270 }, { id: 'l2', name: 'Upper', height: 250 }],
    nodes: [{ id: 'n1', x: 0, y: 0, level: 'l1' }, { id: 'n2', x: 100, y: 0, level: 'l2' }, { id: 'n3', x: 0, y: 0, level: 'lX' }],
    walls: [{ id: 'w1', a: 'n1', b: 'n2' }],
    floors: [{ id: 'f1', level: 'lX', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] }],
    stairs: [{ id: 's1', level: 'l2', x: 0, y: 0, angle: 95 }, { id: 's2', level: 'l2', x: 0, y: 0, angle: -30 }],
  });
  eq(m.nodes.length, 2, 'node on unknown level dropped');
  eq(m.walls.length, 0, 'wall across levels dropped');
  eq(m.floors.length, 0, 'floor on unknown level dropped');
  eq(m.stairs.length, 2);
  eq(m.stairs[0].angle, 95, 'any angle is kept');
  eq(m.stairs[1].angle, 330, 'and normalised into 0 .. 359');
});

test('addLevel stacks levels and levelElevation sums the heights below', () => {
  const m = new Model();
  const l1 = m.levels[0];
  const l2 = m.addLevel();
  m.updateLevel(l2.id, { height: 250 });
  const l3 = m.addLevel();
  eq(m.levels.length, 3);
  eq(l2.name, 'Level 2'); eq(l3.height, 270, 'default height');
  eq(m.levelElevation(l1.id), 0); eq(m.levelElevation(l2.id), 270); eq(m.levelElevation(l3.id), 520);
  eq(m.levelAbove(l1.id), l2); eq(m.levelBelow(l1.id), null);
  eq(m.activeLevel, l1.id, 'addLevel does not switch');
});

test('updateLevel height carries walls that matched the old height', () => {
  const m = new Model();
  const L = m.activeLevel;
  const w1 = m.addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
  const w2 = m.addWall({ x: 0, y: 100 }, { x: 300, y: 100 }, { height: 120 });
  m.updateLevel(L, { name: '  Ground  ', height: 300 });
  eq(m.getLevel(L).name, 'Ground');
  eq(w1.height, 300); eq(w2.height, 120, 'custom height kept');
});

test('node snapping, wall splitting and merging stay on one level', () => {
  const m = new Model();
  const l1 = m.activeLevel;
  m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  const l2 = m.addLevel().id;
  m.setActiveLevel(l2);
  const w = m.addWall({ x: 2, y: 3 }, { x: 200, y: 0 }, { splitWalls: true });
  eq(m.nodes.length, 4, 'no snap to level 1 nodes');
  eq(m.walls.length, 2, 'level 1 wall not split');
  eq(w.level, l2);
  for (const id of [w.a, w.b]) eq(m.getNode(id).level, l2, 'new nodes on level 2');
  eq(m.nodeNear({ x: 0, y: 0 }, 10), m.getNode(w.a), 'nodeNear defaults to the active level');
  eq(m.nodeNear({ x: 0, y: 0 }, 10, null, l1).level, l1, 'explicit level');
  eq(m.mergeNodeIfNear(w.a, 10), null, 'no merge across levels');
  eq(m.nearestWall({ x: 100, y: 0 }).wall.level, l2);
  eq(m.bounds(l2).maxX, 200); eq(m.bounds().maxX, 400, 'all levels');
  eq(computeWallPolygons(m, l2).size, 1);
  const res = m.splitWall(w.id, { x: 100, y: 1 });
  for (const sw of res.walls) eq(sw.level, l2, 'split halves keep the level');
  eq(res.node.level, l2);
});

test('deleteLevel removes everything on it, but never the last level', () => {
  const m = new Model();
  const l1 = m.activeLevel;
  m.addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
  const l2 = m.addLevel().id;
  m.setActiveLevel(l2);
  const w = m.addWall({ x: 0, y: 0 }, { x: 300, y: 0 });
  m.addOpening(w.id, 'door', 150);
  m.addFloor([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }]);
  m.addStairs(50, 50);
  assert(m.deleteLevel(l2), 'deleted');
  eq(m.levels.length, 1); eq(m.walls.length, 1); eq(m.nodes.length, 2);
  eq(m.openings.length, 0); eq(m.floors.length, 0); eq(m.stairs.length, 0);
  eq(m.activeLevel, l1, 'active level falls back');
  eq(m.deleteLevel(l1), false, 'last level kept');
});

test('addFloor validates points; vertices and floors move', () => {
  const m = new Model();
  eq(m.addFloor([{ x: 0, y: 0 }, { x: 100, y: 0 }]), null, 'two points');
  eq(m.addFloor([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]), null, 'zero area');
  eq(m.addFloor([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }]), null, 'duplicate points');
  const f = m.addFloor([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }]);
  assert(f, 'added'); eq(f.points.length, 4, 'closing point dropped');
  eq(f.level, m.activeLevel); eq(f.thickness, 20);
  near(m.floorArea(f), 10000);
  m.moveFloorVertex(f.id, 2, 200, 100);
  nearPt(f.points[2], { x: 200, y: 100 });
  near(m.floorArea(f), 15000);
  m.moveFloor(f.id, 10, -10);
  nearPt(f.points[0], { x: 10, y: -10 });
  m.updateFloor(f.id, { thickness: 30 }); eq(f.thickness, 30);
  assert(m.deleteEntity('floor', f.id)); eq(m.floors.length, 0);
});

test('stairs footprint, rotation and step count', () => {
  const m = new Model();
  const s = m.addStairs(100, 200); // 100 wide, 300 long, climbing towards +x
  const fp = m.stairsFootprint(s);
  nearPt(fp[0], { x: 100, y: 250 }); nearPt(fp[1], { x: 400, y: 250 });
  nearPt(fp[2], { x: 400, y: 150 }); nearPt(fp[3], { x: 100, y: 150 });
  let info = m.stairsInfo(s);
  eq(info.rise, 270); eq(info.steps, 15); near(info.riser, 18);
  m.updateStairs(s.id, { angle: 90 }); // turns about the footprint centre (250, 200)
  eq(s.angle, 90);
  nearPt(s, { x: 250, y: 50 });
  const fp2 = m.stairsFootprint(s);
  near(Math.max(...fp2.map((p) => p.y)) - Math.min(...fp2.map((p) => p.y)), 300, 'runs along y');
  const l2 = m.addLevel();
  m.updateLevel(l2.id, { height: 300 });
  m.updateLevel(m.levels[0].id, { height: 290 });
  info = m.stairsInfo(s);
  eq(info.rise, 290, 'rise to the next level'); eq(info.steps, 16);
  m.moveStairs(s.id, 10, 0); near(s.x, 260);
  assert(m.deleteEntity('stairs', s.id)); eq(m.stairs.length, 0);
});

test('floorHoles cuts contained stairs from the level below only', () => {
  const m = new Model();
  const l1 = m.activeLevel;
  m.addStairs(100, 100);           // footprint x 100..400, y 50..150: inside the upper floor
  m.addStairs(550, 100);           // x 550..850: sticks out of the floor
  const l2 = m.addLevel().id;
  m.setActiveLevel(l2);
  m.addStairs(200, 200);           // on the same level as the floor: no hole
  const f = m.addFloor([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]);
  const holes = m.floorHoles(f);
  eq(holes.length, 1, 'one hole');
  nearPt(holes[0][0], { x: 100, y: 150 });
  const g = m.addFloor([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }], { level: l1 });
  eq(m.floorHoles(g).length, 0, 'no level below the ground floor');
  m.setActiveLevel(l1);
  const flush = m.addStairs(0, 50, { level: l1 }); // footprint edge on the floor edge counts as inside
  eq(m.floorHoles(f).length, 2);
  assert(flush);
});

test('levels, floors and stairs survive toJSON / load', () => {
  const m = createSampleModel();
  const l2 = m.addLevel();
  m.updateLevel(l2.id, { name: 'Attic', height: 240 });
  m.setActiveLevel(l2.id);
  m.addWall({ x: 0, y: 0 }, { x: 600, y: 0 });
  m.addFloor([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }], { thickness: 25 });
  m.addStairs(100, 100, { angle: 180, width: 90 });
  const json = m.serialize();
  const d = JSON.parse(json);
  eq(d.version, 2);
  eq(d.activeLevel, undefined, 'active level not serialised');
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  eq(m2.levels.length, 2); eq(m2.levels[1].name, 'Attic'); eq(m2.levelElevation(l2.id), 270);
  eq(m2.floors.length, 2); eq(m2.floors[1].thickness, 25);
  eq(m2.stairs[0].angle, 180); eq(m2.stairs[0].width, 90);
  eq(m2.activeLevel, m2.levels[0].id, 'a fresh load starts on the first level');
  const ids = [...m2.levels, ...m2.nodes, ...m2.walls, ...m2.openings, ...m2.floors, ...m2.stairs].map((e) => e.id);
  const s = m2.addStairs(0, 0);
  assert(!ids.includes(s.id), 'nextId past every loaded id');
});

test('activeLevel is not in undo snapshots', () => {
  const m = new Model();
  const h = new History(m);
  const l1 = m.activeLevel;
  const l2 = m.addLevel().id; h.commit();
  m.setActiveLevel(l2);
  eq(h.commit(), false, 'switching level is not an undo step');
  m.addWall({ x: 0, y: 0 }, { x: 100, y: 0 }); h.commit();
  h.undo();
  eq(m.walls.length, 0); eq(m.activeLevel, l2, 'undo keeps the active level');
  h.undo();
  eq(m.levels.length, 1); eq(m.activeLevel, l1, 'falls back when the level is gone');
  h.redo();
  eq(m.activeLevel, l1, 'redo does not switch either');
});


// ------------------------------------------------------------------ arcs & curved walls

/** Area of a polygon, as the editor would see it. */
const area = (pts) => Math.abs(polygonArea(pts));

test('geometry: an arc from a chord and a sagitta', () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  const arc = arcFromChord(a, b, 50); // a semicircle bulging towards +y
  assert(arc.curved, 'curved');
  near(arc.R, 50, 'radius'); near(arc.length, Math.PI * 50, 'arc length');
  nearPt(arcPointAt(arc, arc.length / 2).point, { x: 50, y: 50 }, 'midpoint');
  nearPt(arcPointAt(arc, 0).point, a, 'start'); nearPt(arcPointAt(arc, arc.length).point, b, 'end');
  nearPt(arcPointAt(arc, 0).tangent, { x: 0, y: 1 }, 'tangent at the start', 1e-9);
  eq(arcFromChord(a, b, 0).curved, false, 'no bulge is straight');
  eq(arcFromChord(a, b, 1e-9).curved, false, 'a negligible bulge is straight');
  near(arcFromChord(a, b, 5000).bulge, 100, 'clamped to the chord length');
});

test('geometry: projecting onto an arc clamps to its ends', () => {
  const arc = arcFromChord({ x: 0, y: 0 }, { x: 100, y: 0 }, 50);
  const on = arcProject(arc, { x: 50, y: 60 });
  near(on.along, arc.length / 2, 'nearest point is the midpoint'); near(on.dist, 10, 'distance');
  near(on.rawT, 0.5, 'rawT');
  const past = arcProject(arc, { x: -20, y: -5 });
  near(past.along, 0, 'clamped to the start');
  assert(past.rawT < 0, 'rawT marks a point past the start');
  assert(arcProject(arc, { x: 120, y: -5 }).rawT > 1, 'rawT marks a point past the end');
});

test('geometry: offsetting an arc follows its sides', () => {
  const arc = arcFromChord({ x: 0, y: 0 }, { x: 100, y: 0 }, 50);
  const plus = arcOffset(arc, 10), minus = arcOffset(arc, -10);
  near(plus.R, 60, 'outer radius'); near(minus.R, 40, 'inner radius');
  nearPt(arcPointAt(plus, plus.length / 2).point, { x: 50, y: 60 }, 'offset midpoint');
  nearPt(arcPointAt(minus, minus.length / 2).point, { x: 50, y: 40 }, 'inner midpoint');
  // Every sample sits 10 cm off the centre line, on the right side.
  for (const q of arcSamples(plus, 10)) near(dist(q, arc.centre), 60, 'sample radius', 1e-6);
  const straight = arcOffset(arcFromChord({ x: 0, y: 0 }, { x: 100, y: 0 }), 10);
  nearPt(straight.a, { x: 0, y: 10 }, 'straight offset');
});

test('geometry: a spline through points gives one bulge per segment', () => {
  eq(splineBulges([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]).every((b) => Math.abs(b) < 1e-9), true, 'collinear is straight');
  near(sagittaThrough({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 }), 50, 'sagitta');
  const hump = splineBulges([{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 200, y: 0 }]);
  eq(hump.length, 2, 'one per segment');
  assert(hump[0] > 0 && Math.abs(hump[0] - hump[1]) < 1e-9, 'a symmetric hump bends both segments alike');
  const ess = splineBulges([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 }, { x: 300, y: 100 }]);
  near(ess[1], 0, 'the straight middle of an S stays straight');
  assert(ess[0] * ess[2] < 0, 'and its ends bend opposite ways');
});

test('a curved wall measures and splits along its arc', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 }, { bulge: 80 });
  near(w.bulge, 80, 'stored');
  assert(m.wallLength(w) > 400, 'longer than the chord');
  near(m.wallLength(w), m.wallArc(w).length);
  nearPt(m.pointOnWall(w, m.wallLength(w) / 2), { x: 200, y: 80 }, 'middle of the arc', 1e-6);
  const total = m.wallLength(w);
  const res = m.splitWall(w.id, { x: 200, y: 400 });
  assert(res, 'split');
  near(res.walls[0].bulge, res.walls[1].bulge, 'both halves bend the same way');
  assert(res.walls[0].bulge > 0, 'and in the original direction');
  near(m.wallLength(res.walls[0]) + m.wallLength(res.walls[1]), total, 'the halves add up', 1e-6);
  m.updateWall(res.walls[0].id, { bulge: 0 });
  eq(res.walls[0].bulge, undefined, 'straightening drops the property');
});

test('openings sit on the arc of a curved wall', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  const o = m.addOpening(w.id, 'window', 200, 120);
  m.updateWall(w.id, { bulge: 120 });
  const L = m.wallLength(w);
  assert(o.t - o.width / 2 >= -1e-9 && o.t + o.width / 2 <= L + 1e-9, 'still inside the longer wall');
  near(dist(m.pointOnWall(w, o.t), m.wallArc(w).centre), m.wallArc(w).R, 'the centre of the opening is on the arc', 1e-6);
  m.updateWall(w.id, { bulge: 0 });
  near(m.wallLength(w), 400, 'back to the chord');
  assert(o.t + o.width / 2 <= 400 + 1e-9, 'and the opening was pulled back in');
});

test('bulge survives toJSON / load and is clamped to the chord', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 300, y: 0 }, { bulge: 60 });
  const json = m.serialize();
  eq(JSON.parse(json).walls[0].bulge, w.bulge, 'serialised');
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  const m3 = new Model({ version: 2, nodes: [
    { id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 0 },
  ], walls: [{ id: 'w1', a: 'n1', b: 'n2', bulge: 9999 }] });
  near(m3.walls[0].bulge, 100, 'clamped to the chord length on load');
  const m4 = new Model({ version: 2, nodes: [
    { id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 0 },
  ], walls: [{ id: 'w1', a: 'n1', b: 'n2' }] });
  eq('bulge' in m4.walls[0], false, 'a straight wall stores nothing');
});

// ------------------------------------------------------------------ catalog additions

test('catalog: the small window hangs below the ceiling and doubles have two panes', () => {
  const d = openingDims('window_small', 270);
  eq(d.height, 30); eq(d.sill, 220); eq(d.top, 250);
  eq(openingDims('window_small', 40).sill, 0, 'a low wall pushes it down to the floor');
  eq(openingSpec('window_double').panes, 2);
  eq(openingSpec('window').panes, 1);
  eq(openingSpec('door_double').leaves, 2);
  eq(openingSpec('door_slide').style, 'slide');
  eq(openingSpec('door_garage').style, 'garage');
  eq(openingSpec('door').style, 'swing');
});

test('every door type gets a swing, every opening type a sane default width', () => {
  const m = new Model();
  for (const [type, spec] of Object.entries(OPENING_TYPES)) {
    const w = m.addWall({ x: 0, y: m.walls.length * 100 }, { x: 600, y: m.walls.length * 100 });
    const o = m.addOpening(w.id, type, 300);
    assert(o, `placed ${type}`);
    eq(o.width, spec.width, `${type} width`);
    eq(spec.kind === 'door', o.swing != null, `${type} swing`);
  }
});

// ------------------------------------------------------------------ cutouts & room fill

test('a cutout punches a hole in the floor it sits in', () => {
  const m = new Model();
  const f = m.addFloor([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]);
  eq(f.kind, 'slab', 'floors are slabs by default');
  const c = m.addFloor([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }], { kind: 'cutout' });
  eq(c.kind, 'cutout');
  eq(m.floorHoles(f).length, 1, 'one hole');
  eq(m.floorHoles(c).length, 0, 'a cutout has no holes of its own');
  eq(m.floorsCutBy(c).length, 1, 'it cuts the slab');
  const out = m.addFloor([{ x: 500, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 500 }], { kind: 'cutout' });
  eq(m.floorsCutBy(out).length, 0, 'a partly overlapping cutout cuts nothing');
  eq(m.floorHoles(f).length, 1, 'and makes no hole');
  const l2 = m.addLevel().id;
  const up = m.addFloor([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }], { kind: 'cutout', level: l2 });
  eq(m.floorsCutBy(up).length, 0, 'cutouts only cut their own level');
  eq(m.serialize(), new Model(m.serialize()).serialize(), 'kind survives a round trip');
});

test('roomPolygonAt traces the room under a point', () => {
  const m = new Model();
  const pts = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }];
  const walls = pts.map((p, i) => m.addWall(p, pts[(i + 1) % 4]));
  const room = m.roomPolygonAt({ x: 300, y: 200 });
  assert(room, 'found');
  eq(room.length, 4, 'four corners');
  near(area(room), (600 - 15) * (400 - 15), 'inside the wall faces');
  eq(m.roomPolygonAt({ x: 900, y: 200 }), null, 'outside any room');
  eq(m.roomPolygonAt({ x: 300, y: 200 }, m.addLevel().id), null, 'another level is empty');
  // A stub wall sticking into the room is ignored.
  m.addWall({ x: 300, y: 0 }, { x: 300, y: 120 }, { splitWalls: true });
  near(area(m.roomPolygonAt({ x: 300, y: 300 })), (600 - 15) * (400 - 15), 'the stub does not split the room');
  // A wall across it does split it.
  m.addWall({ x: 300, y: 120 }, { x: 300, y: 400 }, { splitWalls: true });
  near(area(m.roomPolygonAt({ x: 150, y: 200 })), (300 - 15) * (400 - 15), 'left half');
  near(area(m.roomPolygonAt({ x: 450, y: 200 })), (300 - 15) * (400 - 15), 'right half');
  // Bowing a wall outwards makes the room bigger and the outline follows the arc.
  const straight = area(m.roomPolygonAt({ x: 150, y: 200 }));
  m.updateWall(walls[3].id, { bulge: -100 });
  const bowed = m.roomPolygonAt({ x: 150, y: 200 });
  assert(bowed.length > 4, 'the curved side is sampled');
  assert(area(bowed) > straight, 'and the room grew');
  m.updateWall(walls[3].id, { bulge: 100 });
  assert(area(m.roomPolygonAt({ x: 150, y: 200 })) < straight, 'bowing the other way shrinks it');
});

// ------------------------------------------------------------------ barriers (wall styles)

test('a barrier is a wall with its own height and thickness', () => {
  const m = new Model();
  const plain = m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  eq('style' in plain, false, 'a plain wall stores no style');
  eq(plain.height, m.getLevel(plain.level).height, 'and reaches the level height');
  eq(plain.thickness, WALL_STYLES.wall.thickness);
  for (const style of ['barrier_full', 'barrier_glass', 'barrier_railing']) {
    const b = m.addWall({ x: 0, y: m.walls.length * 100 + 100 }, { x: 400, y: m.walls.length * 100 + 100 }, { style });
    eq(b.style, style, style);
    eq(b.height, BARRIER_HEIGHT, `${style} height`);
    eq(b.thickness, WALL_STYLES[style].thickness, `${style} thickness`);
    assert(wallSpec(b.style).barrier, `${style} is a barrier`);
  }
  // Explicit values still win.
  const custom = m.addWall({ x: 0, y: 900 }, { x: 400, y: 900 }, { style: 'barrier_full', height: 140, thickness: 20 });
  eq(custom.height, 140); eq(custom.thickness, 20);
});

test('changing the style of a wall brings the new proportions', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 });
  const levelHeight = m.getLevel(w.level).height;
  m.updateWall(w.id, { style: 'barrier_railing' });
  eq(w.style, 'barrier_railing'); eq(w.height, BARRIER_HEIGHT); eq(w.thickness, WALL_STYLES.barrier_railing.thickness);
  m.updateWall(w.id, { style: 'wall' });
  eq('style' in w, false, 'back to a plain wall');
  eq(w.height, levelHeight, 'and back to the level height');
  m.updateWall(w.id, { style: 'barrier_glass', height: 90 });
  eq(w.height, 90, 'an explicit height wins over the style default');
  m.updateWall(w.id, { thickness: 30 });
  eq(w.style, 'barrier_glass', 'other edits leave the style alone');
  eq(m.updateWall(w.id, { style: 'nonsense' }), true);
  eq(w.style, 'barrier_glass', 'an unknown style is ignored');
});

test('barriers split, curve, serialise and keep clear of level height changes', () => {
  const m = new Model();
  const w = m.addWall({ x: 0, y: 0 }, { x: 400, y: 0 }, { style: 'barrier_railing', bulge: 60 });
  const halves = m.splitWall(w.id, { x: 200, y: 200 }).walls;
  for (const h of halves) { eq(h.style, 'barrier_railing', 'the style survives a split'); eq(h.height, BARRIER_HEIGHT); }
  const plain = m.addWall({ x: 0, y: 300 }, { x: 400, y: 300 });
  m.updateLevel(m.activeLevel, { height: 300 });
  eq(plain.height, 300, 'a full-height wall follows the level');
  eq(halves[0].height, BARRIER_HEIGHT, 'a barrier keeps its own height');
  const json = m.serialize();
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  eq(m2.walls[0].style, 'barrier_railing');
  const m3 = new Model({ version: 2, nodes: [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 0 }],
    walls: [{ id: 'w1', a: 'n1', b: 'n2', style: 'what' }] });
  eq('style' in m3.walls[0], false, 'an unknown style loads as a plain wall');
});

test('a barrier can hold an opening and still bound a room', () => {
  const m = new Model();
  const pts = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }];
  const walls = pts.map((p, i) => m.addWall(p, pts[(i + 1) % 4]));
  m.updateWall(walls[2].id, { style: 'barrier_railing' });
  const room = m.roomPolygonAt({ x: 300, y: 200 });
  assert(room, 'the railing still closes the room');
  near(area(room), (600 - 15) * (400 - (15 + WALL_STYLES.barrier_railing.thickness) / 2), 'up to the inner faces');
  const o = m.addOpening(walls[2].id, 'door', 300);
  assert(o, 'a gap can be cut in a railing');
  const d = openingDims('door', m.getWall(walls[2].id).height);
  eq(d.height, BARRIER_HEIGHT, 'clamped to the height of the barrier');
  eq(d.sill, 0);
});

// ------------------------------------------------------------------ open and spiral stairs

test('stairs come in three kinds and keep their place when the kind changes', () => {
  const m = new Model();
  const open = m.addStairs(100, 100, { kind: 'open' });
  eq(open.kind, 'open');
  eq(open.sweep, undefined, 'only a spiral has a sweep');
  nearPt(m.stairsFootprint(open)[0], { x: 100, y: 150 }, 'an open flight has the same footprint as a solid one');
  const sp = m.addStairs(500, 500, { kind: 'spiral' });
  eq(sp.kind, 'spiral'); eq(sp.width, STAIR_KINDS.spiral.width); eq(sp.sweep, STAIR_KINDS.spiral.sweep);
  const fp = m.stairsFootprint(sp);
  eq(fp.length, 16, 'a spiral footprint is a circle');
  for (const q of fp) near(dist(q, { x: 500, y: 500 }), sp.width / 2, 'on the outer radius');
  const info = m.stairsInfo(sp);
  near(info.treadAngle, sp.sweep / info.steps, 'turn per step');
  assert(info.going > 0 && info.going < sp.width, 'tread at the walking line');
  eq(m.stairsInfo(open).treadAngle, 0, 'a straight flight does not turn');
  // Switching kinds keeps the flight where it is.
  const centre = m.stairsCentre(open);
  m.updateStairs(open.id, { kind: 'spiral' });
  nearPt(m.stairsCentre(open), centre, 'straight -> spiral');
  m.updateStairs(open.id, { kind: 'straight' });
  nearPt(m.stairsCentre(open), centre, 'spiral -> straight');
  eq(open.kind, undefined, 'a straight flight stores no kind');
  eq(open.sweep, undefined, 'and no sweep');
});

test('a spiral cuts a round stairwell, and stairs take any angle', () => {
  const m = new Model();
  const sp = m.addStairs(300, 200, { kind: 'spiral', width: 160 });
  const l2 = m.addLevel().id;
  m.setActiveLevel(l2);
  const f = m.addFloor([{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]);
  eq(m.floorHoles(f).length, 1, 'the spiral cuts the floor above');
  eq(m.floorHoles(f)[0].length, 16, 'as a circle');
  m.updateStairs(sp.id, { width: 900 }); // now it sticks out of the floor
  eq(m.floorHoles(f).length, 0, 'a stairwell has to fit inside the floor');
  m.setActiveLevel(m.levels[0].id);
  const st = m.addStairs(0, 0);
  const centre = m.stairsCentre(st);
  m.updateStairs(st.id, { angle: 30 });
  eq(st.angle, 30, 'any angle');
  nearPt(m.stairsCentre(st), centre, 'and it turns about its own centre');
  m.updateStairs(st.id, { angle: -30 });
  eq(st.angle, 330, 'normalised');
  const json = m.serialize();
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  eq(m2.stairs[0].kind, 'spiral');
  const m3 = new Model({ version: 2, stairs: [{ id: 's1', x: 0, y: 0, kind: 'nonsense' }] });
  eq(m3.stairs[0].kind, undefined, 'an unknown kind loads as a straight flight');
});

// ------------------------------------------------------------------ furniture

test('furniture takes its size from the catalog and can be resized or retyped', () => {
  const m = new Model();
  eq(m.addFurniture('nope', 0, 0), null, 'unknown type');
  const bed = m.addFurniture('bed_double', 100, 200);
  const spec = furnitureSpec('bed_double');
  eq(bed.type, 'bed_double'); eq(bed.width, spec.width); eq(bed.depth, spec.depth); eq(bed.height, spec.height);
  eq(bed.angle, 0); eq(bed.elevation, 0); eq(bed.level, m.activeLevel);
  const cab = m.addFurniture('kitchen_wall', 0, 0);
  eq(cab.elevation, 140, 'a wall cabinet hangs at its catalog height');
  const custom = m.addFurniture('chair', 0, 0, { width: 9999, angle: 400 });
  eq(custom.width, 1000, 'size clamped'); eq(custom.angle, 40, 'angle normalised');
  m.updateFurniture(bed.id, { type: 'bedside_table' });
  eq(bed.width, furnitureSpec('bedside_table').width, 'a new type brings its size');
  nearPt(bed, { x: 100, y: 200 }, 'and stays where it was');
  m.updateFurniture(bed.id, { width: 50, angle: 15 });
  eq(bed.width, 50); eq(bed.angle, 15);
  m.moveFurniture(bed.id, 10, -10);
  nearPt(bed, { x: 110, y: 190 });
  assert(m.deleteEntity('furniture', bed.id)); eq(m.furniture.length, 2);
});

test('a furniture footprint follows its angle', () => {
  const m = new Model();
  const f = m.addFurniture('bed', 0, 0); // 90 wide, 200 deep, front at +y
  const fp = m.furnitureFootprint(f);
  nearPt(fp[0], { x: -45, y: -100 }, 'back left'); nearPt(fp[2], { x: 45, y: 100 }, 'front right');
  m.updateFurniture(f.id, { angle: 90 });
  const turned = m.furnitureFootprint(f);
  near(Math.max(...turned.map((q) => q.x)) - Math.min(...turned.map((q) => q.x)), 200, 'the depth now runs along x');
  near(Math.max(...turned.map((q) => q.y)) - Math.min(...turned.map((q) => q.y)), 90);
  const b = m.bounds(m.activeLevel);
  near(b.minX, -100, 'bounds cover the furniture');
});

test('every catalog piece is built from parts inside its box', () => {
  for (const [type, spec] of Object.entries(FURNITURE_TYPES)) {
    const size = { width: spec.width, depth: spec.depth, height: spec.height };
    const parts = furnitureParts(type, size);
    assert(parts.length > 0, `${type} has parts`);
    for (const q of parts) {
      assert(q.w > 0 && q.d > 0 && q.h > 0, `${type}: a part has a size`);
      assert(Math.abs(q.x) + q.w / 2 <= size.width / 2 + 1e-6, `${type}: part inside the width`);
      assert(Math.abs(q.y) + q.d / 2 <= size.depth / 2 + 1e-6, `${type}: part inside the depth`);
      assert(q.z >= -1e-6 && q.z + q.h <= size.height + 1e-6, `${type}: part inside the height`);
    }
  }
});

test('furniture survives levels, serialisation and deletion', () => {
  const m = new Model();
  const l1 = m.activeLevel;
  m.addFurniture('sofa', 100, 100, { angle: 45 });
  const l2 = m.addLevel().id;
  m.setActiveLevel(l2);
  m.addFurniture('bath', 50, 50);
  eq(m.furniture.length, 2);
  eq(m.levelOfEntity('furniture', m.furniture[1].id), l2);
  const json = m.serialize();
  const m2 = new Model(json);
  eq(m2.serialize(), json, 'round trip');
  eq(m2.furniture.length, 2); eq(m2.furniture[0].angle, 45);
  const fresh = m2.addFurniture('chair', 0, 0);
  assert(!m2.furniture.slice(0, 2).some((f) => f.id === fresh.id), 'ids stay unique after a load');
  m2.deleteLevel(l2);
  eq(m2.furniture.length, 2, 'deleting a level takes its furniture (the sofa and the new chair stay)');
  assert(m2.furniture.every((f) => f.level === l1), 'nothing is left on the deleted level');
  const bad = new Model({ version: 2, furniture: [{ id: 'u1', type: 'nope', x: 0, y: 0 }, { id: 'u2', type: 'chair', x: 1, y: 2 }] });
  eq(bad.furniture.length, 1, 'an unknown type is dropped on load');
});

/** Run every test. Returns { passed, failed, results: [{ name, ok, error }] }. */
export function runModelTests() {
  const results = [];
  for (const t of tests) {
    try { t.fn(); results.push({ name: t.name, ok: true }); }
    catch (e) { results.push({ name: t.name, ok: false, error: e && e.message ? e.message : String(e) }); }
  }
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, results };
}
