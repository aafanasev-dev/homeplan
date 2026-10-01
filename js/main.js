// Bootstraps the model, the 2D editor and the 3D view, and wires the toolbar and properties panel.

import { Model, History, createSampleModel } from './model.js';
import { Editor2D, TOOLS } from './editor2d.js';
import { OPENING_TYPES, MIN_OPENING_WIDTH, openingDims } from './catalog.js';
import { round } from './geometry.js';

const STORAGE_KEY = 'homeplan.plan.v1';
const VIEW_KEY = 'homeplan.view';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable or full */ }
}

function loadInitialModel() {
  const saved = storageGet(STORAGE_KEY);
  if (saved) {
    try { return new Model(saved); } catch (e) { console.warn('Ignoring unreadable saved plan', e); }
  }
  return createSampleModel();
}

const model = loadInitialModel();
const history = new History(model);
let view3d = null;

// ------------------------------------------------------------------ editor

const editor = new Editor2D($('#plan'), model, {
  menuEl: $('#ctxmenu'),
  onSelectionChange: (sel) => { renderProps(true); view3d?.setSelection(sel); },
  onCommit: () => { history.commit(); updateHistoryButtons(); },
  onToolChange: (tool) => {
    for (const b of $$('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  },
  onStatus: (text) => { $('#status').textContent = text; },
});
editor.setTool('select');

// ------------------------------------------------------------------ 3D view (loaded lazily so 2D works offline)

import('./view3d.js')
  .then(({ View3D }) => {
    const host = $('#view3d');
    $('#view3d-msg')?.remove();
    view3d = new View3D(host, model);
    view3d.setSelection(editor.selection);
  })
  .catch((err) => {
    console.error(err);
    const msg = $('#view3d-msg');
    if (msg) msg.textContent = 'The 3D view could not load Three.js from cdn.jsdelivr.net. Check the network connection; the 2D editor still works.';
  });

// ------------------------------------------------------------------ autosave

let saveTimer = 0;
model.on(() => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => storageSet(STORAGE_KEY, model.serialize()), 300);
  syncLevel(); // the active level can change through undo, import, "New" or deleting a level
  renderProps();
});
window.addEventListener('beforeunload', () => storageSet(STORAGE_KEY, model.serialize()));

// ------------------------------------------------------------------ history

function updateHistoryButtons() {
  $('[data-action="undo"]').disabled = !history.canUndo();
  $('[data-action="redo"]').disabled = !history.canRedo();
}

function undo() {
  if (editor.isBusy()) return;
  history.undo();
  updateHistoryButtons();
}

function redo() {
  if (editor.isBusy()) return;
  history.redo();
  updateHistoryButtons();
}

updateHistoryButtons();

// ------------------------------------------------------------------ layout

function setView(view) {
  if (!['split', '2d', '3d'].includes(view)) view = 'split';
  $('#workspace').dataset.view = view;
  for (const b of $$('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  for (const b of $$('[data-expand]')) b.textContent = view === b.dataset.expand ? 'Restore' : 'Expand';
  storageSet(VIEW_KEY, view);
}
setView(storageGet(VIEW_KEY) || 'split');

function fitAll() {
  editor.fit();
  view3d?.fit();
}

// ------------------------------------------------------------------ levels

let shownLevel = model.activeLevel; // the level the editor and 3D view were last told about
let levelListKey = '';

/** Rebuild the level select (top level first) when the list changed, and show the active level. */
function renderLevels() {
  const select = $('#level-select');
  const key = model.levels.map((l) => `${l.id}:${l.name}`).join('|');
  if (key !== levelListKey) {
    levelListKey = key;
    select.innerHTML = [...model.levels].reverse()
      .map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  }
  select.value = model.activeLevel;
}

/** Tell the editor and the 3D view when the active level changed, and refresh the select. */
function syncLevel() {
  if (model.activeLevel !== shownLevel) {
    shownLevel = model.activeLevel;
    editor.onLevelChange();
    view3d?.setActiveLevel(shownLevel);
    renderProps(true);
  }
  renderLevels();
}

function switchLevel(id) {
  if (editor.isBusy()) { renderLevels(); return; }
  model.setActiveLevel(id);
  syncLevel();
}

/** step: +1 for the level above, -1 for the level below. */
function stepLevel(step) {
  const next = model.levels[model.levelIndex(model.activeLevel) + step];
  if (next) switchLevel(next.id);
}

function addLevel() {
  if (editor.isBusy()) return;
  const l = model.addLevel();
  switchLevel(l.id);
  history.commit();
  updateHistoryButtons();
}

function deleteLevel() {
  const l = model.getLevel(model.activeLevel);
  if (!l || model.levels.length <= 1) return;
  if (!confirm(`Delete "${l.name}" and everything on it? You can undo this.`)) return;
  model.deleteLevel(l.id);
  editor.setSelection(null);
  history.commit();
  updateHistoryButtons();
}

$('#level-select').addEventListener('change', (e) => {
  switchLevel(e.target.value);
  e.target.blur(); // so PageUp / PageDown and tool keys work again
});

renderLevels();

// ------------------------------------------------------------------ import / export

function exportJSON() {
  const blob = new Blob([JSON.stringify(model.toJSON(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'homeplan.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importJSON(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    model.load(data);
    editor.setSelection(null);
    history.commit();
    updateHistoryButtons();
    fitAll();
  } catch (e) {
    alert(`Could not import that file: ${e.message}`);
  }
}

// ------------------------------------------------------------------ toolbar

document.querySelector('.toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) editor.setTool(b.dataset.tool);
  else if (b.dataset.view) setView(b.dataset.view);
  else switch (b.dataset.action) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'fit': fitAll(); break;
    case 'add-level': addLevel(); break;
    case 'export': exportJSON(); break;
    case 'import': $('#import-file').click(); break;
    case 'new':
      if (confirm('Start a new empty plan? You can undo this.')) {
        model.clear();
        editor.setSelection(null);
        history.commit();
        updateHistoryButtons();
      }
      break;
    default: break;
  }
});

for (const b of $$('[data-expand]')) {
  b.addEventListener('click', () => {
    const v = b.dataset.expand;
    setView($('#workspace').dataset.view === v ? 'split' : v);
  });
}

$('#import-file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) importJSON(f);
  e.target.value = '';
});

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName || '';
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelection(); return; }
  if (e.key === 'Escape') { editor.cancel(); return; }
  if (e.key === 'Enter' && editor.finishFloor()) { e.preventDefault(); return; }
  if (e.key === 'PageUp') { e.preventDefault(); stepLevel(1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); stepLevel(-1); return; }
  if (key === 'f') { fitAll(); return; }
  for (const [name, t] of Object.entries(TOOLS)) {
    if (t.key === key) { editor.setTool(name); return; }
  }
});

