// Default sizes for each opening type, plus wall, floor and stair defaults. All units in cm. No DOM.

export const WALL_DEFAULTS = { thickness: 15, height: 270 };
export const FLOOR_DEFAULTS = { thickness: 20 };
/** riser is the target step height; the real riser is rise / round(rise / riser). */
export const STAIR_DEFAULTS = { width: 100, length: 300, riser: 18 };
export const MIN_OPENING_WIDTH = 30;

/** Default height of a barrier: a wall that stops short of the ceiling. */
export const BARRIER_HEIGHT = 100;
/** Rail, post and spacing sizes of a railing, in cm. */
export const RAILING = { rail: 6, post: 4, gap: 12 };

/**
 * How a wall is built. `wall` is the default and the only style that reaches the ceiling:
 * `height: null` means "the height of its level". The others are barriers, which carry their own
 * height. `look` is what the 2D and 3D renderers branch on — never the key.
 */
export const WALL_STYLES = {
  wall:            { label: 'Wall',          barrier: false, look: 'solid',   thickness: 15, height: null },
  barrier_full:    { label: 'Barrier',       barrier: true,  look: 'solid',   thickness: 12, height: BARRIER_HEIGHT },
  barrier_glass:   { label: 'Glass barrier', barrier: true,  look: 'glass',   thickness: 2,  height: BARRIER_HEIGHT },
  barrier_railing: { label: 'Railing',       barrier: true,  look: 'railing', thickness: 6,  height: BARRIER_HEIGHT },
};

export const isWallStyle = (style) => Object.prototype.hasOwnProperty.call(WALL_STYLES, style);

/** The catalog record of a wall style. Anything unknown (or missing) is a plain wall. */
export const wallSpec = (style) => WALL_STYLES[style] || WALL_STYLES.wall;

/**
 * height: null means "the full wall height" (minus the sill).
 * align: 'top' hangs the opening `head` cm below the ceiling instead of using `sill`.
 * The opening depth is always the thickness of the wall it sits in.
 *
 * Doors carry `style` ('swing' | 'slide' | 'garage') and `leaves`; windows carry `panes`
 * (the number of glass panes, so panes - 1 mullions). Renderers branch on those, never on the key.
 */
export const OPENING_TYPES = {
  door:        { label: 'Door',                      kind: 'door',   style: 'swing',  leaves: 1, width: 90,  height: 210,  sill: 0 },
  door_double: { label: 'Double door',               kind: 'door',   style: 'swing',  leaves: 2, width: 160, height: 210,  sill: 0 },
  door_slide:  { label: 'Sliding door',              kind: 'door',   style: 'slide',  leaves: 1, width: 90,  height: 210,  sill: 0 },
  door_garage: { label: 'Garage door',               kind: 'door',   style: 'garage', leaves: 1, width: 250, height: 220,  sill: 0 },
  window:      { label: 'Window',                    kind: 'window', panes: 1, width: 120, height: 140,  sill: 90 },
  window_tall: { label: 'Tall window',               kind: 'window', panes: 1, width: 90,  height: 210,  sill: 30 },
  window_full: { label: 'Full-height window',        kind: 'window', panes: 1, width: 150, height: null, sill: 0 },
  window_small:{ label: 'Small window',              kind: 'window', panes: 1, width: 30,  height: 30,   sill: 0, align: 'top', head: 20 },
  window_double:      { label: 'Double window',              kind: 'window', panes: 2, width: 180, height: 140,  sill: 90 },
  window_double_tall: { label: 'Double tall window',         kind: 'window', panes: 2, width: 180, height: 210,  sill: 30 },
  window_double_full: { label: 'Double full-height window',  kind: 'window', panes: 2, width: 240, height: null, sill: 0 },
};

export const isOpeningType = (type) => Object.prototype.hasOwnProperty.call(OPENING_TYPES, type);

/** The catalog record of `type` with its optional fields filled in. Unknown types fall back to a window. */
export function openingSpec(type) {
  const c = OPENING_TYPES[type] || OPENING_TYPES.window;
  return { style: 'swing', leaves: 1, panes: 1, head: 0, ...c };
}

/** Vertical dimensions of an opening of `type` inside a wall of `wallHeight`. */
export function openingDims(type, wallHeight) {
  const c = OPENING_TYPES[type] || OPENING_TYPES.window;
  if (c.align === 'top') {
    // Hung below the ceiling: keep `head` cm of wall above it when the wall is tall enough.
    const height = Math.max(0, Math.min(c.height == null ? wallHeight : c.height, wallHeight));
    const sill = Math.max(0, Math.min(wallHeight - (c.head || 0) - height, wallHeight - height));
    return { sill, height, top: sill + height };
  }
  const sill = Math.min(c.sill, wallHeight);
  let height = c.height == null ? wallHeight - sill : c.height;
  height = Math.max(0, Math.min(height, wallHeight - sill));
  return { sill, height, top: sill + height };
}

