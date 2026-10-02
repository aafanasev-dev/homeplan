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
