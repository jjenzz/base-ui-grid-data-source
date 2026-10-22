import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const {
  countSelected,
  getColumnOffsets,
  getColumnRange,
  getNeededRange,
  getRenderedRange,
  getRowRange,
  getRequestedRange,
  getSelectedRanges,
  getSelectionGesture,
  getWindow,
  inRanges,
  isRowSelected,
  selectRange,
  setRowsSelected,
} = await load('../components/grid-model.ts');
function proposeGesture(...args) {
  const gesture = getSelectionGesture(...args);
  return { ...gesture, proposed: setRowsSelected(gesture.base, gesture.range, gesture.adding) };
}

test('the window keeps the rendered rows within the rows that exist', () => {
  const options = { loadedCount: 100, totalRowCount: 240 };
  assert.deepEqual(getWindow({ ...options, window: { start: 0, end: 20 } }), { rowCount: 240, start: 0, end: 20 });
  assert.deepEqual(getWindow({ ...options, window: { start: 230, end: 260 } }), {
    rowCount: 240,
    start: 230,
    end: 240,
  });
  // after a search shrinks the results, a window past the end renders nothing until the scroll resets
  assert.deepEqual(getWindow({ loadedCount: 30, totalRowCount: 30, window: { start: 58, end: 78 } }), {
    rowCount: 30,
    start: 30,
    end: 30,
  });
});

test('rendered rows cover the visible pixels plus a buffer, and only move when the buffer runs low', () => {
  assert.deepEqual(getRowRange(44, 240, -200, 640), { start: 0, end: 15 });
  assert.deepEqual(getRowRange(44, 240, 10000, 11000), { start: 227, end: 240 });
  const current = { start: 0, end: 15 };
  // still covers the visible area plus half the buffer: keep it, so nothing re-renders
  assert.equal(getRenderedRange(current, { start: 0, end: 13 }, { start: 0, end: 15 }), current);
  assert.deepEqual(getRenderedRange(current, { start: 5, end: 20 }, { start: 3, end: 22 }), { start: 3, end: 22 });
});

test('nothing is requested while threshold rows are loaded beyond the rendered rows', () => {
  const options = { rowCount: 240, rangeSize: 100, threshold: 20, direction: 'down' };
  const loaded = { start: 0, end: 100 };
  const needed = (start) => getNeededRange({ rendered: { start, end: start + 20 }, rowCount: 240, threshold: 20 });
  assert.equal(getRequestedRange({ ...options, needed: needed(60), loaded }), null);
  // one row further leaves only 19 loaded rows beyond those rendered
  assert.deepEqual(getRequestedRange({ ...options, needed: needed(61), loaded }), { start: 50, end: 150 });
});

test('requests keep threshold rows behind and look ahead in the scroll direction', () => {
  const options = { rowCount: 240, rangeSize: 100, threshold: 20 };
  const rendered = { start: 120, end: 140 };
  const down = getNeededRange({ rendered, rowCount: 240, threshold: 20, direction: 'down' });
  assert.deepEqual(down, { start: 120, end: 160 });
  assert.deepEqual(getRequestedRange({ ...options, needed: down, loaded: { start: 0, end: 100 }, direction: 'down' }), {
    start: 100,
    end: 200,
  });
  const up = getNeededRange({ rendered, rowCount: 240, threshold: 20, direction: 'up' });
  assert.deepEqual(up, { start: 100, end: 140 });
  assert.deepEqual(getRequestedRange({ ...options, needed: up, loaded: { start: 130, end: 230 }, direction: 'up' }), {
    start: 50,
    end: 150,
  });
});

test('requests start on a fixed grid in both directions, so the same rows repeat the same range', () => {
  const options = { rowCount: 100000, rangeSize: 200, threshold: 100, loaded: null };
  for (let first = 0; first < 2000; first += 37) {
    for (const direction of ['down', 'up']) {
      const rendered = { start: first, end: first + 20 };
      const needed = getNeededRange({ rendered, rowCount: 100000, threshold: 100, direction });
      const range = getRequestedRange({ ...options, needed, direction });
      assert.equal(range.start % 50, 0, `${direction} from row ${first} starts at ${range.start}`);
      assert.ok(range.start <= needed.start && range.end >= needed.end, `${direction} from row ${first}`);
    }
  }
});

test('requests are clamped to the rows that exist', () => {
  const options = { rowCount: 240, rangeSize: 100, threshold: 20, loaded: null };
  const atEnd = getNeededRange({ rendered: { start: 230, end: 240 }, rowCount: 240, threshold: 20 });
  assert.deepEqual(getRequestedRange({ ...options, needed: atEnd, direction: 'down' }), { start: 140, end: 240 });
  const atStart = getNeededRange({ rendered: { start: 0, end: 20 }, rowCount: 240, threshold: 20, direction: 'up' });
  assert.deepEqual(getRequestedRange({ ...options, needed: atStart, direction: 'up' }), { start: 0, end: 100 });
  assert.equal(getRequestedRange({ ...options, rowCount: 0, needed: { start: 0, end: 0 }, direction: 'down' }), null);
});