// -------------------------------------------------------------------- stairs

/** Thickness of a floating tread and the post of a spiral flight, in cm. */
export const TREAD = 5;
export const SPIRAL_POST = 10;

/**
 * How a flight is built. `straight` and `open` run from (x, y) along `length`; a `spiral` turns
 * `sweep` degrees about (x, y), where `width` is the outer diameter.
 */
export const STAIR_KINDS = {
  straight: { label: 'Stairs',        solid: true },
  open:     { label: 'Open stairs',   solid: false },
  spiral:   { label: 'Spiral stairs', solid: false, spiral: true, width: 160, sweep: 270 },
};

export const isStairKind = (kind) => Object.prototype.hasOwnProperty.call(STAIR_KINDS, kind);
export const stairKindSpec = (kind) => STAIR_KINDS[kind] || STAIR_KINDS.straight;

// -------------------------------------------------------------------- furniture

/**
 * Schematic furniture, each piece a handful of boxes.
 *
 * A part is written in fractions of the item's bounding box, so a resized piece keeps its
 * proportions: x and y are the part's centre relative to the item's centre (-0.5 … 0.5), z is its
 * base above the item's base (0 … 1), and w, d, h are its size as a fraction of the item's
 * width, depth and height. Local axes are +x right and +y front, so the **back is at y = -0.5** —
 * that is the face the editor puts against a wall. `mat` names a material both renderers know:
 * case, top, soft, white, glass or metal.
 */
const p = (x, y, z, w, d, h, mat = 'case') => ({ x, y, z, w, d, h, mat });

