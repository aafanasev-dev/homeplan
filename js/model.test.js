// Assertions for model.js / geometry.js. No DOM: used by tests.html and run-tests.mjs (node).

import { Model, History, computeWallPolygons, createSampleModel } from './model.js';
import { snap, projectOnSegment, lineIntersect, dist } from './geometry.js';
import { openingDims, MIN_OPENING_WIDTH } from './catalog.js';

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
