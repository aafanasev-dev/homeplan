// 3D preview built from the model with Three.js. Plan (x, y) maps to world (x, z); y is up. Units: cm.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openingDims, OPENING_TYPES } from './catalog.js';

const FRAME = 5;       // window / door frame width, cm
const LEAF = 4;        // door leaf thickness, cm
const DOOR_OPEN = 65;  // degrees the door leaf is drawn open

export class View3D {
  constructor(container, model) {
    this.container = container;
    this.model = model;
    this.selection = null;
    this.needsRender = true;
    this._rebuildQueued = false;
    this._fittedOnce = false;

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
    };

    this.plan = new THREE.Group();
    scene.add(this.plan);

    model.on(() => this.scheduleRebuild());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.rebuild();
    if (model.walls.length) { this.fit(); this._fittedOnce = true; }

    const loop = () => {
      requestAnimationFrame(loop);
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

  /** Point the camera at the whole plan. */
  fit() {
    const b = this.model.bounds();
    const cx = b ? (b.minX + b.maxX) / 2 : 0, cz = b ? (b.minY + b.maxY) / 2 : 0;
    const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 300) : 800;
    const hgt = b ? b.maxHeight : 270;
    const target = new THREE.Vector3(cx, hgt * 0.3, cz);
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
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  rebuild() {
    this.clearPlan();
    const m = this.model;
    const sel = this.selection;
    for (const w of m.walls) {
      const { a, b } = m.wallEnds(w);
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.01) continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Wall-local frame: x along the wall from node a, y up, z = plan normal perp(u).
      const g = new THREE.Group();
      g.position.set(a.x, 0, a.y);
      g.rotation.y = -angle;
      this.plan.add(g);

      // Extend into joined corners by half the thickness of the neighbouring walls.
      const ext = (nodeId) => {
        const others = m.wallsAtNode(nodeId).filter((x) => x !== w);
        return others.length ? Math.max(...others.map((x) => x.thickness / 2)) : 0;
      };
      const extA = ext(w.a), extB = ext(w.b);
      const T = w.thickness, H = w.height;
      const wallMat = sel?.kind === 'wall' && sel.id === w.id ? this.mats.wallSel : this.mats.wall;

      const ops = m.openingsOnWall(w.id)
        .map((o) => ({ o, s0: Math.max(0, o.t - o.width / 2), s1: Math.min(L, o.t + o.width / 2), ...openingDims(o.type, H) }))
        .filter((x) => x.s1 - x.s0 > 1)
        .sort((p, q) => p.s0 - q.s0);

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
        this.addFiller(g, op, T, selected);
      }
      if (L + extB > cursor) this.box(g, cursor, L + extB, 0, H, T, wallMat);
    }
    this.updateSun();
    this.needsRender = true;
  }

  addFiller(g, op, T, selected) {
    const { o, s0, s1, sill, top } = op;
    const kind = OPENING_TYPES[o.type].kind;
    if (kind === 'door') {
      const fm = selected ? this.mats.sel : this.mats.doorFrame;
      const fw = Math.min(FRAME, (s1 - s0) / 4);
      this.box(g, s0, s0 + fw, sill, top, T, fm);
      this.box(g, s1 - fw, s1, sill, top, T, fm);
      this.box(g, s0 + fw, s1 - fw, top - fw, top, T, fm);
      const swing = o.swing || 0;
      const hingeAtEnd = (swing & 1) === 1;
      const side = (swing & 2) ? -1 : 1;
      const leafW = s1 - s0 - 2 * fw;
      const leafH = top - fw - sill - 1;
      const pivot = new THREE.Group();
      pivot.position.set(hingeAtEnd ? s1 - fw : s0 + fw, sill + 0.5, side * (T / 2 - LEAF / 2));
      const hingeSign = hingeAtEnd ? -1 : 1;
      pivot.rotation.y = -side * hingeSign * THREE.MathUtils.degToRad(DOOR_OPEN);
      g.add(pivot);
      this.box(pivot, hingeSign > 0 ? 0 : -leafW, hingeSign > 0 ? leafW : 0, 0, leafH, LEAF, selected ? this.mats.sel : this.mats.leaf);
    } else {
      const fm = selected ? this.mats.sel : this.mats.frame;
      const fw = Math.min(FRAME, (s1 - s0) / 4, (top - sill) / 4);
      this.box(g, s0, s0 + fw, sill, top, T, fm);
      this.box(g, s1 - fw, s1, sill, top, T, fm);
      this.box(g, s0 + fw, s1 - fw, sill, sill + fw, T, fm);
      this.box(g, s0 + fw, s1 - fw, top - fw, top, T, fm);
      if (o.type !== 'window' && s1 - s0 > 100) {
        // Mullion in wide tall/full-height windows.
        const mid = (s0 + s1) / 2;
        this.box(g, mid - fw / 2, mid + fw / 2, sill + fw, top - fw, Math.min(T, 8), fm);
      }
      this.box(g, s0 + fw, s1 - fw, sill + fw, top - fw, 1, this.mats.glass, 0, { shadow: false });
    }
  }

  updateSun() {
    const b = this.model.bounds();
    const cx = b ? (b.minX + b.maxX) / 2 : 0, cz = b ? (b.minY + b.maxY) / 2 : 0;
    const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 400) : 1000;
    this.sun.position.set(cx + size * 0.6, size * 1.2 + 600, cz + size * 0.9);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    const r = size * 0.9 + 300;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 10; cam.far = size * 4 + 3000;
    cam.updateProjectionMatrix();
  }
}
