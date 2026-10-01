// 2D plan editor: canvas rendering, pan/zoom, tools, hit-testing and drag logic.

import {
  GRID, EPS, add, sub, scale, dist, perp, snap, snapPoint, clamp, angleOf, round, pointInPolygon, polygonArea,
} from './geometry.js';
import { computeWallPolygons } from './model.js';
import { OPENING_TYPES, STAIR_DEFAULTS } from './catalog.js';

const OPENING_SNAP_DIST = 40; // cm: how close the cursor must be to a wall to place an opening
const DRAG_THRESHOLD = 3;     // px before a press becomes a drag
const MIN_SCALE = 0.03, MAX_SCALE = 12; // px per cm
const CLOSE_DIST = 10;        // px: clicking this close to a floor's first point closes it
const GHOST_ALPHA = 0.3;      // opacity of the level below

export const TOOLS = {
  select:      { label: 'Select',             key: 'v', hint: 'Click to select, drag to move. Double-click a wall to split it. Drag empty space to pan.' },
  wall:        { label: 'Wall',               key: 'w', hint: 'Click to start, click to add corners. Esc, right-click or double-click ends the chain. Shift keeps it straight.' },
  door:        { label: 'Door',               key: 'd', opening: 'door' },
  window:      { label: 'Window',             key: '1', opening: 'window' },
  window_tall: { label: 'Tall window',        key: '2', opening: 'window_tall' },
  window_full: { label: 'Full-height window', key: '3', opening: 'window_full' },
  split:       { label: 'Split',              key: 's', hint: 'Click on a wall to split it into two segments.' },
  floor:       { label: 'Floor',              key: 'g', hint: 'Click to add corners. Click the first corner, double-click or press Enter to close; Esc cancels. Shift keeps edges straight.' },
  stairs:      { label: 'Stairs',             key: 't', hint: 'Click to place a flight climbing to the right; rotate it from its menu. It cuts a stairwell in the floor above.' },
};

const fmtM = (cm) => `${round(cm / 100, 2).toFixed(2)} m`;

