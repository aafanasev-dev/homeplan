// Default sizes for each opening type, plus wall, floor and stair defaults. All units in cm. No DOM.

export const WALL_DEFAULTS = { thickness: 15, height: 270 };
export const FLOOR_DEFAULTS = { thickness: 20 };
/** riser is the target step height; the real riser is rise / round(rise / riser). */
export const STAIR_DEFAULTS = { width: 100, length: 300, riser: 18 };
export const MIN_OPENING_WIDTH = 30;

/**
 * height: null means "the full wall height" (minus the sill).
 * The opening depth is always the thickness of the wall it sits in.
 */
export const OPENING_TYPES = {
  door:        { label: 'Door',               kind: 'door',   width: 90,  height: 210,  sill: 0 },
  window:      { label: 'Window',             kind: 'window', width: 120, height: 140,  sill: 90 },
  window_tall: { label: 'Tall window',        kind: 'window', width: 90,  height: 210,  sill: 30 },
  window_full: { label: 'Full-height window', kind: 'window', width: 150, height: null, sill: 0 },
};

export const isOpeningType = (type) => Object.prototype.hasOwnProperty.call(OPENING_TYPES, type);

/** Vertical dimensions of an opening of `type` inside a wall of `wallHeight`. */
export function openingDims(type, wallHeight) {
  const c = OPENING_TYPES[type] || OPENING_TYPES.window;
  const sill = Math.min(c.sill, wallHeight);
  let height = c.height == null ? wallHeight - sill : c.height;
  height = Math.max(0, Math.min(height, wallHeight - sill));
  return { sill, height, top: sill + height };
}