export const FURNITURE_TYPES = {
  closet: {
    label: 'Closet', room: 'bedroom', width: 180, depth: 60, height: 220,
    parts: [p(0, 0, 0, 1, 1, 1), p(-0.25, 0.46, 0.02, 0.48, 0.08, 0.96, 'top'), p(0.25, 0.46, 0.02, 0.48, 0.08, 0.96, 'top')],
  },
  bed: {
    label: 'Bed', room: 'bedroom', width: 90, depth: 200, height: 50,
    parts: [p(0, 0, 0, 1, 1, 0.5), p(0, 0.05, 0.5, 0.94, 0.9, 0.4, 'soft'), p(0, -0.35, 0.9, 0.7, 0.14, 0.1, 'soft')],
  },
  bed_double: {
    label: 'Double bed', room: 'bedroom', width: 160, depth: 200, height: 50,
    parts: [
      p(0, 0, 0, 1, 1, 0.5), p(0, 0.05, 0.5, 0.94, 0.9, 0.4, 'soft'),
      p(-0.25, -0.35, 0.9, 0.4, 0.14, 0.1, 'soft'), p(0.25, -0.35, 0.9, 0.4, 0.14, 0.1, 'soft'),
    ],
  },
  bedside_table: {
    label: 'Bedside table', room: 'bedroom', width: 45, depth: 40, height: 55,
    parts: [p(0, 0, 0, 1, 1, 1), p(0, 0.45, 0.55, 0.9, 0.1, 0.35, 'top')],
  },
  table_dining: {
    label: 'Dining table', room: 'living', width: 160, depth: 90, height: 75,
    parts: [
      p(0, 0, 0.9, 1, 1, 0.1, 'top'),
      p(-0.44, -0.42, 0, 0.06, 0.08, 0.9), p(0.44, -0.42, 0, 0.06, 0.08, 0.9),
      p(-0.44, 0.42, 0, 0.06, 0.08, 0.9), p(0.44, 0.42, 0, 0.06, 0.08, 0.9),
    ],
  },
  table_coffee: {
    label: 'Coffee table', room: 'living', width: 110, depth: 60, height: 45,
    parts: [
      p(0, 0, 0.85, 1, 1, 0.15, 'top'),
      p(-0.44, -0.4, 0, 0.06, 0.1, 0.85), p(0.44, -0.4, 0, 0.06, 0.1, 0.85),
      p(-0.44, 0.4, 0, 0.06, 0.1, 0.85), p(0.44, 0.4, 0, 0.06, 0.1, 0.85),
    ],
  },
  chair: {
    label: 'Chair', room: 'living', width: 45, depth: 45, height: 90,
    parts: [
      p(0, 0, 0.45, 1, 1, 0.08, 'soft'), p(0, -0.44, 0.53, 1, 0.12, 0.47),
      p(-0.44, -0.44, 0, 0.08, 0.08, 0.45), p(0.44, -0.44, 0, 0.08, 0.08, 0.45),
      p(-0.44, 0.44, 0, 0.08, 0.08, 0.45), p(0.44, 0.44, 0, 0.08, 0.08, 0.45),
    ],
  },
  armchair: {
    label: 'Armchair', room: 'living', width: 85, depth: 85, height: 80,
    parts: [
      p(0, 0.06, 0, 1, 0.88, 0.45, 'soft'), p(0, -0.4, 0, 1, 0.2, 1, 'soft'),
      p(-0.44, 0.06, 0.45, 0.12, 0.88, 0.3, 'soft'), p(0.44, 0.06, 0.45, 0.12, 0.88, 0.3, 'soft'),
      p(0, 0.08, 0.45, 0.74, 0.78, 0.12, 'top'),
    ],
  },
  sofa: {
    label: 'Sofa', room: 'living', width: 200, depth: 90, height: 80,
    parts: [
      p(0, 0.06, 0, 1, 0.88, 0.45, 'soft'), p(0, -0.4, 0, 1, 0.2, 1, 'soft'),
      p(-0.46, 0.06, 0.45, 0.08, 0.88, 0.3, 'soft'), p(0.46, 0.06, 0.45, 0.08, 0.88, 0.3, 'soft'),
      p(-0.21, 0.08, 0.45, 0.4, 0.78, 0.12, 'top'), p(0.21, 0.08, 0.45, 0.4, 0.78, 0.12, 'top'),
    ],
  },
  fridge: {
    label: 'Refrigerator', room: 'kitchen', width: 60, depth: 65, height: 180,
    parts: [p(0, 0, 0, 1, 1, 1), p(0, 0.46, 0.35, 0.96, 0.08, 0.63, 'top'), p(0, 0.46, 0.02, 0.96, 0.08, 0.3, 'top')],
  },
  kitchen_base: {
    label: 'Kitchen module', room: 'kitchen', width: 60, depth: 60, height: 85,
    parts: [p(0, 0, 0, 1, 0.96, 0.92), p(0, 0, 0.92, 1, 1, 0.08, 'top')],
  },
  kitchen_wall: {
    label: 'Wall cabinet', room: 'kitchen', width: 60, depth: 35, height: 70, mount: 'wall', elevation: 140,
    parts: [p(0, 0, 0, 1, 1, 1), p(0, 0.45, 0.03, 0.96, 0.1, 0.94, 'top')],
  },
  bath: {
    label: 'Bath', room: 'bath', width: 170, depth: 75, height: 55,
    parts: [p(0, 0, 0, 1, 1, 0.9, 'white'), p(0, 0, 0.35, 0.86, 0.8, 0.65, 'top')],
  },
  shower: {
    label: 'Shower cabin', room: 'bath', width: 90, depth: 90, height: 200,
    parts: [
      p(0, 0, 0, 1, 1, 0.06, 'white'),
      p(-0.48, 0, 0.06, 0.04, 1, 0.94, 'glass'), p(0, -0.48, 0.06, 1, 0.04, 0.94, 'glass'),
    ],
  },
  toilet: {
    label: 'Toilet', room: 'bath', width: 38, depth: 65, height: 75,
    parts: [p(0, -0.35, 0, 1, 0.3, 1, 'white'), p(0, 0.15, 0, 0.85, 0.7, 0.55, 'white'), p(0, 0.15, 0.55, 0.85, 0.7, 0.05, 'top')],
  },
  sink: {
    label: 'Sink', room: 'bath', width: 60, depth: 45, height: 85,
    parts: [p(0, 0, 0, 0.9, 0.9, 0.85), p(0, 0, 0.85, 1, 1, 0.15, 'white')],
  },
};

export const isFurnitureType = (type) => Object.prototype.hasOwnProperty.call(FURNITURE_TYPES, type);
export const furnitureSpec = (type) => FURNITURE_TYPES[type] || FURNITURE_TYPES.chair;

/** The parts of an item of this size, in cm about its own centre and base: { x, y, z, w, d, h, mat }. */
export function furnitureParts(type, { width, depth, height }) {
  return furnitureSpec(type).parts.map((q) => ({
    x: q.x * width, y: q.y * depth, z: q.z * height,
    w: q.w * width, d: q.d * depth, h: q.h * height,
    mat: q.mat,
  }));
}
