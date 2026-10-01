# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Home Plan is a browser-based floor plan editor: draw walls in a 2D canvas editor, place doors and windows, and see a live Three.js 3D view. It is plain ES modules with no build step, no package.json and no npm dependencies. Three.js (0.169.0) is loaded from cdn.jsdelivr.net via the import map in `index.html`.

## Commands

- **Run locally:** serve the directory over HTTP (ES modules don't load from `file://`), e.g. `python3 -m http.server 8000`, then open `http://localhost:8000/`.
- **Run tests (node):** `node run-tests.mjs` — exits non-zero on failure.
- **Run tests (browser):** open `tests.html` from the same local server.
- **Single test:** there's no filter flag. Tests are registered with `test(name, fn)` in `js/model.test.js`; temporarily filter the `tests` array in `runModelTests()` or comment out others.
- **Docker:** `docker build -t homeplan . && docker run -p 8080:80 homeplan` (nginx serves `index.html`, `style.css`, `js/`; `.dockerignore` excludes tests).

## Architecture

- **`js/model.js`** is the single source of truth and has **no DOM access** — it must stay runnable under node, since tests import it directly. Same rule for `geometry.js`, `catalog.js` and `model.test.js`.
  - Graph structure: `nodes {id,x,y,level}`, `walls {id,a,b,thickness,height,level}` referencing node ids, `openings {id,wallId,type,t,width,swing?}` where `t` is the opening's centre offset in cm from wall node `a`. Walls sharing a node are joined.
  - **Levels:** `levels [{id,name,height}]` ordered bottom to top. Elevations are computed, never stored (`levelElevation(id)` = sum of the heights below). Nodes, walls, floors and stairs carry a `level`; openings take theirs from their wall. Nodes belong to one level, so walls never join across levels. Geometry queries (`nodeNear`, `nearestWall`, `getOrCreateNode`, `addNode`/`addWall`, `mergeNodeIfNear`) default to `model.activeLevel` or take an explicit level; `bounds(level?)` and `computeWallPolygons(model, level?)` cover every level when the level is omitted.
  - `activeLevel` is UI state: it is **not** in `toJSON()`, so undo snapshots never record level switches. `load()` keeps it if that level still exists, otherwise falls back to the first level. `setActiveLevel(id)` emits a change.
  - **Floors** `{id,level,points:[{x,y}],thickness}` are hand-drawn polygons; the slab spans `elevation - thickness … elevation`. **Stairs** `{id,level,x,y,width,length,angle}` start at `(x, y)` (the start of the flight's centre line) and climb `length` cm in direction `angle` (0/90/180/270°) to the next level; `stairsInfo()` gives rise and step count (`round(rise / 18)`). `floorHoles(floor)` returns the footprints of stairs on the level directly below that lie inside the floor — the 2D and 3D views cut these out as stairwells.
  - Serialization is `version: 2`. Version 1 data (no `levels`, including plans already in localStorage) is migrated by `load()` onto a single default level; entities on an unknown level, and walls whose nodes are on different levels, are dropped.
  - Units are **centimetres**; plan coords are x right, **y down** (screen-like). The grid snap is 10 cm (`GRID` in `geometry.js`).
  - Every mutating method calls `emit()`; wrap multi-step edits in `model.batch(fn)` so listeners fire once.
  - `computeWallPolygons(model)` produces mitred wall outlines at shared nodes; both the 2D editor and the 3D view render walls from it.
  - `History` is snapshot-based (serialized JSON strings). The UI calls `history.commit()` after each *completed* user action (via the editor's `onCommit`), not on every model change — so drags don't flood the undo stack.
- **`js/catalog.js`** defines opening types (`door`, `window`, `window_tall`, `window_full`) with default width/height/sill, plus wall, floor (`FLOOR_DEFAULTS`) and stair (`STAIR_DEFAULTS`) defaults. `height: null` means full wall height. Adding an opening type means adding it here plus a toolbar button in `index.html`.
- **`js/editor2d.js`** (`Editor2D`) handles tools (select/wall/split/openings/floor/stairs), hit-testing, dragging and the context menu. It subscribes to `model.on()` and talks back to `main.js` only through callbacks (`onSelectionChange`, `onCommit`, `onToolChange`, `onStatus`). It only hit-tests and draws the active level; the level below is drawn ghosted underneath, and the active level's floors are opaque so they cover that ghost. `main.js` calls `onLevelChange()` when the active level changes.
- **`js/view3d.js`** (`View3D`) rebuilds the Three.js scene from the model on change (`scheduleRebuild`), one group per level at its elevation (`buildLevel`). Levels above the active one use transparent material clones. `setActiveLevel()` animates the camera by the change in elevation. `main.js` imports it **lazily** via dynamic `import()` so the 2D editor keeps working if the CDN is unreachable.
- **`js/main.js`** wires everything together: toolbar, level switcher (`syncLevel()` runs on every model change, so undo/import that changes the active level is picked up), keyboard shortcuts, properties panel, layout modes (2D / split / 3D), JSON import/export, and autosave of `model.serialize()` to `localStorage` (debounced, with try/catch because storage may be unavailable). If nothing is saved, it loads `createSampleModel()`.
