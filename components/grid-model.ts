import type { Selected, SelectedRange } from '@/lib/data-source';

export type Range = { start: number; end: number };
export type ScrollDirection = 'up' | 'down';

/** The rendered rows, kept within the rows that exist. */
export function getWindow({
  loadedCount,
  totalRowCount,
  range: window,
}: {
  loadedCount: number;
  totalRowCount?: number;
  range: Range;
}) {
  const rowCount = Math.max(loadedCount, totalRowCount ?? loadedCount);
  const end = Math.min(window.end, rowCount);
  return { rowCount, start: Math.min(window.start, end), end };
}

/** The rows overlapping pixels `from` to `to`, for rows `rowHeight` tall. */
export function getRowRange(rowHeight: number, rowCount: number, from: number, to: number): Range {
  const start = Math.max(0, Math.min(rowCount, Math.floor(from / rowHeight)));
  return { start, end: Math.max(start, Math.min(rowCount, Math.ceil(to / rowHeight))) };
}

/**
 * Keeps the rendered range while it still covers `inner` (the visible area plus a margin), and otherwise moves to
 * `outer` (the visible area plus the full buffer). So the range only changes now and then, not on every row or column.
 * A range longer than `maxLength` is replaced too, like the every-row range rendered before the viewport is measured,
 * which would otherwise always cover what's visible and never shrink.
 */
export function getRenderedRange(current: Range, inner: Range, outer: Range, maxLength = Infinity) {
  return containsRange(current, inner) && current.end - current.start <= maxLength ? current : outer;
}

/**
 * The rows that should be loaded right now: the rendered rows, plus `threshold` rows ahead of them in the scroll
 * direction, so the next rows arrive before they're rendered.
 */
export function getNeededRange({
  rendered,
  rowCount,
  threshold,
  direction = 'down',
}: {
  rendered: Range;
  rowCount: number;
  threshold: number;
  direction?: ScrollDirection;
}): Range {
  return direction === 'down'
    ? { start: rendered.start, end: Math.min(rowCount, rendered.end + threshold) }
    : { start: Math.max(0, rendered.start - threshold), end: Math.min(rowCount, rendered.end) };
}

/**
 * Where each column starts: `offsets[i]` is the left edge of column `i`, and `offsets[count]` the total width.
 * Columns use their measured width once known, and `defaultWidth` until then.
 */
export function getColumnOffsets(count: number, defaultWidth: number, measured: ReadonlyMap<number, number>) {
  const offsets = new Float64Array(count + 1);
  for (let index = 0; index < count; index++)
    offsets[index + 1] = offsets[index] + (measured.get(index) ?? defaultWidth);
  return offsets;
}

/** The columns overlapping pixels `from` to `to`, found by binary search over the offsets. */
export function getColumnRange(offsets: ArrayLike<number>, from: number, to: number): Range {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  // The first column that ends after `from`.
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle + 1] <= from) low = middle + 1;
    else high = middle;
  }
  const start = low;
  // The first column that starts at or after `to`.
  high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] < to) low = middle + 1;
    else high = middle;
  }
  return { start, end: Math.max(start, low) };
}

export function containsRange(outer: Range | null, inner: Range) {
  return outer !== null && inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * What to request once the needed rows aren't loaded, or null if they are.
 * The request keeps up to `threshold` rows behind the viewport, so reversing direction doesn't refetch straight away,
 * and puts the rest of the range ahead of it in the scroll direction. `rangeSize` should be well over twice `threshold`.
 */
export function getRequestedRange({
  needed,
  loaded,
  rowCount,
  rangeSize,
  threshold,
  direction,
}: {
  needed: Range;
  loaded: Range | null;
  rowCount: number;
  rangeSize: number;
  threshold: number;
  direction: ScrollDirection;
}): Range | null {
  if (rowCount === 0 || containsRange(loaded, needed)) return null;
  const count = Math.max(1, Math.floor(rangeSize));
  // Keep up to `threshold` rows behind, but never at the expense of the needed rows.
  const behind = Math.max(0, Math.min(threshold, Math.floor((count - (needed.end - needed.start)) / 2)));
  const start = direction === 'down' ? needed.start - behind : needed.end + behind - count;
  const clampedStart = Math.max(0, Math.min(snapStart(start, needed, count), rowCount - count));
  return { start: clampedStart, end: Math.min(rowCount, clampedStart + count) };
}

/**
 * Moves a request's start onto a fixed grid (multiples of a quarter of the range), picking the nearest grid start
 * that still covers `needed`. The same rows are then always requested with the same range, whichever way you
 * scroll, so a cache keyed on the range (like the browser's, keyed on the URL) gets hits.
 */
function snapStart(start: number, needed: Range, count: number) {
  const step = Math.max(1, Math.floor(count / 4));
  // Starts that still cover every needed row.
  const lowest = needed.end - count;
  const highest = needed.start;
  const below = Math.floor(start / step) * step;
  const candidates = [below, below + step].filter((candidate) => candidate >= lowest && candidate <= highest);
  if (candidates.length === 0) return start; // `needed` is too long for the grid; keep the exact start
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - start) < Math.abs(best - start) ? candidate : best,
  );
}