test('private gesture history grows and shrinks while preserving previous ranges', () => {
  let selected = { all: false, ranges: [[80, 101]] };
  let gesture = proposeGesture(selected, null, 10, true, false);
  selected = gesture.proposed;
  gesture = proposeGesture(selected, gesture, 60, true, true);
  assert.deepEqual(gesture.proposed.ranges, [
    [10, 61],
    [80, 101],
  ]);
  selected = gesture.proposed;
  gesture = proposeGesture(selected, gesture, 20, false, true);
  assert.deepEqual(gesture.proposed.ranges, [
    [10, 21],
    [80, 101],
  ]);
});
test('an external controlled replacement starts a fresh gesture', () => {
  const gesture = proposeGesture({ all: false, ranges: [] }, null, 10, true, false);
  const replacement = { all: false, ranges: [[200, 210]] };
  const next = proposeGesture(replacement, gesture, 50, true, true);
  assert.equal(next.anchor, 50);
  assert.deepEqual(next.proposed.ranges, [
    [50, 51],
    [200, 210],
  ]);
});
test('range arrays preserve disconnected selections without mutation', () => {
  const previous = [[80, 101]];
  const selected = selectRange(previous, [10, 51], true);
  assert.deepEqual(selected, [
    [10, 51],
    [80, 101],
  ]);
  assert.deepEqual(previous, [[80, 101]]);
  assert.equal(inRanges(selected, 50), true);
  assert.equal(inRanges(selected, 51), false);
  assert.deepEqual(getSelectedRanges([]), []);
});
test('removing a range splits a million-row span without loading rows', () => {
  const selected = selectRange([[0, 1000000]], [5000, 5200], false);
  assert.deepEqual(selected, [
    [0, 5000],
    [5200, 1000000],
  ]);
  assert.equal(inRanges(selected, 5100), false);
  assert.equal(countSelected({ all: false, ranges: selected }, 1000000), 999800);
});
test('range normalization merges adjacent and overlapping spans', () => {
  assert.deepEqual(
    getSelectedRanges([
      [10, 20],
      [0, 5],
      [5, 12],
      [30, 30],
    ]),
    [[0, 20]],
  );
});
test('an unknown row count still requests the first range', () => {
  // While a new query loads, the previous count (possibly 0) doesn't apply, so the grid passes Infinity.
  const rendered = { start: 0, end: 0 };
  const options = { loaded: null, rowCount: Infinity, rangeSize: 100, threshold: 20 };
  for (const direction of ['down', 'up']) {
    const needed = getNeededRange({ rendered, rowCount: Infinity, threshold: 20, direction });
    assert.deepEqual(getRequestedRange({ ...options, needed, direction }), { start: 0, end: 100 });
  }
});

test('with all, ranges are exceptions: deselecting adds one and selecting removes it', () => {
  const everything = { all: true, ranges: [] };
  const withHole = setRowsSelected(everything, [5, 6], false);
  assert.deepEqual(withHole, { all: true, ranges: [[5, 6]] });
  assert.equal(isRowSelected(withHole, 5), false);
  assert.equal(isRowSelected(withHole, 6), true);
  assert.equal(countSelected(withHole, 1000000), 999999);
  assert.deepEqual(setRowsSelected(withHole, [5, 6], true), everything);
  assert.equal(countSelected(everything, 240), 240);
});

test('scrolling up keeps threshold rows loaded above the rendered rows', () => {
  const options = { rowCount: 5000, rangeSize: 200, threshold: 100, direction: 'up' };
  const loaded = { start: 1000, end: 1200 };
  const needed = (start) =>
    getNeededRange({ rendered: { start, end: start + 20 }, rowCount: 5000, threshold: 100, direction: 'up' });
  // 150 rows loaded above the rendered rows: nothing to do yet
  assert.equal(getRequestedRange({ ...options, needed: needed(1150), loaded }), null);
  // only 90 above: request early, while the rendered rows are still loaded
  const range = getRequestedRange({ ...options, needed: needed(1090), loaded });
  assert.ok(range.start <= 990 && range.end >= 1110, `${range.start}-${range.end}`);
});

test('column offsets use measured widths where known and the default elsewhere', () => {
  const offsets = getColumnOffsets(5, 100, new Map([[2, 250]]));
  assert.deepEqual([...offsets], [0, 100, 200, 450, 550, 650]);
  assert.deepEqual([...getColumnOffsets(0, 100, new Map())], [0]);
});

test('the column range covers every column overlapping the pixels', () => {
  const offsets = getColumnOffsets(100, 120, new Map());
  assert.deepEqual(getColumnRange(offsets, 0, 400), { start: 0, end: 4 });
  // a column that only partly overlaps is included
  assert.deepEqual(getColumnRange(offsets, 5000, 5400), { start: 41, end: 45 });
  // ranges past either edge are clamped
  assert.deepEqual(getColumnRange(offsets, -500, 100), { start: 0, end: 1 });
  assert.deepEqual(getColumnRange(offsets, 11900, 20000), { start: 99, end: 100 });
  assert.deepEqual(getColumnRange(getColumnOffsets(0, 120, new Map()), 0, 400), { start: 0, end: 0 });
});
