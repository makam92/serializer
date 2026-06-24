'use strict';

/**
 * Tiny vanilla grid-layout engine (a trimmed react-grid-layout): items live on a
 * COLS-wide grid, never overlap, and float upward (gravity) so the board stays
 * compact. Drag moves an item and reflows the rest; resize snaps to grid cells.
 *
 * A layout is an array of items: { i, x, y, w, h } in grid units.
 */

export const COLS = 12;
export const MIN_W = 3;
export const MIN_H = 4;

function collides(a, b) {
  if (a.i === b.i) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function firstCollision(items, item) {
  for (const it of items) if (collides(it, item)) return it;
  return null;
}

function sortLayout(layout) {
  return layout.slice().sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

export function bottom(layout) {
  let max = 0;
  for (const it of layout) max = Math.max(max, it.y + it.h);
  return max;
}

/** Force an item onto the grid: integer, in-bounds, never below min size. */
export function clampItem(item) {
  item.w = Math.max(MIN_W, Math.min(COLS, Math.round(item.w) || MIN_W));
  item.h = Math.max(MIN_H, Math.round(item.h) || MIN_H);
  item.x = Math.max(0, Math.min(COLS - item.w, Math.round(item.x) || 0));
  item.y = Math.max(0, Math.round(item.y) || 0);
  return item;
}

/**
 * Vertical-compact: pack every item as high as it will go. The `movingId` item is
 * pinned at its current y (so a dragged panel doesn't fly up away from the pointer);
 * everything else floats up and around it.
 */
export function compact(layout, movingId) {
  // The dragged item is placed first so it claims its target cell; everything
  // else then floats up and reflows around it.
  const moving = movingId ? layout.find((it) => it.i === movingId) : null;
  const order = sortLayout(layout.filter((it) => it.i !== movingId));
  if (moving) order.unshift(moving);
  const placed = [];
  const out = [];
  for (const src of order) {
    const l = { ...src };
    if (l.i !== movingId) l.y = 0;          // float up from the top…
    while (firstCollision(placed, l)) l.y++; // …down to the first free row
    placed.push(l);
    out.push(l);
  }
  return out;
}

/** Move item `id` to grid cell (x,y), pushing/reflowing the rest, then compact. */
export function moveElement(layout, id, x, y) {
  const l = layout.find((it) => it.i === id);
  if (!l) return layout;
  l.w = Math.min(COLS, Math.max(MIN_W, l.w));
  l.x = Math.max(0, Math.min(COLS - l.w, Math.round(x)));
  l.y = Math.max(0, Math.round(y));
  return compact(layout, id);
}

/** Resize item `id` to (w,h) grid cells (clamped), then reflow. */
export function resizeElement(layout, id, w, h) {
  const l = layout.find((it) => it.i === id);
  if (!l) return layout;
  l.w = Math.max(MIN_W, Math.min(COLS - l.x, Math.round(w)));
  l.h = Math.max(MIN_H, Math.round(h));
  l.x = Math.max(0, Math.min(COLS - l.w, l.x)); // never let w push past the edge
  return compact(layout, id);
}

/** Drop a new item in at the bottom of the board. */
export function addElement(layout, item) {
  const it = clampItem({ ...item, y: bottom(layout) });
  return compact([...layout, it], null);
}

/** Remove item `id` and let the rest float up to fill the gap. */
export function removeElement(layout, id) {
  return compact(layout.filter((it) => it.i !== id), null);
}