export type SelectionGesture = { anchor: number; base: Selected; adding: boolean; proposed: Selected };

export function getSelectionGesture(
  selected: Selected,
  active: SelectionGesture | null,
  index: number,
  adding: boolean,
  shift: boolean,
): Omit<SelectionGesture, 'proposed'> & { range: SelectedRange } {
  const continuing = shift && active !== null && selected === active.proposed;
  const base = continuing ? active.base : selected;
  const anchor = continuing ? active.anchor : index;
  const selecting = continuing ? active.adding : adding;
  return {
    base,
    anchor,
    adding: selecting,
    range: [Math.min(anchor, index), Math.max(anchor, index) + 1],
  };
}

function union(ranges: readonly SelectedRange[], added: SelectedRange): SelectedRange[] {
  const result: SelectedRange[] = [];
  let [start, end] = added;
  for (const range of ranges) {
    if (range[1] < start) result.push(range);
    else if (range[0] > end) {
      result.push([start, end]);
      [start, end] = range;
    } else {
      start = Math.min(start, range[0]);
      end = Math.max(end, range[1]);
    }
  }
  result.push([start, end]);
  return result;
}
function subtract(ranges: readonly SelectedRange[], [start, end]: SelectedRange): SelectedRange[] {
  const result: SelectedRange[] = [];
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) result.push([a, b]);
    else {
      if (a < start) result.push([a, start]);
      if (b > end) result.push([end, b]);
    }
  }
  return result;
}

/** Sorts and merges ranges, dropping empty ones. Use it before sending a selection to the server. */
export function getSelectedRanges(current: readonly SelectedRange[]): SelectedRange[] {
  const result: SelectedRange[] = [];
  const sorted = current
    .filter(([start, end]) => end > start)
    .map(([start, end]): SelectedRange => [start, end])
    .sort((a, b) => a[0] - b[0]);

  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else result.push(range);
  }

  return result;
}

/** Whether `index` is in `current`, which must already be normalized. */
export function inRanges(current: readonly SelectedRange[], index: number): boolean {
  let low = 0;
  let high = current.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = current[middle];
    if (index < start) high = middle - 1;
    else if (index >= end) low = middle + 1;
    else return true;
  }

  return false;
}

/** Adds (`selected: true`) or removes a range. Never mutates `current`. */
export function selectRange(
  current: readonly SelectedRange[],
  range: SelectedRange,
  selected: boolean,
): SelectedRange[] {
  const ranges = getSelectedRanges(current);
  return selected ? union(ranges, range) : subtract(ranges, range);
}

function countRanges(ranges: readonly SelectedRange[]) {
  return getSelectedRanges(ranges).reduce((count, [start, end]) => count + end - start, 0);
}

/** Whether the row at `index` is selected. `ranges` must already be normalized. */
export function isRowSelected({ all, ranges }: Selected, index: number) {
  return all !== inRanges(ranges, index);
}

/** Selects (`checked: true`) or deselects a span of rows. Never mutates `current`. */
export function setRowsSelected(current: Selected, range: SelectedRange, checked: boolean): Selected {
  // With `all`, the ranges are the exceptions, so selecting removes from them and deselecting adds to them.
  return { all: current.all, ranges: selectRange(current.ranges, range, checked !== current.all) };
}

/** How many rows are selected, out of `rowCount`. */
export function countSelected({ all, ranges }: Selected, rowCount: number) {
  return all ? Math.max(0, rowCount - countRanges(ranges)) : countRanges(ranges);
}