// ------------------------------------------------------------------ properties panel

const fmt = (v) => `${round(v, 1)} cm`;

function field(label, inner) {
  return `<div class="field"><label>${label}</label>${inner}</div>`;
}
function readout(label, value) {
  return `<div class="field"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}
function numInput(name, value, { min = 0, max = 10000, step = 1 } = {}) {
  return `<input type="number" name="${name}" value="${round(value, 1)}" min="${min}" max="${max}" step="${step}" inputmode="decimal">`;
}

function renderProps(force = false) {
  const body = $('#props-body');
  if (!force && body.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
  const sel = editor.selection;
  const ent = sel ? model.getEntity(sel.kind, sel.id) : null;
  let html = '';

  if (!ent) {
    const level = model.getLevel(model.activeLevel);
    const L = level.id;
    const walls = model.walls.filter((w) => w.level === L);
    const wallIds = new Set(walls.map((w) => w.id));
    const total = walls.reduce((s, w) => s + model.wallLength(w), 0);
    html = `<h2>Plan</h2>
      ${field('Level name', `<input type="text" name="level-name" value="${esc(level.name)}" maxlength="40">`)}
      ${field('Level height (cm)', numInput('level-height', level.height, { min: 10, max: 2000, step: 10 }))}
      ${readout('Elevation', fmt(model.levelElevation(L)))}
      ${readout('Walls', walls.length)}
      ${readout('Openings', model.openings.filter((o) => wallIds.has(o.wallId)).length)}
      ${readout('Floors', model.floors.filter((f) => f.level === L).length)}
      ${readout('Stairs', model.stairs.filter((st) => st.level === L).length)}
      ${readout('Total wall length', `${round(total / 100, 2)} m`)}
      ${model.levels.length > 1 ? '<div class="actions"><button type="button" class="danger" data-prop-action="delete-level">Delete level</button></div>' : ''}
      <p class="hint">Counts are for this level. Select a wall, corner, door, window, floor or stairs to edit it. Placement snaps to a 10 cm grid; hold Alt to place freely.</p>
      <ul class="keys">
        <li>Select <kbd>V</kbd></li><li>Wall <kbd>W</kbd></li><li>Split <kbd>S</kbd></li>
        <li>Floor <kbd>G</kbd></li><li>Close floor <kbd>Enter</kbd></li><li>Stairs <kbd>T</kbd></li>
        <li>Door <kbd>D</kbd></li><li>Window <kbd>1</kbd></li><li>Tall window <kbd>2</kbd></li>
        <li>Full-height window <kbd>3</kbd></li><li>Delete <kbd>Del</kbd></li>
        <li>Level up / down <kbd>PgUp / PgDn</kbd></li>
        <li>Undo / redo <kbd>Ctrl+Z / Ctrl+Y</kbd></li><li>Pan <kbd>Space+drag</kbd></li><li>Fit <kbd>F</kbd></li>
      </ul>`;
  } else if (sel.kind === 'wall') {
    const w = ent;
    html = `<h2>Wall</h2>
      ${readout('Length', fmt(model.wallLength(w)))}
      ${field('Thickness (cm)', numInput('thickness', w.thickness, { min: 1, max: 200, step: 1 }))}
      ${field('Height (cm)', numInput('height', w.height, { min: 10, max: 2000, step: 10 }))}
      ${readout('Openings', model.openingsOnWall(w.id).length)}
      <div class="actions">
        <button type="button" data-prop-action="split">Split in half</button>
        <button type="button" class="danger" data-prop-action="delete">Delete</button>
      </div>
      <p class="hint">Drag the wall to move it; connected walls stretch. Double-click or right-click it to split at a point.</p>`;
  } else if (sel.kind === 'opening') {
    const o = ent;
    const w = model.getWall(o.wallId);
    const d = openingDims(o.type, w.height);
    const options = Object.entries(OPENING_TYPES)
      .map(([k, c]) => `<option value="${k}"${k === o.type ? ' selected' : ''}>${c.label}</option>`).join('');
    html = `<h2>${OPENING_TYPES[o.type].label}</h2>
      ${field('Type', `<select name="type">${options}</select>`)}
      ${field('Width (cm)', numInput('width', o.width, { min: MIN_OPENING_WIDTH, max: 2000, step: 10 }))}
      ${readout('Height', fmt(d.height))}
      ${readout('Sill', fmt(d.sill))}
      ${readout('Depth (wall)', fmt(w.thickness))}
      ${readout('From wall start', fmt(o.t - o.width / 2))}
      ${readout('Wall length', fmt(model.wallLength(w)))}
      <div class="actions">
        ${o.type === 'door' ? '<button type="button" data-prop-action="flip-hinge">Flip hinge</button><button type="button" data-prop-action="flip-side">Flip side</button>' : ''}
        <button type="button" class="danger" data-prop-action="delete">Delete</button>
      </div>
      <p class="hint">Drag to slide it along the wall or onto another wall. Drag the square handles to resize; hold Shift to keep the opposite edge fixed.</p>`;
  } else if (sel.kind === 'node') {
    const n = ent;
    html = `<h2>Corner</h2>
      ${field('X (cm)', numInput('x', n.x, { min: -100000, max: 100000, step: 10 }))}
      ${field('Y (cm)', numInput('y', n.y, { min: -100000, max: 100000, step: 10 }))}
      ${readout('Connected walls', model.wallsAtNode(n.id).length)}
      <div class="actions"><button type="button" class="danger" data-prop-action="delete">Delete corner</button></div>
      <p class="hint">Drag the corner to reshape every attached wall. Drop it on another corner to join them.</p>`;
  } else if (sel.kind === 'floor') {
    const f = ent;
    html = `<h2>Floor</h2>
      ${field('Thickness (cm)', numInput('thickness', f.thickness, { min: 1, max: 200, step: 1 }))}
      ${readout('Area', `${round(model.floorArea(f) / 10000, 2)} m²`)}
      ${readout('Corners', f.points.length)}
      ${readout('Stairwells', model.floorHoles(f).length)}
      <div class="actions"><button type="button" class="danger" data-prop-action="delete">Delete</button></div>
      <p class="hint">Drag the floor to move it, or drag a square handle to move a corner. Stairs on the level below cut a stairwell when they fit inside it.</p>`;
  } else if (sel.kind === 'stairs') {
    const st = ent;
    const info = model.stairsInfo(st);
    const angles = [[0, 'Right (0°)'], [90, 'Down (90°)'], [180, 'Left (180°)'], [270, 'Up (270°)']]
      .map(([a, label]) => `<option value="${a}"${a === st.angle ? ' selected' : ''}>${label}</option>`).join('');
    html = `<h2>Stairs</h2>
      ${field('Width (cm)', numInput('width', st.width, { min: 30, max: 1000, step: 10 }))}
      ${field('Length (cm)', numInput('length', st.length, { min: 50, max: 2000, step: 10 }))}
      ${field('Climbs towards', `<select name="angle">${angles}</select>`)}
      ${readout('Rise', fmt(info.rise))}
      ${readout('Steps', info.steps)}
      ${readout('Step height', fmt(info.riser))}
      ${readout('Step depth', fmt(info.going))}
      <div class="actions">
        <button type="button" data-prop-action="rotate">Rotate 90°</button>
        <button type="button" class="danger" data-prop-action="delete">Delete</button>
      </div>
      <p class="hint">The flight climbs to the level above and cuts a stairwell in a floor there that contains it.</p>`;
  }
  body.innerHTML = html;
}

$('#props-body').addEventListener('change', (e) => {
  const el = e.target;
  const sel = editor.selection;
  if (!el.name) return;
  if (el.name === 'level-name' || el.name === 'level-height') {
    if (el.name === 'level-name') model.updateLevel(model.activeLevel, { name: el.value });
    else model.updateLevel(model.activeLevel, { height: parseFloat(el.value) });
    history.commit();
    updateHistoryButtons();
    renderProps(true);
    return;
  }
  if (!sel) return;
  const v = el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
  if (el.tagName !== 'SELECT' && !Number.isFinite(v)) { renderProps(true); return; }
  if (sel.kind === 'wall') model.updateWall(sel.id, { [el.name]: v });
  else if (sel.kind === 'floor') model.updateFloor(sel.id, { [el.name]: v });
  else if (sel.kind === 'stairs') model.updateStairs(sel.id, { [el.name]: v });
  else if (sel.kind === 'opening') model.updateOpening(sel.id, { [el.name]: v });
  else if (sel.kind === 'node') {
    const n = model.getNode(sel.id);
    model.moveNode(sel.id, el.name === 'x' ? v : n.x, el.name === 'y' ? v : n.y);
    const survivor = model.mergeNodeIfNear(sel.id, 0.5);
    if (survivor) editor.setSelection({ kind: 'node', id: survivor });
  }
  history.commit();
  updateHistoryButtons();
  renderProps(true);
});

$('#props-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-prop-action]');
  if (!b) return;
  if (b.dataset.propAction === 'delete-level') { deleteLevel(); renderProps(true); return; }
  const sel = editor.selection;
  if (!sel) return;
  switch (b.dataset.propAction) {
    case 'delete': editor.deleteSelection(); break;
    case 'rotate': editor.rotateStairs(sel.id); break;
    case 'split': editor.splitSelectedInHalf(); break;
    case 'flip-hinge': editor.flipDoor(sel.id, 1); break;
    case 'flip-side': editor.flipDoor(sel.id, 2); break;
    default: break;
  }
  renderProps(true);
});

renderProps(true);