export class Editor2D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./model.js').Model} model
   * @param {object} opts { menuEl, onSelectionChange, onCommit, onToolChange, onStatus }
   */
  constructor(canvas, model, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;
    this.opts = opts;
    this.menuEl = opts.menuEl || null;

    this.scale = 0.6;
    this.ox = 0;
    this.oy = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    this.tool = 'select';
    this.selection = null; // { kind: 'node'|'wall'|'opening'|'floor'|'stairs', id }
    this.hover = null;
    this.drag = null;
    this.chain = null;     // wall tool: { last: {x,y}, start: {x,y}, count }
    this.floorDraw = null; // floor tool: { points: [{x,y}] }
    this.stairGhost = null; // stairs tool preview: { x, y }
    this.ghost = null;     // opening tool preview
    this.splitPreview = null;
    this.cursor = null;    // world position of the mouse
    this.cursorScreen = null;
    this.keys = { space: false, alt: false, shift: false };
    this._raf = 0;

    this.readTheme();
    this.bindEvents();
    this.model.on(() => this.onModelChange());
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement);
    this.resize();
  }

  // ---------------------------------------------------------------- theme

  readTheme() {
    const cs = getComputedStyle(this.canvas);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    this.c = {
      bg: v('--plan-bg', '#fbfaf7'),
      gridMinor: v('--plan-grid-minor', '#ecebe5'),
      gridMajor: v('--plan-grid-major', '#d6d3c8'),
      axis: v('--plan-axis', '#b9b5a6'),
      label: v('--plan-label', '#8a877c'),
      wall: v('--plan-wall', '#3b4049'),
      wallEdge: v('--plan-wall-edge', '#1f2329'),
      wallHover: v('--plan-wall-hover', '#565d69'),
      accent: v('--accent', '#2563eb'),
      accentSoft: v('--accent-soft', 'rgba(37,99,235,0.35)'),
      door: v('--plan-door', '#9a6a3a'),
      glass: v('--plan-glass', '#cfe8f6'),
      glassEdge: v('--plan-glass-edge', '#2b7bb0'),
      invalid: v('--danger', '#dc2626'),
      text: v('--plan-text', '#1f2329'),
      pill: v('--plan-pill', 'rgba(255,255,255,0.9)'),
      floor: v('--plan-floor', '#efe9dd'),
    };
  }

  // ---------------------------------------------------------------- view transform

  w2s(p) { return { x: p.x * this.scale + this.ox, y: p.y * this.scale + this.oy }; }
  s2w(p) { return { x: (p.x - this.ox) / this.scale, y: (p.y - this.oy) / this.scale }; }
  px(n) { return n / this.scale; } // screen px -> cm

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    const first = this.cssW === 0;
    const dpr = window.devicePixelRatio || 1;
    // Keep the world point at the centre fixed when the pane changes size.
    const centre = first ? null : this.s2w({ x: this.cssW / 2, y: this.cssH / 2 });
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (first) {
      if (this.model.walls.length) this.fit();
      else { this.ox = w / 2 - 300 * this.scale; this.oy = h / 2 - 200 * this.scale; }
    } else {
      this.ox = w / 2 - centre.x * this.scale;
      this.oy = h / 2 - centre.y * this.scale;
    }
    this.render();
  }

  /** Frame the active level (or every level if it is empty). */
  fit() {
    const b = this.model.bounds(this.model.activeLevel) || this.model.bounds();
    if (!b || !this.cssW) return;
    const pad = 70;
    const bw = Math.max(b.maxX - b.minX, 100), bh = Math.max(b.maxY - b.minY, 100);
    this.scale = clamp(Math.min((this.cssW - 2 * pad) / bw, (this.cssH - 2 * pad) / bh), MIN_SCALE, MAX_SCALE);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.ox = this.cssW / 2 - cx * this.scale;
    this.oy = this.cssH / 2 - cy * this.scale;
    this.requestRender();
  }

  zoomAt(screen, factor) {
    const before = this.s2w(screen);
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    this.ox = screen.x - before.x * this.scale;
    this.oy = screen.y - before.y * this.scale;
    this.requestRender();
  }

  // ---------------------------------------------------------------- public API

  setTool(tool) {
    if (!TOOLS[tool]) return;
    this.endChain();
    this.floorDraw = null;
    this.tool = tool;
    this.ghost = null;
    this.splitPreview = null;
    this.stairGhost = null;
    this.hideMenu();
    this.updateCursorStyle();
    this.opts.onToolChange?.(tool);
    this.refreshPreview();
    this.status();
    this.requestRender();
  }

  setSelection(sel) {
    if (sel && !this.model.getEntity(sel.kind, sel.id)) sel = null;
    const same = (sel && this.selection && sel.kind === this.selection.kind && sel.id === this.selection.id) ||
      (!sel && !this.selection);
    this.selection = sel;
    if (!same) this.opts.onSelectionChange?.(sel);
    this.requestRender();
  }

  /** Esc: end the wall chain (or drop the floor being drawn), then leave the tool, then clear the selection. */
  cancel() {
    this.hideMenu();
    if (this.drag) return;
    if (this.chain) { this.endChain(); this.requestRender(); return; }
    if (this.floorDraw) { this.floorDraw = null; this.requestRender(); return; }
    if (this.tool !== 'select') { this.setTool('select'); return; }
    this.setSelection(null);
  }

  isBusy() { return !!this.drag; }

  commit() { this.opts.onCommit?.(); }

  onModelChange() {
    if (this.selection && !this.model.getEntity(this.selection.kind, this.selection.id)) this.setSelection(null);
    this.requestRender();
  }

  /** The active level changed: drop anything in progress and the selection, which belong to the old level. */
  onLevelChange() {
    this.hideMenu();
    this.endChain();
    this.floorDraw = null;
    this.setSelection(null);
    this.refreshPreview();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  // ---------------------------------------------------------------- snapping helpers

  nodeSnapRadius() { return Math.min(this.px(10), 30); }

  /** Snap a world point for drawing: existing node first, then the 10 cm grid (unless Alt). */
  snapDraw(p, excludeNodeId = null) {
    const n = this.model.nodeNear(p, this.nodeSnapRadius(), excludeNodeId);
    if (n) return { x: n.x, y: n.y, node: n };
    return this.keys.alt ? { x: p.x, y: p.y } : snapPoint(p, GRID);
  }

  /** Snap an opening centre so that its start edge sits on the 10 cm grid along the wall. */
  snapAlong(along, width) {
    return this.keys.alt ? along : snap(along - width / 2, GRID) + width / 2;
  }

  snapLen(v) { return this.keys.alt ? v : snap(v, GRID); }

  // ---------------------------------------------------------------- hit testing

  openingHandles(o) {
    const w = this.model.getWall(o.wallId);
    if (!w) return [];
    return [
      { end: 'start', p: this.model.pointOnWall(w, o.t - o.width / 2) },
      { end: 'end', p: this.model.pointOnWall(w, o.t + o.width / 2) },
    ];
  }

  /**
   * Only the active level is hit. Priority: opening resize handles, floor vertex handles of the
   * selected floor, openings, nodes, walls, stairs, floors.
   */
  hitTest(screen) {
    const p = this.s2w(screen);
    const m = this.model;
    const L = m.activeLevel;
    if (this.selection?.kind === 'opening') {
      const o = m.getOpening(this.selection.id);
      if (o) {
        for (const h of this.openingHandles(o)) {
          if (dist(this.w2s(h.p), screen) <= 8) return { kind: 'handle', id: o.id, end: h.end };
        }
      }
    }
    if (this.selection?.kind === 'floor') {
      const f = m.getFloor(this.selection.id);
      if (f) {
        for (let i = 0; i < f.points.length; i++) {
          if (dist(this.w2s(f.points[i]), screen) <= 8) return { kind: 'floorVertex', id: f.id, index: i };
        }
      }
    }
    let best = null, bestD = Infinity;
    for (const o of m.openings) {
      const w = m.getWall(o.wallId);
      if (!w || w.level !== L) continue;
      const proj = m.projectOnWall(w, p);
      if (Math.abs(proj.along - o.t) <= o.width / 2 && proj.dist <= w.thickness / 2 + this.px(4) && proj.dist < bestD) {
        best = { kind: 'opening', id: o.id }; bestD = proj.dist;
      }
    }
    if (best) return best;
    for (const n of m.nodes) {
      if (n.level !== L) continue;
      const maxHalf = Math.max(0, ...m.wallsAtNode(n.id).map((w) => w.thickness / 2));
      const r = Math.max(this.px(8), Math.min(maxHalf, this.px(20)));
      const d = dist(n, p);
      if (d <= r && d < bestD) { best = { kind: 'node', id: n.id }; bestD = d; }
    }
    if (best) return best;
    for (const w of m.walls) {
      if (w.level !== L) continue;
      const proj = m.projectOnWall(w, p);
      if (proj.rawT < -0.001 || proj.rawT > 1.001) continue;
      if (proj.dist <= w.thickness / 2 + this.px(3) && proj.dist < bestD) { best = { kind: 'wall', id: w.id }; bestD = proj.dist; }
    }
    if (best) return best;
    // Stairs and floors: the last drawn is on top.
    for (let i = m.stairs.length - 1; i >= 0; i--) {
      const st = m.stairs[i];
      if (st.level === L && pointInPolygon(p, m.stairsFootprint(st))) return { kind: 'stairs', id: st.id };
    }
    for (let i = m.floors.length - 1; i >= 0; i--) {
      const f = m.floors[i];
      if (f.level !== L || !pointInPolygon(p, f.points)) continue;
      if (m.floorHoles(f).some((h) => pointInPolygon(p, h))) continue; // in the stairwell
      return { kind: 'floor', id: f.id };
    }
    return null;
  }

  /** Wall under the cursor for the split tool (generous tolerance). */
  wallAt(p) {
    const hit = this.model.nearestWall(p, Infinity);
    if (!hit) return null;
    if (hit.proj.dist > hit.wall.thickness / 2 + this.px(6)) return null;
    return hit;
  }

  // ---------------------------------------------------------------- events

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.cursor = null; this.hover = null; this.ghost = null; this.splitPreview = null; this.stairGhost = null; this.requestRender(); } });
    c.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = this.screenPoint(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(s, Math.exp(-delta * 0.0015));
      this.updatePointer(e);
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => this.onContextMenu(e));

    const keyState = (e, down) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
      this.keys.alt = e.altKey; this.keys.shift = e.shiftKey;
      if (e.code === 'Space' && !typing) {
        this.keys.space = down;
        if (down) e.preventDefault();
        this.updateCursorStyle();
      }
      if (e.key === 'Alt') e.preventDefault();
      if (this.cursorScreen && !this.drag) this.refreshPreview();
      if (this.drag && this.lastPointerEvent) this.applyDrag(this.lastPointerEvent);
    };
    window.addEventListener('keydown', (e) => keyState(e, true));
    window.addEventListener('keyup', (e) => keyState(e, false));
    window.addEventListener('blur', () => { this.keys = { space: false, alt: false, shift: false }; this.updateCursorStyle(); });
    document.addEventListener('pointerdown', (e) => { if (this.menuEl && !this.menuEl.contains(e.target)) this.hideMenu(); });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', () => { this.readTheme(); this.requestRender(); });
  }

  screenPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  updatePointer(e) {
    this.keys.alt = e.altKey; this.keys.shift = e.shiftKey;
    this.cursorScreen = this.screenPoint(e);
    this.cursor = this.s2w(this.cursorScreen);
  }

  onPointerDown(e) {
    this.hideMenu();
    this.canvas.focus?.({ preventScroll: true });
    this.updatePointer(e);
    const s = this.cursorScreen, p = this.cursor;
    if (e.button === 1 || (e.button === 0 && this.keys.space)) {
      e.preventDefault();
      this.startDrag(e, { kind: 'pan' });
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'select') {
      const hit = this.hitTest(s);
      if (!hit) { this.setSelection(null); this.startDrag(e, { kind: 'pan' }); return; }
      if (hit.kind === 'handle') {
        this.startDrag(e, { kind: 'handle', id: hit.id, end: hit.end });
        return;
      }
      if (hit.kind === 'floorVertex') {
        this.startDrag(e, { kind: 'floorVertex', id: hit.id, index: hit.index });
        return;
      }
      this.setSelection({ kind: hit.kind, id: hit.id });
      if (hit.kind === 'node') this.startDrag(e, { kind: 'node', id: hit.id });
      else if (hit.kind === 'wall') {
        const { a, b } = this.model.wallEnds(hit.id);
        this.startDrag(e, { kind: 'wall', id: hit.id, start: p, origA: { x: a.x, y: a.y }, origB: { x: b.x, y: b.y } });
      } else if (hit.kind === 'opening') {
        const o = this.model.getOpening(hit.id);
        const proj = this.model.projectOnWall(o.wallId, p);
        this.startDrag(e, { kind: 'opening', id: hit.id, grabWall: o.wallId, grabOffset: proj.along - o.t });
      } else if (hit.kind === 'floor') {
        const f0 = this.model.getFloor(hit.id).points[0];
        this.startDrag(e, { kind: 'floor', id: hit.id, start: p, orig: { x: f0.x, y: f0.y } });
      } else if (hit.kind === 'stairs') {
        const st = this.model.getStairs(hit.id);
        this.startDrag(e, { kind: 'stairs', id: hit.id, start: p, orig: { x: st.x, y: st.y } });
      }
      return;
    }

    if (this.tool === 'wall') { this.wallClick(p); return; }
    if (this.tool === 'floor') { this.floorClick(p); return; }

    if (this.tool === 'stairs') {
      const q = this.snapDraw(p);
      const st = this.model.addStairs(q.x, q.y);
      if (st) { this.commit(); this.setSelection({ kind: 'stairs', id: st.id }); }
      this.refreshPreview();
      return;
    }

    if (TOOLS[this.tool].opening) {
      const g = this.computeGhost(p);
      this.ghost = g;
      if (g.valid) {
        const o = this.model.addOpening(g.wallId, g.type, g.t, g.width);
        if (o) { this.commit(); this.refreshPreview(); }
      }
      this.requestRender();
      return;
    }

    if (this.tool === 'split') {
      const hit = this.wallAt(p);
      if (hit) {
        const res = this.model.splitWall(hit.wall.id, p, { snap: this.keys.alt ? 0 : GRID });
        if (res) { this.commit(); this.setSelection({ kind: 'node', id: res.node.id }); }
      }
      this.refreshPreview();
    }
  }

  startDrag(e, drag) {
    drag.downScreen = this.cursorScreen;
    drag.lastScreen = this.cursorScreen;
    drag.moved = false;
    drag.pointerId = e.pointerId;
    this.drag = drag;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.updateCursorStyle();
  }

  onPointerMove(e) {
    this.updatePointer(e);
    this.lastPointerEvent = e;
    if (this.drag) { this.applyDrag(e); return; }
    this.refreshPreview();
  }

  /** Recompute hover / ghost / previews for the current cursor without dragging. */
  refreshPreview() {
    if (!this.cursorScreen) { this.requestRender(); return; }
    const p = this.cursor;
    this.hover = null; this.ghost = null; this.splitPreview = null; this.stairGhost = null;
    if (this.tool === 'select') this.hover = this.hitTest(this.cursorScreen);
    else if (TOOLS[this.tool].opening) this.ghost = this.computeGhost(p);
    else if (this.tool === 'stairs') this.stairGhost = this.snapDraw(p);
    else if (this.tool === 'split') {
      const hit = this.wallAt(p);
      if (hit) {
        const along = this.keys.alt ? hit.proj.along : snap(hit.proj.along, GRID);
        if (along > 1 && along < hit.proj.length - 1) this.splitPreview = { wallId: hit.wall.id, along };
      }
    }
    this.updateCursorStyle();
    this.status();
    this.requestRender();
  }

  applyDrag(e) {
    const d = this.drag;
    const s = this.cursorScreen, p = this.cursor;
    if (!d.moved && dist(s, d.downScreen) < DRAG_THRESHOLD) return;
    d.moved = true;
    const m = this.model;
    switch (d.kind) {
      case 'pan':
        this.ox += s.x - d.lastScreen.x;
        this.oy += s.y - d.lastScreen.y;
        break;
      case 'node': {
        const q = this.snapDraw(p, d.id);
        m.moveNode(d.id, q.x, q.y);
        break;
      }
      case 'wall': {
        const delta = sub(p, d.start);
        const sd = this.keys.alt ? delta : snapPoint(delta, GRID);
        const { a } = m.wallEnds(d.id);
        const dx = d.origA.x + sd.x - a.x, dy = d.origA.y + sd.y - a.y;
        if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) m.moveWall(d.id, dx, dy);
        break;
      }
      case 'floor':
      case 'stairs': {
        // Move so the anchor (first floor point / stair start) lands on orig + snapped delta.
        const delta = sub(p, d.start);
        const sd = this.keys.alt ? delta : snapPoint(delta, GRID);
        const cur = d.kind === 'floor' ? m.getFloor(d.id)?.points[0] : m.getStairs(d.id);
        if (!cur) break;
        const dx = d.orig.x + sd.x - cur.x, dy = d.orig.y + sd.y - cur.y;
        if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
          if (d.kind === 'floor') m.moveFloor(d.id, dx, dy); else m.moveStairs(d.id, dx, dy);
        }
        break;
      }
      case 'floorVertex': {
        const q = this.snapDraw(p);
        m.moveFloorVertex(d.id, d.index, q.x, q.y);
        break;
      }
      case 'opening': this.dragOpening(d, p); break;
      case 'handle': this.dragHandle(d, p); break;
      default: break;
    }
    d.lastScreen = s;
    this.status();
    this.requestRender();
  }

  /** Slide an opening along its wall, or jump to a nearer wall. It always stays on some wall. */
  dragOpening(d, p) {
    const m = this.model;
    const o = m.getOpening(d.id);
    if (!o) return;
    const current = m.getWall(o.wallId);
    const curProj = m.projectOnWall(current, p);
    let target = { wall: current, proj: curProj };
    const near = m.nearestWall(p, Math.max(OPENING_SNAP_DIST, this.px(12)));
    if (near && near.wall.id !== current.id && near.proj.dist < curProj.dist - 0.5) target = near;
    const offset = target.wall.id === d.grabWall ? d.grabOffset : 0;
    const t = this.snapAlong(target.proj.along - offset, o.width);
    if (!m.moveOpening(o.id, t, target.wall.id) && target.wall !== current) {
      const t2 = this.snapAlong(curProj.along - (current.id === d.grabWall ? d.grabOffset : 0), o.width);
      m.moveOpening(o.id, t2, current.id);
    }
  }

  /** Resize an opening by one of its end handles. Shift anchors the opposite edge. */
  dragHandle(d, p) {
    const m = this.model;
    const o = m.getOpening(d.id);
    if (!o) return;
    const along = m.projectOnWall(o.wallId, p).along;
    if (this.keys.shift) {
      if (d.end === 'end') m.resizeOpening(o.id, this.snapLen(along - (o.t - o.width / 2)), 'start');
      else m.resizeOpening(o.id, this.snapLen((o.t + o.width / 2) - along), 'end');
    } else {
      m.resizeOpening(o.id, this.snapLen(2 * Math.abs(along - o.t)), 'center');
    }
  }

  onPointerUp(e, cancelled = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.canvas.releasePointerCapture(d.pointerId); } catch { /* ignore */ }
    if (d.moved && !cancelled) {
      if (d.kind === 'node') {
        const survivor = this.model.mergeNodeIfNear(d.id, Math.max(this.nodeSnapRadius(), 0.5));
        if (survivor) this.setSelection({ kind: 'node', id: survivor });
      }
      if (d.kind !== 'pan') this.commit();
    }
    this.updateCursorStyle();
    this.refreshPreview();
  }

  onDoubleClick(e) {
    this.updatePointer(e);
    if (this.tool === 'wall') { this.endChain(); this.requestRender(); return; }
    if (this.tool === 'floor') { this.finishFloor(); return; }
    if (this.tool !== 'select') return;
    const hit = this.hitTest(this.cursorScreen);
    if (hit?.kind === 'wall') {
      const res = this.model.splitWall(hit.id, this.cursor, { snap: this.keys.alt ? 0 : GRID });
      if (res) { this.commit(); this.setSelection({ kind: 'node', id: res.node.id }); }
    }
  }

  onContextMenu(e) {
    e.preventDefault();
    this.updatePointer(e);
    if (this.tool === 'wall' && this.chain) { this.endChain(); this.requestRender(); return; }
    if (this.tool === 'floor' && this.floorDraw) { this.finishFloor(); return; }
    let hit = this.hitTest(this.cursorScreen);
    if (hit?.kind === 'floorVertex') hit = { kind: 'floor', id: hit.id };
    if (!hit || hit.kind === 'handle') { this.hideMenu(); return; }
    if (this.tool !== 'select') this.setTool('select');
    this.setSelection({ kind: hit.kind, id: hit.id });
    const m = this.model;
    const items = [];
    const at = { ...this.cursor };
    if (hit.kind === 'wall') {
      items.push({ label: 'Split here', action: () => {
        const res = m.splitWall(hit.id, at, { snap: GRID });
        if (res) { this.commit(); this.setSelection({ kind: 'node', id: res.node.id }); }
      } });
      items.push({ label: 'Split in half', action: () => this.splitSelectedInHalf() });
    }
    if (hit.kind === 'opening' && m.getOpening(hit.id)?.type === 'door') {
      items.push({ label: 'Flip hinge', action: () => this.flipDoor(hit.id, 1) });
      items.push({ label: 'Flip side', action: () => this.flipDoor(hit.id, 2) });
    }
    if (hit.kind === 'stairs') items.push({ label: 'Rotate 90°', action: () => this.rotateStairs(hit.id) });
    items.push({ label: 'Delete', danger: true, action: () => this.deleteSelection() });
    this.showMenu(this.cursorScreen, items);
  }

  // ---------------------------------------------------------------- actions used by the UI

  deleteSelection() {
    const s = this.selection;
    if (!s) return false;
    if (this.model.deleteEntity(s.kind, s.id)) {
      this.setSelection(null);
      this.commit();
      return true;
    }
    return false;
  }

  splitSelectedInHalf() {
    const s = this.selection;
    if (s?.kind !== 'wall') return;
    const w = this.model.getWall(s.id);
    const L = this.model.wallLength(w);
    const res = this.model.splitWall(w.id, this.model.pointOnWall(w, L / 2));
    if (res) { this.commit(); this.setSelection({ kind: 'node', id: res.node.id }); }
  }

  flipDoor(id, bit) {
    const o = this.model.getOpening(id);
    if (!o) return;
    this.model.updateOpening(id, { swing: (o.swing || 0) ^ bit });
    this.commit();
  }

  rotateStairs(id) {
    const st = this.model.getStairs(id);
    if (!st) return;
    this.model.updateStairs(id, { angle: st.angle + 90 });
    this.commit();
  }

  // ---------------------------------------------------------------- wall tool

  wallClick(raw) {
    let p = this.snapDraw(raw);
    if (this.chain && this.keys.shift && !p.node) p = this.constrain(p, this.chain.last);
    if (!this.chain) {
      this.chain = { start: { x: p.x, y: p.y }, last: { x: p.x, y: p.y }, count: 0 };
      this.requestRender();
      return;
    }
    if (dist(p, this.chain.last) < 0.5) return; // second click of a double-click
    const r = Math.max(this.nodeSnapRadius(), 0.5);
    const level = this.model.getLevel(this.model.activeLevel);
    const w = this.model.addWall(this.chain.last, p, { snapRadius: r, splitWalls: true, height: level?.height });
    if (!w) return;
    this.commit();
    const endNode = this.model.nodeNear(p, r);
    const end = endNode ? { x: endNode.x, y: endNode.y } : { x: p.x, y: p.y };
    this.chain.count++;
    if (this.chain.count >= 2 && dist(end, this.chain.start) < 0.5) { this.endChain(); }
    else this.chain.last = end;
    this.requestRender();
  }

  /** Shift: keep the segment from l to p horizontal or vertical. */
  constrain(p, l) {
    return Math.abs(p.x - l.x) >= Math.abs(p.y - l.y) ? { x: p.x, y: l.y } : { x: l.x, y: p.y };
  }

  endChain() { this.chain = null; }

  // ---------------------------------------------------------------- floor tool

  /** Next floor corner for the cursor: snapped, Shift-constrained, or the first corner when closing. */
  floorPoint(raw) {
    const pts = this.floorDraw?.points;
    if (pts && pts.length >= 3 && dist(this.w2s(pts[0]), this.w2s(raw)) <= CLOSE_DIST) return { ...pts[0], close: true };
    let p = this.snapDraw(raw);
    if (pts?.length && this.keys.shift && !p.node) p = this.constrain(p, pts[pts.length - 1]);
    return p;
  }

  floorClick(raw) {
    const p = this.floorPoint(raw);
    if (!this.floorDraw) {
      this.floorDraw = { points: [{ x: p.x, y: p.y }] };
      this.requestRender();
      return;
    }
    if (p.close) { this.finishFloor(); return; }
    const pts = this.floorDraw.points;
    if (dist(p, pts[pts.length - 1]) < 0.5) return; // second click of a double-click
    pts.push({ x: p.x, y: p.y });
    this.requestRender();
  }

  /** Close the floor being drawn. Returns true if a floor drawing was in progress. */
  finishFloor() {
    const fd = this.floorDraw;
    if (!fd) return false;
    this.floorDraw = null;
    const f = fd.points.length >= 3 ? this.model.addFloor(fd.points) : null;
    if (f) { this.commit(); this.setSelection({ kind: 'floor', id: f.id }); }
    else if (fd.points.length > 1) this.opts.onStatus?.('A floor needs at least 3 corners and some area.');
    this.requestRender();
    return true;
  }

  // ---------------------------------------------------------------- opening tool

  computeGhost(p) {
    const type = TOOLS[this.tool].opening;
    const width = OPENING_TYPES[type].width;
    const hit = this.model.nearestWall(p, Math.max(OPENING_SNAP_DIST, this.px(12)));
    if (!hit) return { valid: false, type, width, point: p };
    const t = this.snapAlong(hit.proj.along, width);
    const tFit = this.model.fitOpening(hit.wall.id, t, width);
    if (tFit == null) return { valid: false, type, width, wallId: hit.wall.id, t: clamp(t, width / 2, Math.max(width / 2, hit.proj.length - width / 2)) };
    return { valid: true, type, width, wallId: hit.wall.id, t: tFit };
  }

  // ---------------------------------------------------------------- context menu

  showMenu(screen, items) {
    const el = this.menuEl;
    if (!el) return;
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      if (it.danger) b.classList.add('danger');
      b.addEventListener('click', () => { this.hideMenu(); it.action(); });
      el.appendChild(b);
    }
    el.hidden = false;
    const pw = this.canvas.parentElement.clientWidth, ph = this.canvas.parentElement.clientHeight;
    const mw = el.offsetWidth, mh = el.offsetHeight;
    el.style.left = `${Math.min(screen.x, pw - mw - 4)}px`;
    el.style.top = `${Math.min(screen.y, ph - mh - 4)}px`;
  }

  hideMenu() { if (this.menuEl) this.menuEl.hidden = true; }

  // ---------------------------------------------------------------- status & cursor

  status() {
    const parts = [];
    if (this.cursor) {
      const q = this.tool === 'select' ? this.cursor : this.snapDraw(this.cursor);
      parts.push(`x ${fmtM(q.x)}   y ${fmtM(q.y)}`);
    }
    const tool = TOOLS[this.tool];
    let hint = tool.hint;
    if (tool.opening) {
      hint = this.ghost && !this.ghost.valid
        ? (this.ghost.wallId ? 'No room on this wall.' : 'Move near a wall to place it.')
        : `Click to place a ${tool.label.toLowerCase()} on the wall. Esc returns to Select.`;
    }
    if (this.tool === 'floor' && this.floorDraw) {
      const pts = this.floorDraw.points;
      hint = pts.length >= 3
        ? `${pts.length} corners. Click the first corner, double-click or press Enter to close. Esc cancels.`
        : `${pts.length} corner${pts.length === 1 ? '' : 's'}. Keep clicking to add corners. Esc cancels.`;
    }
    if (this.drag?.kind === 'handle') hint = 'Drag to resize. Shift anchors the opposite edge. Alt disables snapping.';
    else if (this.drag?.kind === 'floorVertex') hint = 'Drag the corner. It snaps to wall corners and the grid; Alt disables snapping.';
    else if (this.drag?.kind === 'opening') hint = 'Slide along the wall, or move close to another wall to jump onto it.';
    if (hint) parts.push(hint);
    this.opts.onStatus?.(parts.join('   ·   '));
  }

  updateCursorStyle() {
    let cur = 'default';
    if (this.drag) cur = this.drag.kind === 'pan' ? 'grabbing' : (this.drag.kind === 'handle' ? 'ew-resize' : 'move');
    else if (this.keys.space) cur = 'grab';
    else if (this.tool === 'select') {
      const h = this.hover;
      cur = !h ? 'default' : h.kind === 'handle' ? 'ew-resize' : 'move';
    } else cur = 'crosshair';
    this.canvas.style.cursor = cur;
  }

  // ---------------------------------------------------------------- rendering

  render() {
    const ctx = this.ctx;
    if (!this.cssW) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.c.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    this.drawGrid();

    const m = this.model;
    const L = m.activeLevel;
    const sel = this.selection, hov = this.hover;
    const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;
    const isHov = (kind, id) => hov && hov.kind === kind && hov.id === id;
    const state = (kind, id) => (isSel(kind, id) ? 'selected' : isHov(kind, id) ? 'hover' : null);

    // The level below shows faintly; levels above are never drawn.
    const below = m.levelBelow(L);
    if (below) this.drawLevelGhost(below.id);

    // Floors are opaque, so they cover the level below wherever this level has a floor.
    for (const f of m.floors) if (f.level === L) this.drawFloor(f, state('floor', f.id));
    for (const st of m.stairs) if (st.level === L) this.drawStairs(st, state('stairs', st.id));

    const walls = m.walls.filter((w) => w.level === L);
    const polys = computeWallPolygons(m, L);

    // Walls: fill, then outline the long edges and the free ends only (so joins look seamless).
    for (const w of walls) {
      const pg = polys.get(w.id);
      if (!pg) continue;
      const pts = [pg.aPlus, pg.bPlus, pg.bMinus, pg.aMinus].map((q) => this.w2s(q));
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = isSel('wall', w.id) ? this.c.accent : isHov('wall', w.id) ? this.c.wallHover : this.c.wall;
      ctx.fill();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.c.wallEdge;
    for (const w of walls) {
      const pg = polys.get(w.id);
      const [ap, bp, bm, am] = [pg.aPlus, pg.bPlus, pg.bMinus, pg.aMinus].map((q) => this.w2s(q));
      ctx.beginPath();
      ctx.moveTo(ap.x, ap.y); ctx.lineTo(bp.x, bp.y);
      ctx.moveTo(am.x, am.y); ctx.lineTo(bm.x, bm.y);
      if (m.wallsAtNode(w.a).length === 1) { ctx.moveTo(ap.x, ap.y); ctx.lineTo(am.x, am.y); }
      if (m.wallsAtNode(w.b).length === 1) { ctx.moveTo(bp.x, bp.y); ctx.lineTo(bm.x, bm.y); }
      ctx.stroke();
    }

    for (const o of m.openings) {
      const w = m.getWall(o.wallId);
      if (!w || w.level !== L) continue;
      this.drawOpening(w, o.type, o.t, o.width, o.swing || 0, state('opening', o.id));
    }

    // Wall length labels.
    for (const w of walls) this.drawWallLength(w, polys.get(w.id), isSel('wall', w.id));

    // Nodes: shown for the selection, hover, and in drawing tools as snap targets.
    const showAllNodes = this.tool === 'wall' || this.tool === 'select';
    for (const n of m.nodes) {
      if (n.level !== L) continue;
      const s = this.w2s(n);
      const selected = isSel('node', n.id);
      const hovered = isHov('node', n.id);
      const endOfSel = sel?.kind === 'wall' && (() => { const w = m.getWall(sel.id); return w && (w.a === n.id || w.b === n.id); })();
      if (!(selected || hovered || endOfSel || showAllNodes)) continue;
      const r = selected || hovered ? 6 : endOfSel ? 5 : 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = selected ? this.c.accent : '#ffffff';
      ctx.fill();
      ctx.lineWidth = selected || hovered || endOfSel ? 2 : 1;
      ctx.strokeStyle = selected || hovered || endOfSel ? this.c.accent : this.c.wallEdge;
      ctx.stroke();
    }
    if (sel?.kind === 'node') {
      for (const w of m.wallsAtNode(sel.id)) this.drawWallLength(w, polys.get(w.id), true);
    }

    // Opening resize handles.
    if (sel?.kind === 'opening') {
      const o = m.getOpening(sel.id);
      if (o) {
        for (const h of this.openingHandles(o)) {
          const s = this.w2s(h.p);
          const hot = this.hover?.kind === 'handle' && this.hover.end === h.end;
          ctx.fillStyle = hot ? this.c.accent : '#ffffff';
          ctx.strokeStyle = this.c.accent;
          ctx.lineWidth = 2;
          ctx.fillRect(s.x - 5, s.y - 5, 10, 10);
          ctx.strokeRect(s.x - 5, s.y - 5, 10, 10);
        }
        const w = m.getWall(o.wallId);
        const pos = this.w2s(m.pointOnWall(w, o.t));
        const n = perp(m.wallDir(w));
        const off = w.thickness / 2 * this.scale + 16;
        this.pill(`${round(o.width)} cm`, pos.x - n.x * off, pos.y - n.y * off, true);
      }
    }

    // Floor corner handles.
    if (sel?.kind === 'floor') {
      const f = m.getFloor(sel.id);
      if (f) {
        f.points.forEach((q, i) => {
          const s = this.w2s(q);
          const hot = hov?.kind === 'floorVertex' && hov.id === f.id && hov.index === i;
          ctx.fillStyle = hot ? this.c.accent : '#ffffff';
          ctx.strokeStyle = this.c.accent;
          ctx.lineWidth = 2;
          ctx.fillRect(s.x - 4.5, s.y - 4.5, 9, 9);
          ctx.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9);
        });
      }
    }

    // Tool previews.
    if (this.tool === 'wall') this.drawWallPreview();
    if (this.tool === 'floor') this.drawFloorPreview();
    if (this.stairGhost) {
      this.drawStairs({ ...STAIR_DEFAULTS, x: this.stairGhost.x, y: this.stairGhost.y, angle: 0, level: L }, 'ghost');
    }
    if (this.ghost) this.drawGhost(this.ghost);
    if (this.splitPreview) this.drawSplitPreview(this.splitPreview);
  }

  /** A level drawn faintly under the active one: walls, openings, stairs and floor outlines, no labels. */
  drawLevelGhost(level) {
    const m = this.model, ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = GHOST_ALPHA;
    ctx.setLineDash([6, 4]);
    for (const f of m.floors) {
      if (f.level !== level) continue;
      ctx.beginPath();
      this.tracePolygon(f.points);
      ctx.strokeStyle = this.c.wallEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const st of m.stairs) if (st.level === level) this.drawStairs(st, null, { label: false });
    const polys = computeWallPolygons(m, level);
    for (const w of m.walls) {
      const pg = polys.get(w.id);
      if (pg) this.poly([pg.aPlus, pg.bPlus, pg.bMinus, pg.aMinus].map((q) => this.w2s(q)), this.c.wall);
    }
    for (const o of m.openings) {
      const w = m.getWall(o.wallId);
      if (w && w.level === level) this.drawOpening(w, o.type, o.t, o.width, o.swing || 0, null);
    }
    ctx.restore();
  }

  /** Add a closed polygon (world points) to the current path. */
  tracePolygon(pts) {
    const ctx = this.ctx;
    pts.forEach((q, i) => { const s = this.w2s(q); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
    ctx.closePath();
  }

  /** Floor slab: opaque fill with stairwell holes cut out (even-odd). state: null | 'hover' | 'selected'. */
  drawFloor(f, state) {
    const ctx = this.ctx;
    ctx.beginPath();
    this.tracePolygon(f.points);
    for (const h of this.model.floorHoles(f)) this.tracePolygon(h);
    ctx.fillStyle = this.c.floor;
    ctx.fill('evenodd');
    ctx.strokeStyle = state ? this.c.accent : this.c.gridMajor;
    ctx.lineWidth = state === 'selected' ? 2 : 1;
    ctx.stroke();
  }

  /** Stairs: outline, tread lines and an arrow pointing up the flight. state: null | 'hover' | 'selected' | 'ghost'. */
  drawStairs(st, state, { label = true } = {}) {
    const m = this.model;
    const { steps } = m.stairsInfo(st);
    const u = m.stairsDir(st), n = perp(u);
    const edge = state ? this.c.accent : this.c.wallEdge;
    const fill = state === 'ghost' ? this.c.accentSoft : this.c.bg;
    this.poly(m.stairsFootprint(st).map((q) => this.w2s(q)), fill, edge, state === 'selected' ? 2 : 1);
    const going = st.length / steps, h = st.width / 2;
    if (going * this.scale >= 2) {
      for (let i = 1; i < steps; i++) {
        const c = add(st, scale(u, going * i));
        this.line(this.w2s(add(c, scale(n, h))), this.w2s(add(c, scale(n, -h))), edge, 0.75);
      }
    }
    // Arrow up the centre line, from the bottom step to the top.
    const a = this.w2s(add(st, scale(u, Math.min(going / 2, st.length / 4))));
    const b = this.w2s(add(st, scale(u, st.length - Math.min(going / 2, st.length / 4))));
    this.line(a, b, edge, 1.5);
    const ang = angleOf(sub(b, a)), head = 8;
    for (const k of [-1, 1]) {
      const q = { x: b.x - Math.cos(ang + k * 0.45) * head, y: b.y - Math.sin(ang + k * 0.45) * head };
      this.line(b, q, edge, 1.5);
    }
    if (label && state !== 'ghost') this.pill('UP', a.x, a.y, state === 'selected', angleOf(u));
  }

  drawFloorPreview() {
    const fd = this.floorDraw;
    const p = this.cursor ? this.floorPoint(this.cursor) : null;
    const ctx = this.ctx;
    if (fd) {
      const pts = (p && !p.close ? [...fd.points, p] : fd.points).map((q) => this.w2s(q));
      if (pts.length >= 3) this.poly(pts, this.c.accentSoft, null);
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (p?.close) ctx.closePath();
      ctx.strokeStyle = this.c.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      fd.points.forEach((q, i) => {
        const s = this.w2s(q);
        ctx.beginPath();
        ctx.arc(s.x, s.y, i === 0 && p?.close ? 7 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 && p?.close ? this.c.accent : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      if (pts.length >= 3) {
        const area = Math.abs(polygonArea(p && !p.close ? [...fd.points, p] : fd.points));
        const c = pts.reduce((acc, q) => ({ x: acc.x + q.x / pts.length, y: acc.y + q.y / pts.length }), { x: 0, y: 0 });
        this.pill(`${round(area / 10000, 2)} m²`, c.x, c.y, true);
      }
    }
    if (p && !p.close) {
      const sp = this.w2s(p);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, p.node ? 7 : 4, 0, Math.PI * 2);
      ctx.strokeStyle = this.c.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawGrid() {
    const ctx = this.ctx;
    const tl = this.s2w({ x: 0, y: 0 }), br = this.s2w({ x: this.cssW, y: this.cssH });
    const lines = (step, color, width) => {
      if (step * this.scale < 4) return false;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(x * this.scale + this.ox) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, this.cssH);
      }
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        const sy = Math.round(y * this.scale + this.oy) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(this.cssW, sy);
      }
      ctx.stroke();
      return true;
    };
    if (10 * this.scale >= 5) lines(10, this.c.gridMinor, 1);
    let major = 100;
    while (major * this.scale < 24) major *= major % 500 === 0 ? 2 : 5;
    lines(major, this.c.gridMajor, 1);
    // Origin axes.
    ctx.beginPath();
    ctx.strokeStyle = this.c.axis;
    const o = this.w2s({ x: 0, y: 0 });
    ctx.moveTo(Math.round(o.x) + 0.5, 0); ctx.lineTo(Math.round(o.x) + 0.5, this.cssH);
    ctx.moveTo(0, Math.round(o.y) + 0.5); ctx.lineTo(this.cssW, Math.round(o.y) + 0.5);
    ctx.stroke();
    // Labels in metres along the top and left edges.
    ctx.fillStyle = this.c.label;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const label = (v) => `${round(v / 100, 2)} m`;
    for (let x = Math.ceil(tl.x / major) * major; x <= br.x; x += major) {
      ctx.fillText(label(x), x * this.scale + this.ox + 3, 3);
    }
    ctx.textBaseline = 'bottom';
    for (let y = Math.ceil(tl.y / major) * major; y <= br.y; y += major) {
      if (y * this.scale + this.oy < 18) continue;
      ctx.fillText(label(y), 3, y * this.scale + this.oy - 2);
    }
  }

  /** Screen-space quad along a wall between offsets s0..s1 (along) and k0..k1 (across, cm). */
  wallQuad(w, s0, s1, k0, k1) {
    const m = this.model;
    const u = m.wallDir(w), n = perp(u);
    const { a } = m.wallEnds(w);
    const P = (s, k) => this.w2s(add(add(a, scale(u, s)), scale(n, k)));
    return [P(s0, k0), P(s1, k0), P(s1, k1), P(s0, k1)];
  }

  poly(pts, fill, stroke, lineWidth = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }

  line(p, q, color, width = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.stroke();
  }

  /** Draw an opening as a gap in the wall plus its symbol. state: null | 'hover' | 'selected' | 'ghost' | 'invalid'. */
  drawOpening(w, type, t, width, swing, state) {
    const m = this.model;
    const ctx = this.ctx;
    const L = m.wallLength(w);
    const s0 = clamp(t - width / 2, 0, L), s1 = clamp(t + width / 2, 0, L);
    const h = w.thickness / 2;
    const pad = this.px(0.75);
    const kind = OPENING_TYPES[type].kind;
    const ghost = state === 'ghost' || state === 'invalid';
    const accent = state === 'invalid' ? this.c.invalid : this.c.accent;
    const edge = state ? accent : this.c.wallEdge;

    if (!ghost) this.poly(this.wallQuad(w, s0, s1, -h - pad, h + pad), this.c.bg);
    else this.poly(this.wallQuad(w, s0, s1, -h - pad, h + pad), state === 'invalid' ? 'rgba(220,38,38,0.18)' : this.c.accentSoft);

    // Jambs.
    const j0 = this.wallQuad(w, s0, s0, -h, h), j1 = this.wallQuad(w, s1, s1, -h, h);
    this.line(j0[0], j0[3], edge, state ? 2 : 1.25);
    this.line(j1[0], j1[3], edge, state ? 2 : 1.25);

    if (kind === 'door') {
      const hingeAtEnd = (swing & 1) === 1;
      const side = (swing & 2) ? -1 : 1;
      const sh = hingeAtEnd ? s1 : s0, so = hingeAtEnd ? s0 : s1;
      const u = m.wallDir(w), n = perp(u);
      const { a } = m.wallEnds(w);
      const P = (s, k) => add(add(a, scale(u, s)), scale(n, k));
      const H = P(sh, side * h);
      const tip = add(H, scale(n, side * (s1 - s0)));
      const O = P(so, side * h);
      const color = state ? accent : this.c.door;
      this.line(this.w2s(H), this.w2s(tip), color, 2);
      // Swing arc from the leaf tip to the opposite jamb.
      const a0 = angleOf(sub(tip, H));
      let da = angleOf(sub(O, H)) - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const r = s1 - s0;
      ctx.beginPath();
      for (let i = 0; i <= 24; i++) {
        const ang = a0 + (da * i) / 24;
        const q = this.w2s({ x: H.x + Math.cos(ang) * r, y: H.y + Math.sin(ang) * r });
        if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      // Threshold line.
      const th = this.wallQuad(w, s0, s1, 0, 0);
      this.line(th[0], th[1], color, 1);
    } else {
      const g = h * 0.4;
      const glassEdge = state ? accent : this.c.glassEdge;
      if (type === 'window_full') this.poly(this.wallQuad(w, s0, s1, -h, h), ghost ? null : this.c.glass);
      else this.poly(this.wallQuad(w, s0, s1, -g, g), ghost ? null : this.c.glass);
      const q1 = this.wallQuad(w, s0, s1, -g, g);
      this.line(q1[0], q1[1], glassEdge, 1.25);
      this.line(q1[3], q1[2], glassEdge, 1.25);
      if (type !== 'window') {
        const c = this.wallQuad(w, s0, s1, 0, 0);
        this.line(c[0], c[1], glassEdge, 1);
      }
      if (type === 'window_full') {
        const outer = this.wallQuad(w, s0, s1, -h, h);
        this.line(outer[0], outer[1], glassEdge, 1);
        this.line(outer[3], outer[2], glassEdge, 1);
      }
    }
    if (state === 'selected' || state === 'hover') {
      this.poly(this.wallQuad(w, s0, s1, -h - this.px(2), h + this.px(2)), null, accent, state === 'selected' ? 2 : 1);
    }
  }

  drawWallLength(w, pg, force) {
    if (!pg) return;
    const m = this.model;
    const L = m.wallLength(w);
    if (!force && L * this.scale < 80) return;
    const mid = this.w2s(m.pointOnWall(w, L / 2));
    const n = perp(m.wallDir(w));
    const off = w.thickness / 2 * this.scale + 11;
    // Put the label on the outer (-n) side.
    this.pill(`${round(L)} cm`, mid.x - n.x * off, mid.y - n.y * off, force, angleOf(m.wallDir(w)));
  }

  pill(text, x, y, strong = false, angle = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    if (angle > Math.PI / 2 + 1e-6) angle -= Math.PI;
    if (angle < -Math.PI / 2 - 1e-6) angle += Math.PI;
    ctx.rotate(angle);
    ctx.font = `${strong ? '600 ' : ''}11px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = this.c.pill;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-tw / 2 - 5, -8, tw + 10, 16, 4) : ctx.rect(-tw / 2 - 5, -8, tw + 10, 16);
    ctx.fill();
    ctx.fillStyle = strong ? this.c.accent : this.c.label;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }

  drawWallPreview() {
    if (!this.cursor) return;
    let p = this.snapDraw(this.cursor);
    if (this.chain && this.keys.shift && !p.node) p = this.constrain(p, this.chain.last);
    const ctx = this.ctx;
    const sp = this.w2s(p);
    if (this.chain) {
      const a = this.chain.last;
      const L = dist(a, p);
      if (L > EPS) {
        const u = scale(sub(p, a), 1 / L), n = perp(u);
        const h = 7.5;
        const pts = [add(a, scale(n, h)), add(p, scale(n, h)), add(p, scale(n, -h)), add(a, scale(n, -h))].map((q) => this.w2s(q));
        this.poly(pts, this.c.accentSoft, this.c.accent, 1);
        const mid = this.w2s({ x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 });
        this.pill(`${round(L)} cm`, mid.x - n.x * (h * this.scale + 14), mid.y - n.y * (h * this.scale + 14), true, angleOf(u));
      }
    }
    // Snap indicator.
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, p.node ? 7 : 4, 0, Math.PI * 2);
    ctx.strokeStyle = this.c.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawGhost(g) {
    if (g.wallId) {
      const w = this.model.getWall(g.wallId);
      if (w) this.drawOpening(w, g.type, g.t, g.width, 0, g.valid ? 'ghost' : 'invalid');
      return;
    }
    // Away from any wall: an invalid outline at the cursor.
    const s = this.w2s(g.point);
    const hw = (g.width / 2) * this.scale, hh = 7.5 * this.scale + 2;
    const ctx = this.ctx;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = this.c.invalid;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x - hw, s.y - hh, hw * 2, hh * 2);
    ctx.setLineDash([]);
    this.line({ x: s.x - 5, y: s.y - 5 }, { x: s.x + 5, y: s.y + 5 }, this.c.invalid, 1.5);
    this.line({ x: s.x - 5, y: s.y + 5 }, { x: s.x + 5, y: s.y - 5 }, this.c.invalid, 1.5);
  }

  drawSplitPreview(sp) {
    const w = this.model.getWall(sp.wallId);
    if (!w) return;
    const h = w.thickness / 2 + this.px(6);
    const q = this.wallQuad(w, sp.along, sp.along, -h, h);
    this.line(q[0], q[3], this.c.accent, 2.5);
    const c = this.w2s(this.model.pointOnWall(w, sp.along));
    const L = this.model.wallLength(w);
    this.pill(`${round(sp.along)} | ${round(L - sp.along)} cm`, c.x, c.y - h * this.scale - 14, true);
  }
}
