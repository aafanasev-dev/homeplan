// 3D preview built from the model with Three.js. Plan (x, y) maps to world (x, z); y is up. Units: cm.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openingDims, openingSpec, wallSpec, stairKindSpec, RAILING, TREAD, SPIRAL_POST, furnitureParts } from './catalog.js';

const FRAME = 5;       // window / door frame width, cm
const LEAF = 4;        // door leaf thickness, cm
const DOOR_OPEN = 65;  // degrees the door leaf is drawn open
const FLOOR_LIFT = 0.5; // cm: floor slabs sit this far above their level so they don't z-fight the ground
const GHOST_OPACITY = 0.18; // levels above the active one
const LEVEL_ANIM_MS = 300;  // camera move when switching level
const CURVE_STEP = 15;      // cm: how finely a curved wall is stepped into boxes

export class View3D {
  constructor(container, model) {
    this.container = container;
    this.model = model;
    this.selection = null;
    this.needsRender = true;
    this._rebuildQueued = false;
    this._fittedOnce = false;
    this._camElev = model.levelElevation(model.activeLevel); // elevation the camera is framed on
    this._levelAnim = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9edf1);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(45, 1, 5, 100000);
    this.camera.position.set(600, 900, 1100);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('change', () => { this.needsRender = true; });

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.5;
    sun.shadow.radius = 4;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200000, 200000),
      new THREE.MeshStandardMaterial({ color: 0xdfe3e6, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(10000, 100, 0xc3c9cf, 0xd2d7dc);
    grid.position.y = 0.2;
    scene.add(grid);

    this.mats = {
      wall: new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.9 }),
      wallSel: new THREE.MeshStandardMaterial({ color: 0x9db8f2, roughness: 0.8 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.5 }),
      doorFrame: new THREE.MeshStandardMaterial({ color: 0x8a6542, roughness: 0.7 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0xa87a4c, roughness: 0.6 }),
      sel: new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.5 }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x9fd0ea, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false,
      }),
      floor: new THREE.MeshStandardMaterial({ color: 0xd8c8a8, roughness: 0.85 }),
      stairs: new THREE.MeshStandardMaterial({ color: 0xc9b08a, roughness: 0.75 }),
      rail: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.35 }),
      // Furniture materials, named by the `mat` of a catalog part.
      case: new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.7 }),
      top: new THREE.MeshStandardMaterial({ color: 0xe0d6c4, roughness: 0.6 }),
      soft: new THREE.MeshStandardMaterial({ color: 0x8e9aa8, roughness: 0.95 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.3 }),
    };
    // Glass never casts a shadow, wherever it is used.
    this.mats.glass.userData.noShadow = true;
    // Levels above the active one: see-through copies that neither write depth nor cast shadows.
    this.ghostMats = {};
    for (const [k, mat] of Object.entries(this.mats)) {
      const g = mat.clone();
      g.transparent = true;
      g.opacity = mat.transparent ? mat.opacity * GHOST_OPACITY : GHOST_OPACITY;
      g.depthWrite = false;
      g.userData.ghost = true;
      this.ghostMats[k] = g;
    }

    this.plan = new THREE.Group();
    scene.add(this.plan);

    model.on(() => this.scheduleRebuild());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.rebuild();
    if (model.walls.length) { this.fit(); this._fittedOnce = true; }

    const loop = () => {
      requestAnimationFrame(loop);
      this.stepLevelAnim();
      const moved = this.controls.update();
      if ((moved || this.needsRender) && this.width && this.height) {
        this.needsRender = false;
        renderer.render(scene, this.camera);
      }
    };
    loop();
  }

  setSelection(sel) {
    this.selection = sel;
    this.scheduleRebuild();
  }

  /** Follow a level switch: move the camera and its target up or down by the change in elevation. */
  setActiveLevel(id) {
    const elev = this.model.levelElevation(id);
    const prev = this._levelAnim;
    // Finish what is left of a move that is still running.
    const leftover = prev ? prev.dy - prev.applied : 0;
    const dy = elev - this._camElev + leftover;
    this._camElev = elev;
    this._levelAnim = Math.abs(dy) > 0.01 ? { dy, applied: 0, start: performance.now() } : null;
    if (!this._levelAnim && leftover) this.shiftCamera(leftover);
    this.scheduleRebuild();
  }

  shiftCamera(dy) {
    this.camera.position.y += dy;
    this.controls.target.y += dy;
    this.needsRender = true;
  }

  stepLevelAnim() {
    const a = this._levelAnim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.start) / LEVEL_ANIM_MS);
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const target = a.dy * eased;
    this.shiftCamera(target - a.applied);
    a.applied = target;
    if (t >= 1) this._levelAnim = null;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.width = w; this.height = h;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  scheduleRebuild() {
    if (this._rebuildQueued) return;
    this._rebuildQueued = true;
    requestAnimationFrame(() => {
      this._rebuildQueued = false;
      this.rebuild();
      // Re-frame the camera when the plan goes from empty to having walls (first load, "New").
      const hasWalls = this.model.walls.length > 0;
      if (hasWalls && !this._fittedOnce) this.fit();
      this._fittedOnce = hasWalls;
    });
  }

  /** Point the camera at the active level (or the whole plan if that level is empty). */
  fit() {
    const m = this.model;
    const b = m.bounds(m.activeLevel) || m.bounds();
    const cx = b ? (b.minX + b.maxX) / 2 : 0, cz = b ? (b.minY + b.maxY) / 2 : 0;
    const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 300) : 800;
    const hgt = b ? b.maxHeight : 270;
    const elev = m.levelElevation(m.activeLevel);
    this._levelAnim = null;
    this._camElev = elev;
    const target = new THREE.Vector3(cx, elev + hgt * 0.3, cz);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const d = (size * 0.75) / Math.tan(fov / 2) / Math.min(1, Math.max(this.camera.aspect, 0.5));
    const dir = new THREE.Vector3(0.45, 0.85, 1).normalize();
    this.camera.position.copy(target).addScaledVector(dir, d);
    this.controls.target.copy(target);
    this.controls.update();
    this.needsRender = true;
  }

  clearPlan() {
    this.plan.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.plan.clear();
  }

  /** Box of size (len along wall, height, depth across wall) placed in wall-local coordinates. */
  box(parent, x0, x1, y0, y1, depth, mat, z = 0, { shadow = true } = {}) {
    const len = x1 - x0, h = y1 - y0;
    if (len <= 0.01 || h <= 0.01 || depth <= 0.01) return null;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, depth), mat);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, z);
    mesh.castShadow = shadow && !mat.userData.ghost && !mat.userData.noShadow;
    mesh.receiveShadow = !mat.userData.ghost;
    parent.add(mesh);
    return mesh;
  }

  /** One group per level at its elevation. Levels above the active one use the see-through materials. */
  rebuild() {
    this.clearPlan();
    const m = this.model;
    const active = m.levelIndex(m.activeLevel);
    m.levels.forEach((level, i) => {
      const g = new THREE.Group();
      g.position.y = m.levelElevation(level.id);
      this.plan.add(g);
      this.buildLevel(g, level, i > active ? this.ghostMats : this.mats);
    });
    this.updateSun();
    this.needsRender = true;
  }

  /** The openings of a wall as spans along it, with their vertical dimensions, in order. */
  wallOpenings(w, L) {
    return this.model.openingsOnWall(w.id)
      .map((o) => ({ o, s0: Math.max(0, o.t - o.width / 2), s1: Math.min(L, o.t + o.width / 2), ...openingDims(o.type, w.height) }))
      .filter((x) => x.s1 - x.s0 > 1)
      .sort((p, q) => p.s0 - q.s0);
  }

  /** The stretches of a wall that are solid, with the spans of its openings taken out. */
  solidSpans(w, L) {
    const spans = [];
    let cursor = 0;
    for (const op of this.wallOpenings(w, L)) {
      if (op.s0 > cursor) spans.push([cursor, op.s0]);
      cursor = Math.max(cursor, op.s1);
    }
    if (L > cursor) spans.push([cursor, L]);
    return spans;
  }

  /** A group placed `along` cm into the wall, turned to its tangent there: x along, y up, z across. */
  wallFrame(parent, w, along) {
    const p = this.model.pointOnWall(w, along), d = this.model.wallDirAt(w, along);
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.y);
    g.rotation.y = -Math.atan2(d.y, d.x);
    parent.add(g);
    return g;
  }

  /**
   * A bar running along the wall between s0 and s1 at height y0..y1. A curved wall is stepped, so
   * the bar follows the arc.
   */
  addBar(parent, w, s0, s1, y0, y1, depth, mat) {
    const steps = w.bulge ? Math.max(1, Math.ceil((s1 - s0) / CURVE_STEP)) : 1;
    for (let i = 0; i < steps; i++) {
      const a = s0 + ((s1 - s0) * i) / steps, b = s0 + ((s1 - s0) * (i + 1)) / steps;
      const half = (b - a) / 2;
      this.box(this.wallFrame(parent, w, (a + b) / 2), -half, half, y0, y1, depth, mat);
    }
  }

  /** The rail that finishes the top of a glass barrier. */
  addCapRail(parent, w, mat) {
    const L = this.model.wallLength(w);
    for (const [s0, s1] of this.solidSpans(w, L)) {
      this.addBar(parent, w, s0, s1, w.height - RAILING.rail / 2, w.height, w.thickness + 2, mat);
    }
  }

  /** A railing: a top bar carried by posts, following the wall (and its curve) and skipping openings. */
  buildRailing(parent, w, mat) {
    const L = this.model.wallLength(w);
    const H = w.height;
    const railTop = Math.max(RAILING.rail, H);
    for (const [s0, s1] of this.solidSpans(w, L)) {
      if (s1 - s0 < 1) continue;
      this.addBar(parent, w, s0, s1, railTop - RAILING.rail, railTop, w.thickness, mat);
      // Posts at both ends of the span and evenly in between.
      const n = Math.max(1, Math.round((s1 - s0) / RAILING.gap));
      for (let i = 0; i <= n; i++) {
        const at = s0 + ((s1 - s0) * i) / n;
        const half = RAILING.post / 2;
        this.box(this.wallFrame(parent, w, at), -half, half, 0, railTop - RAILING.rail, Math.min(w.thickness, RAILING.post), mat);
      }
    }
  }

  /** How far a wall reaches past a node, to fill the joint with its neighbours. */
  wallExt(w, nodeId) {
    const others = this.model.wallsAtNode(nodeId).filter((x) => x !== w);
    return others.length ? Math.max(...others.map((x) => x.thickness / 2)) : 0;
  }

  buildLevel(parent, level, mats) {
    const m = this.model;
    const sel = this.selection;
    for (const w of m.walls) {
      if (w.level !== level.id) continue;
      const selected = sel?.kind === 'wall' && sel.id === w.id;
      const look = wallSpec(w.style).look;
      if (look === 'railing') { this.buildRailing(parent, w, selected ? mats.wallSel : mats.rail); continue; }
      const wallMat = selected ? mats.wallSel : look === 'glass' ? mats.glass : mats.wall;
      // A glass barrier gets a cap rail along the top, so the pane reads as a barrier.
      if (look === 'glass') this.addCapRail(parent, w, selected ? mats.wallSel : mats.rail);
      if (w.bulge) { this.buildCurvedWall(parent, w, wallMat, mats); continue; }
      const { a, b } = m.wallEnds(w);
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.01) continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Wall-local frame: x along the wall from node a, y up, z = plan normal perp(u).
      const g = new THREE.Group();
      g.position.set(a.x, 0, a.y);
      g.rotation.y = -angle;
      parent.add(g);

      const extA = this.wallExt(w, w.a), extB = this.wallExt(w, w.b);
      const T = w.thickness, H = w.height;
      const ops = this.wallOpenings(w, L);

      let cursor = -extA;
      for (const op of ops) {
        if (op.s0 > cursor) this.box(g, cursor, op.s0, 0, H, T, wallMat);
        const s0 = Math.max(op.s0, cursor);
        if (op.s1 > s0) {
          if (op.sill > 0) this.box(g, s0, op.s1, 0, op.sill, T, wallMat);
          if (op.top < H) this.box(g, s0, op.s1, op.top, H, T, wallMat);
        }
        cursor = Math.max(cursor, op.s1);
        const selected = sel?.kind === 'opening' && sel.id === op.o.id;
        this.addFiller(g, op, T, selected, mats);
      }
      if (L + extB > cursor) this.box(g, cursor, L + extB, 0, H, T, wallMat);
    }
    for (const f of m.floors) {
      // Cutouts are not built: they only act as holes in the slabs of their level (floorHoles).
      if (f.level === level.id && f.kind !== 'cutout') {
        this.addFloor(parent, f, sel?.kind === 'floor' && sel.id === f.id ? mats.wallSel : mats.floor);
      }
    }
    for (const st of m.stairs) {
      if (st.level === level.id) this.addStairs(parent, st, sel?.kind === 'stairs' && sel.id === st.id ? mats.wallSel : mats.stairs);
    }
    for (const f of m.furniture) {
      if (f.level === level.id) this.addFurniture(parent, f, mats, sel?.kind === 'furniture' && sel.id === f.id);
    }
  }

  /** A piece of furniture: one box per catalog part, in the item's own frame. */
  addFurniture(parent, f, mats, selected) {
    const g = new THREE.Group();
    g.position.set(f.x, f.elevation || 0, f.y);
    g.rotation.y = -(f.angle * Math.PI) / 180;
    parent.add(g);
    for (const q of furnitureParts(f.type, f)) {
      // Catalog parts are x along the width, y along the depth (world z) and z up.
      const mat = selected ? mats.wallSel : (mats[q.mat] || mats.case);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(q.w, q.h, q.d), mat);
      mesh.position.set(q.x, q.z + q.h / 2, q.y);
      mesh.castShadow = !mat.userData.ghost && !mat.userData.noShadow;
      mesh.receiveShadow = !mat.userData.ghost;
      g.add(mesh);
    }
  }

  /**
   * A curved wall: short boxes stepped along the arc, each in its own tangent frame, with the
   * openings left out of the solid the same way the straight builder does. Each opening's filler
   * is a straight unit on the chord of its span, tangent at the middle of the opening.
   */
  buildCurvedWall(parent, w, wallMat, mats) {
    const m = this.model;
    const sel = this.selection;
    const L = m.wallLength(w);
    if (L < 0.01) return;
    const T = w.thickness, H = w.height;
    const ops = this.wallOpenings(w, L);
    const steps = Math.max(1, Math.ceil(L / CURVE_STEP));
    const frame = (along) => this.wallFrame(parent, w, along);
    for (let i = 0; i < steps; i++) {
      const s0 = (L * i) / steps, s1 = (L * (i + 1)) / steps;
      const mid = (s0 + s1) / 2;
      // Boxes are as long as the arc they replace, so neighbours overlap instead of leaving gaps.
      const half = (s1 - s0) / 2;
      const g = frame(mid);
      const op = ops.find((x) => mid > x.s0 && mid < x.s1);
      if (!op) { this.box(g, -half, half, 0, H, T, wallMat); continue; }
      if (op.sill > 0) this.box(g, -half, half, 0, op.sill, T, wallMat);
      if (op.top < H) this.box(g, -half, half, op.top, H, T, wallMat);
    }
    // Fill the joints at both ends, along the end tangents.
    const extA = this.wallExt(w, w.a), extB = this.wallExt(w, w.b);
    if (extA > 0.01) this.box(frame(0), -extA, 0, 0, H, T, wallMat);
    if (extB > 0.01) this.box(frame(L), 0, extB, 0, H, T, wallMat);
    for (const op of ops) {
      const mid = (op.s0 + op.s1) / 2;
      const p0 = m.pointOnWall(w, op.s0), p1 = m.pointOnWall(w, op.s1);
      const span = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const selected = sel?.kind === 'opening' && sel.id === op.o.id;
      this.addFiller(frame(mid), { ...op, s0: -span / 2, s1: span / 2 }, T, selected, mats);
    }
  }

  /** Floor slab: the plan polygon (y -> world z) with stairwell holes, extruded downwards from the level. */
  addFloor(parent, f, mat) {
    const shape = new THREE.Shape(f.points.map((p) => new THREE.Vector2(p.x, p.y)));
    for (const h of this.model.floorHoles(f)) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: f.thickness, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, mat);
    // Rotating +90 deg about x maps shape (x, y, z) to world (x, -z, y): the slab spans -thickness..0.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = FLOOR_LIFT;
    mesh.castShadow = !mat.userData.ghost;
    mesh.receiveShadow = !mat.userData.ghost;
    parent.add(mesh);
  }

  /**
   * Stairs: a stepped solid, the same flight as floating treads, or a spiral of treads about a
   * central post.
   */
  addStairs(parent, st, mat) {
    const m = this.model;
    const { steps, riser, going, treadAngle } = m.stairsInfo(st);
    if (m.isSpiral(st)) {
      const r = st.width / 2;
      const post = new THREE.Group();
      post.position.set(st.x, 0, st.y);
      parent.add(post);
      this.box(post, -SPIRAL_POST / 2, SPIRAL_POST / 2, 0, steps * riser, SPIRAL_POST, mat);
      for (let i = 0; i < steps; i++) {
        const g = new THREE.Group();
        g.position.set(st.x, 0, st.y);
        g.rotation.y = -((st.angle + treadAngle * i) * Math.PI) / 180;
        parent.add(g);
        // A tread reaches from the post to the outer radius, as wide as its share of the turn.
        const w = Math.max(10, 2 * r * Math.sin(Math.abs((treadAngle * Math.PI) / 180) / 2));
        const y = (i + 1) * riser;
        const span = new THREE.Group();
        span.rotation.y = -((treadAngle / 2) * Math.PI) / 180;
        g.add(span);
        this.box(span, SPIRAL_POST / 2, r, y - TREAD, y, w, mat);
      }
      return;
    }
    const u = m.stairsDir(st);
    // Local frame like a wall: x up the flight from (x, y), y up, z across the width.
    const g = new THREE.Group();
    g.position.set(st.x, 0, st.y);
    g.rotation.y = -Math.atan2(u.y, u.x);
    parent.add(g);
    const open = !stairKindSpec(st.kind).solid;
    for (let i = 0; i < steps; i++) {
      const y = (i + 1) * riser;
      if (open) this.box(g, i * going, (i + 1) * going, y - TREAD, y, st.width, mat);
      else this.box(g, i * going, (i + 1) * going, 0, y, st.width, mat);
    }
  }

  /** What fills an opening: door leaves and frame, or window frame, mullions and glass. */
  addFiller(g, op, T, selected, mats = this.mats) {
    const spec = openingSpec(op.o.type);
    if (spec.kind === 'door') this.addDoorFiller(g, op, T, selected, mats, spec);
    else this.addWindowFiller(g, op, T, selected, mats, spec);
  }

  addDoorFiller(g, op, T, selected, mats, spec) {
    const { o, s0, s1, sill, top } = op;
    const fm = selected ? mats.sel : mats.doorFrame;
    const leafMat = selected ? mats.sel : mats.leaf;
    const fw = Math.min(FRAME, (s1 - s0) / 4);
    const swing = o.swing || 0;
    const flip = (swing & 1) === 1;
    const side = (swing & 2) ? -1 : 1;

    if (spec.style === 'garage') {
      // Sectional panel closing the opening, drawn as stacked slats.
      const slats = Math.max(2, Math.round((top - sill) / 50));
      const gap = 1;
      for (let i = 0; i < slats; i++) {
        const y0 = sill + ((top - sill) * i) / slats;
        const y1 = sill + ((top - sill) * (i + 1)) / slats - gap;
        this.box(g, s0 + 1, s1 - 1, y0, y1, Math.min(T, 8), leafMat);
      }
      this.box(g, s0, s0 + fw, sill, top, T, fm);
      this.box(g, s1 - fw, s1, sill, top, T, fm);
      this.box(g, s0 + fw, s1 - fw, top - fw, top, T, fm);
      return;
    }

    this.box(g, s0, s0 + fw, sill, top, T, fm);
    this.box(g, s1 - fw, s1, sill, top, T, fm);
    this.box(g, s0 + fw, s1 - fw, top - fw, top, T, fm);

    if (spec.style === 'slide') {
      // Surface-mounted slider: the leaf hangs outside the wall face and is parked to one side.
      const leafW = s1 - s0;
      const leafH = top - fw - sill - 1;
      const shift = leafW * 0.85 * (flip ? -1 : 1);
      const z = side * (T / 2 + LEAF);
      this.box(g, s0 + shift, s0 + shift + leafW, sill + 0.5, sill + 0.5 + leafH, LEAF, leafMat, z);
      // Track above the opening, long enough for the leaf to slide along.
      const t0 = Math.min(s0, s0 + shift) - fw, t1 = Math.max(s1, s1 + shift) + fw;
      this.box(g, t0, t1, top, top + Math.min(fw, 4), LEAF, fm, z);
      return;
    }

    // Swinging leaves: one, or two hinged at opposite jambs.
    const leaves = spec.leaves >= 2 ? 2 : 1;
    const leafH = top - fw - sill - 1;
    const span = s1 - s0 - 2 * fw;
    const leafW = span / leaves;
    const hinges = leaves === 2
      ? [{ s: s0 + fw, sign: 1 }, { s: s1 - fw, sign: -1 }]
      : [{ s: flip ? s1 - fw : s0 + fw, sign: flip ? -1 : 1 }];
    for (const hinge of hinges) {
      const pivot = new THREE.Group();
      pivot.position.set(hinge.s, sill + 0.5, side * (T / 2 - LEAF / 2));
      pivot.rotation.y = -side * hinge.sign * THREE.MathUtils.degToRad(DOOR_OPEN);
      g.add(pivot);
      this.box(pivot, hinge.sign > 0 ? 0 : -leafW, hinge.sign > 0 ? leafW : 0, 0, leafH, LEAF, leafMat);
    }
  }

  addWindowFiller(g, op, T, selected, mats, spec) {
    const { s0, s1, sill, top } = op;
    const fm = selected ? mats.sel : mats.frame;
    const fw = Math.min(FRAME, (s1 - s0) / 4, (top - sill) / 4);
    this.box(g, s0, s0 + fw, sill, top, T, fm);
    this.box(g, s1 - fw, s1, sill, top, T, fm);
    this.box(g, s0 + fw, s1 - fw, sill, sill + fw, T, fm);
    this.box(g, s0 + fw, s1 - fw, top - fw, top, T, fm);
    // One mullion per pane division, plus one in a wide single-pane sash so it does not look bare.
    const panes = spec.panes > 1 ? spec.panes : (spec.height == null && s1 - s0 > 100 ? 2 : 1);
    for (let i = 1; i < panes; i++) {
      const mid = s0 + ((s1 - s0) * i) / panes;
      this.box(g, mid - fw / 2, mid + fw / 2, sill + fw, top - fw, Math.min(T, 8), fm);
    }
    this.box(g, s0 + fw, s1 - fw, sill + fw, top - fw, 1, mats.glass, 0, { shadow: false });
  }

  /** Sun and shadow camera sized to every level. */
  updateSun() {
    const m = this.model;
    const b = m.bounds();
    const cx = b ? (b.minX + b.maxX) / 2 : 0, cz = b ? (b.minY + b.maxY) / 2 : 0;
    const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 400) : 1000;
    const top = m.levels.reduce((sum, l) => sum + l.height, 0);
    this.sun.position.set(cx + size * 0.6, size * 1.2 + 600 + top, cz + size * 0.9);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    const r = size * 0.9 + 300;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 10; cam.far = size * 4 + 3000 + top * 2;
    cam.updateProjectionMatrix();
  }
}
