'use client';

import * as React from 'react';
import { useSpinDelay } from 'spin-delay';
import {
  containsRange,
  countSelected,
  getColumnOffsets,
  getColumnRange,
  getRenderedRange,
  getRowRange,
  getNeededRange,
  getRequestedRange,
  getSelectedRanges,
  getSelectionGesture,
  getWindow,
  isRowSelected,
  setRowsSelected,
  type Range,
  type ScrollDirection,
  type SelectionGesture,
} from '@/components/grid-model';
import { createDataSource, type Column, type DataSourceInput, type Metadata, type Selected } from '@/lib/data-source';
import { useControllableState } from '@/lib/use-controllable-state';
export type { Selected } from '@/lib/data-source';
import { useStableCallback } from '@/lib/use-stable-callback';

const EMPTY_ROWS: never[] = [];
const EMPTY_SELECTED: Selected = { all: false, ranges: [] };
const DEFAULT_SORT = { column: 'id', direction: 'asc' } as const;
// How long scrolling must pause before rows are requested, and the longest a request waits while scrolling continues.
const REQUEST_DELAY = 30;
const MAX_REQUEST_DELAY = 100;
// The width assumed for the viewport before it's measured, so the server renders enough columns to fill most screens.
const UNMEASURED_WIDTH = 1920;

type RowData = { [key: string]: unknown };
/** Metadata for rows with none, so it adds no columns. `Metadata` would add every string, so `id` would always exist. */
type NoMetadata = Record<never, never>;

/**
 * Rows need an `id` to tell them apart, either as their own field or in the data source's metadata, like
 * `createDataSource(rows, { metadata: (row) => ({ id: row.sku }) })`.
 */
type RequireId<T, M> = 'id' extends keyof T | keyof M
  ? unknown
  : { rows: { 'Each row needs an `id`, as a field or from `metadata` in createDataSource': never } };

export type Sort<T extends RowData, M extends Metadata = Metadata> = {
  column: Column<T, M>;
  direction: 'asc' | 'desc';
};
export type SelectedChangeDetails = {
  reason: 'search-change' | 'sort-change' | 'row-toggle' | 'range-selection' | 'select-all';
};

/* -------------------------------------------------------------------------------------------------
 * GridRoot
 * -----------------------------------------------------------------------------------------------*/

// Scroll-driven state has its own contexts, so moving the rendered window only re-renders the parts that render it,
// not every row and cell reading the grid.
type GridContextValue<T extends RowData> = {
  rowCount: number;
  rowHeight: number;
  sort: Sort<T>;
  search: string;
  queryKey: string;
  canSort: boolean;
  loading: boolean;
  /** `loading`, but only once it has lasted long enough to notice. Use for visuals so fast loads don't flicker. */
  showLoading: boolean;
  selected: Selected;
  setSelected: (selection: Selected, reason: SelectedChangeDetails['reason']) => void;
  isSelected: (index?: number) => boolean;
  selectRow: (checked: boolean, index: number | null, shift: boolean) => void;
  setSort: (sort: Sort<T>) => void;
  setScrollPosition: (top: number, left: number) => void;
  setSearch: (search: string) => void;
  /** Every column, including the ones not rendered. Unknown until `Grid.VirtualHeaderCells` has measured its row. */
  columnCount: number | undefined;
  /** The columns before the virtualised ones, so their `aria-colindex` counts them. */
  columnsBefore: number | undefined;
  /** Each other column's position among every column, by name, for its `aria-colindex`. */
  columnPositions: ReadonlyMap<string, number> | undefined;
  setViewportSize: (width: number, height: number) => void;
  reportColumnLayout: (layout: ColumnLayout) => void;
  /** Rows before the virtualised ones (header rows, and any fixed body rows), so their `aria-rowindex` counts them. */
  rowsBefore: number;
  /** Every row, including the ones not rendered. */
  totalRows: number;
  reportRowLayout: (layout: RowLayout) => void;
};

/** The rows `Grid.VirtualRows` renders. Changes as the grid scrolls vertically. */
type RowWindowContextValue<T extends RowData> = {
  /** Each rendered row, its `id`, and where it sits in the `rows` given. Unloaded rows are `undefined`. */
  visible: ({ item: T; id: string | number; itemIndex: number } | undefined)[];
  start: number;
  end: number;
};

/** The columns `Grid.VirtualHeaderCells` and `Grid.VirtualCells` render. Changes as the grid scrolls sideways. */
type ColumnWindowContextValue = {
  virtualColumnCount: number;
  start: number;
  end: number;
  /** Where each virtualised column starts, using measured widths once known. */
  offsets: Float64Array;
};

/** What `Grid.VirtualRows` counts after rendering: how many other rows come before and after the virtualised ones. */
type RowLayout = { before: number; after: number };

/**
 * What `Grid.VirtualHeaderCells` measures after rendering: where the virtualised columns begin, their real widths, and
 * the names of the other columns before and after them, in order.
 */
type ColumnLayout = { virtualStart: number; widths: ReadonlyMap<number, number> } & PermaColumns;
type PermaColumns = { before: readonly string[]; after: readonly string[] };

const Context = React.createContext<GridContextValue<RowData> | null>(null);
const RowWindowContext = React.createContext<RowWindowContextValue<RowData> | null>(null);
const ColumnWindowContext = React.createContext<ColumnWindowContextValue | null>(null);
// The row `Grid.VirtualRows` is rendering: its position in the grid, and where it sits in `rows`, or `undefined` while
// it hasn't loaded. Null outside virtualised rows.
type BodyRowContextValue = { index: number; itemIndex: number | undefined };
const BodyRowContext = React.createContext<BodyRowContextValue | null>(null);
const RowIndexContext = React.createContext<number | undefined>(undefined);
const HeaderCellContext = React.createContext<string | null>(null);

function useGridContext() {
  const context = React.useContext(Context);
  if (!context) throw new Error('Grid parts must be inside Grid.Root.');
  return context;
}

function useRowWindowContext() {
  const context = React.useContext(RowWindowContext);
  if (!context) throw new Error('Grid parts must be inside Grid.Root.');
  return context;
}

function useColumnWindowContext() {
  const context = React.useContext(ColumnWindowContext);
  if (!context) throw new Error('Grid parts must be inside Grid.Root.');
  return context;
}

function useHeaderCellContext() {
  const context = React.useContext(HeaderCellContext);
  if (!context) throw new Error('Header cell parts must be inside Grid.HeaderCell');
  return context;
}

export type RootProps<T extends RowData, M extends Metadata = NoMetadata> = {
  rows?: DataSourceInput<T, M>;
  defaultRows?: DataSourceInput<T, M>;
  sort?: Sort<T>;
  defaultSort?: Sort<T>;
  search?: string;
  defaultSearch?: string;
  searchColumns?: readonly Column<T, M>[];
  /** The rows belong to a previous sort or search and are about to be replaced. Not needed while paging. */
  loading?: boolean;
  rowHeight?: number;
  /**
   * How many rows `Grid.VirtualRows` gives indexes for, including ones not loaded yet. Rows rendered as ordinary
   * `Grid.Row` parts, like an inline row for adding one, aren't counted.
   */
  virtualRowCount?: number;
  offset?: number;
  /** How many rows each request asks for and keeps in memory. */
  rangeSize?: number;
  /** How many rows beyond those rendered to load ahead, in the scroll direction. Keep it well under `rangeSize`. */
  threshold?: number;
  /**
   * Pixels of rows and columns rendered beyond each edge of the viewport. Until the viewport is measured (on the
   * server, and the first client render), all of `rows` render, so pass the server only the rows it should render.
   */
  bufferPx?: number;
  /**
   * How many columns `Grid.VirtualHeaderCells` and `Grid.VirtualCells` give indexes for, and only render while in view. Columns
   * rendered as ordinary `Grid.HeaderCell` and `Grid.Cell` parts, like pinned ones, aren't counted.
   */
  virtualColumnCount?: number;
  /**
   * The width of virtualised columns without their own `Grid.Column` width. Columns not rendered yet are assumed to be
   * this wide, and corrected once rendered and measured.
   */
  defaultColumnWidth?: number;
  selected?: Selected;
  defaultSelected?: Selected;
  children: React.ReactNode;
  onSelectedChange?: (selected: Selected, details: SelectedChangeDetails) => void;
  onSortChange?: (sort: Sort<T>) => void;
  onRangeChange?: (range: { start: number; end: number }) => void;
  onSearchChange?: (search: string) => void;
};

export function Root<T extends RowData, M extends Metadata = NoMetadata>({
  rows: controlledRows,
  defaultRows = EMPTY_ROWS,
  sort: controlledSort,
  defaultSort = DEFAULT_SORT,
  search: controlledSearch,
  defaultSearch = '',
  searchColumns,
  loading = false,
  rowHeight = 44,
  virtualRowCount,
  offset = 0,
  rangeSize = 25,
  threshold = 20,
  bufferPx = 400,
  virtualColumnCount = 0,
  defaultColumnWidth = 150,
  onRangeChange,
  onSearchChange,
  onSortChange,
  selected: controlledSelected,
  defaultSelected = EMPTY_SELECTED,
  onSelectedChange,
  children,
}: RootProps<T, M> & RequireId<T, M>) {
  const rows = controlledRows ?? defaultRows;
  const source = React.useMemo(() => createDataSource(rows), [rows]);
  const [range, setRange] = React.useState<Range>(() => ({ start: offset, end: offset + rows.length }));
  // Column widths start as `defaultColumnWidth` and are corrected as columns are measured.
  const [columnWidths, setColumnWidths] = React.useState<ReadonlyMap<number, number>>(() => new Map());
  // The columns rendered around the virtualised ones, counted once their header row has rendered.
  const [permaColumns, setPermaColumns] = React.useState<PermaColumns | null>(null);
  // The rows rendered around the virtualised ones. Until they're counted, just the header row is assumed.
  const [otherRows, setOtherRows] = React.useState<RowLayout>({ before: 1, after: 0 });
  // When the wait is over, this changes, and the effect below checks what's needed with the latest rows and scroll.
  const [scheduledRequest, setScheduledRequest] = React.useState(0);
  // The last range requested, so a request that's still on its way isn't replaced while it covers what's needed.
  const pendingRef = React.useRef<{ queryKey: string; range: Range } | null>(null);
  const gestureRef = React.useRef<SelectionGesture | null>(null);
  // Dragging the scrollbar fires a scroll event every frame. Requesting on each one would cancel the previous
  // request before it arrived, so nothing would load until the drag stopped. Instead, wait for scrolling to pause,
  // but never longer than MAX_REQUEST_DELAY, so a continuous drag still loads rows as it goes.
  const requestTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestDeadlineRef = React.useRef<number | null>(null);
  // The scroll position and viewport size live in a ref, and state only changes when the rendered rows or columns do.
  // Until the viewport is measured (on the server, and the first client render), the rows given render, and enough
  // columns to fill a wide screen.
  const viewportRef = React.useRef({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
    virtualStart: 0,
    // The row at the top of the viewport, and which way it last moved.
    row: 0,
    direction: 'down' as ScrollDirection,
  });

  const [columnWindow, setColumnWindow] = React.useState<Range>(() => ({
    start: 0,
    end: Math.min(Math.ceil(UNMEASURED_WIDTH / defaultColumnWidth), virtualColumnCount),
  }));

  const columnOffsets = React.useMemo(
    () => getColumnOffsets(virtualColumnCount, defaultColumnWidth, columnWidths),
    [virtualColumnCount, defaultColumnWidth, columnWidths],
  );

  const [selected, setSelected] = useControllableState<Selected, SelectedChangeDetails['reason']>({
    prop: controlledSelected,
    defaultProp: defaultSelected,
    onChange: (next, reason) => onSelectedChange?.(next, { reason }),
  });

  const [search, setSearch] = useControllableState({
    prop: controlledSearch,
    defaultProp: defaultSearch,
    onChange: onSearchChange,
  });

  const [sort, setSort] = useControllableState({
    prop: controlledSort,
    defaultProp: defaultSort,
    onChange: onSortChange,
  });

  // Columns after the virtualised ones come after all of them, rendered or not.
  const columnPositions = React.useMemo(() => {
    if (!permaColumns) return undefined;
    const { before, after } = permaColumns;
    const positions = new Map<string, number>();
    before.forEach((name, index) => positions.set(name, index + 1));
    after.forEach((name, index) => positions.set(name, before.length + virtualColumnCount + index + 1));
    return positions;
  }, [permaColumns, virtualColumnCount]);

  const queryKey = React.useMemo(
    () => JSON.stringify([search, sort.column, sort.direction, searchColumns]),
    [search, sort.column, sort.direction, searchColumns],
  );

  const filtered = React.useMemo(() => {
    if (controlledSearch !== undefined) return source;
    return source.filter(search, searchColumns);
  }, [source, controlledSearch, search, searchColumns]);

  const sorted = React.useMemo(() => {
    if (controlledSort !== undefined) return filtered;
    return filtered.sort(sort);
  }, [filtered, controlledSort, sort]);

  const previousQueryRef = React.useRef({ queryKey, sort });
  const previousSelectedRef = React.useRef(selected);
  const columnStart = Math.min(columnWindow.start, virtualColumnCount);
  const columnEnd = Math.min(columnWindow.end, virtualColumnCount);
  const canSort = controlledSort === undefined || !!onSortChange;
  const columnCount = permaColumns
    ? permaColumns.before.length + virtualColumnCount + permaColumns.after.length
    : undefined;
  const columnsBefore = permaColumns?.before.length;
  // Every row's position, and which of them are rendered.
  const rowState = getWindow({ loadedCount: sorted.length, totalRowCount: virtualRowCount, range });
  const rowCount = rowState.rowCount;
  const rowsBefore = otherRows.before;
  const totalRows = otherRows.before + rowCount + otherRows.after;
  // Rows from a previous query (loading) don't count as loaded.
  const loaded = loading ? null : { start: offset, end: offset + sorted.length };
  const showLoading = useSpinDelay(loading);
  // While loading, the row count belongs to the previous query, so it mustn't limit what's requested.
  // Otherwise a query with no results would stop the next query from ever being requested.
  const requestableRowCount = loading ? Infinity : rowState.rowCount;

  const isSelected = React.useMemo(() => {
    const normalized = { all: selected.all, ranges: getSelectedRanges(selected.ranges) };
    return (index?: number) => index !== undefined && isRowSelected(normalized, index);
  }, [selected]);

  const visible = React.useMemo(
    () =>
      Array.from({ length: rowState.end - rowState.start }, (_, index) => {
        const localIndex = rowState.start + index - offset;
        const item = localIndex < 0 ? undefined : sorted.at(localIndex);
        if (item === undefined) return undefined;
        // An `id` given in metadata (like `id: row.sku`) wins over the row's own field.
        const id = sorted.get(item, 'id' as Column<T, M>) as string | number;
        return { item, id, itemIndex: sorted.originalIndex(localIndex)! };
      }),
    [rowState.start, rowState.end, offset, sorted],
  );

  // Asks for rows when the viewport needs rows that aren't loaded and no pending request covers them.
  function requestRows() {
    const { height, row, direction } = viewportRef.current;
    // Until the viewport is measured, the rendered rows are just the ones given, not the ones needed.
    if (height === 0) return;
    const needed = getNeededRange({
      rendered: { start: rowState.start, end: rowState.end },
      rowCount: requestableRowCount,
      threshold,
      direction,
    });
    const requested = getRequestedRange({
      needed,
      loaded,
      rowCount: requestableRowCount,
      rangeSize,
      threshold,
      direction,
    });
    if (!requested) return;
    // Keep a pending request while it still has the row at the top of the screen. Replacing it would restart the
    // wait (on a slow network, over and over while scrolling), and when its rows arrive this runs again for the rest.
    const first = Math.min(row, Math.max(0, requestableRowCount - 1));
    const pending = pendingRef.current;
    if (pending?.queryKey === queryKey && containsRange(pending.range, { start: first, end: first + 1 })) return;
    pendingRef.current = { queryKey, range: requested };
    onRangeChange?.(requested);
  }

  function scheduleRequestRows() {
    // Nobody to ask for rows, so don't re-render the grid when scrolling pauses.
    if (!onRangeChange) return;
    const now = performance.now();
    requestDeadlineRef.current ??= now + MAX_REQUEST_DELAY;
    clearTimeout(requestTimerRef.current);
    requestTimerRef.current = setTimeout(
      () => {
        requestDeadlineRef.current = null;
        setScheduledRequest((count) => count + 1);
      },
      Math.min(REQUEST_DELAY, requestDeadlineRef.current - now),
    );
  }

  function updateRowWindow() {
    const { scrollTop, height } = viewportRef.current;
    if (height === 0) return;
    const around = (margin: number) =>
      getRowRange(rowHeight, rowState.rowCount, scrollTop - margin, scrollTop + height + margin);
    // The most rows the visible area plus the full buffer can overlap, so the every-row window shrinks once measured.
    const maxRows = Math.ceil((height + bufferPx * 2) / rowHeight) + 1;
    const next = getRenderedRange(range, around(bufferPx / 2), around(bufferPx), maxRows);
    if (next !== range) setRange(next);
  }

  function updateColumnWindow(offsets: Float64Array) {
    const { scrollLeft, width, virtualStart } = viewportRef.current;
    if (width === 0) return;
    const left = scrollLeft - virtualStart;
    const around = (margin: number) => getColumnRange(offsets, left - margin, left + width + margin);
    const next = getRenderedRange(columnWindow, around(bufferPx / 2), around(bufferPx));
    if (next !== columnWindow) setColumnWindow(next);
  }

  const reportColumnLayout = useStableCallback(({ virtualStart, widths, before, after }: ColumnLayout) => {
    viewportRef.current.virtualStart = virtualStart;
    // Only stored when they change, so cells reading the positions don't all re-render on every measure.
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => n === b[i]);
    if (!permaColumns || !same(permaColumns.before, before) || !same(permaColumns.after, after)) {
      setPermaColumns({ before, after });
    }
    let next: Map<number, number> | null = null;
    for (const [index, width] of widths) {
      const known = (next ?? columnWidths).get(index) ?? defaultColumnWidth;
      if (Math.abs(known - width) < 0.5) continue;
      next ??= new Map(columnWidths);
      next.set(index, width);
    }
    if (next) setColumnWidths(next);
    updateColumnWindow(next ? getColumnOffsets(virtualColumnCount, defaultColumnWidth, next) : columnOffsets);
  });

  const reportRowLayout = useStableCallback(({ before, after }: RowLayout) => {
    if (otherRows.before !== before || otherRows.after !== after) setOtherRows({ before, after });
  });

  const setScrollPosition = useStableCallback((top: number, left: number) => {
    const viewport = viewportRef.current;
    if (left !== viewport.scrollLeft) {
      viewport.scrollLeft = left;
      updateColumnWindow(columnOffsets);
    }
    if (top !== viewport.scrollTop) {
      viewport.scrollTop = top;
      updateRowWindow();
    }
    const row = Math.floor(top / rowHeight);
    if (row === viewport.row) return;
    viewport.direction = row > viewport.row ? 'down' : 'up';
    viewport.row = row;
    scheduleRequestRows();
  });

  const setViewportSize = useStableCallback((width: number, height: number) => {
    viewportRef.current.width = width;
    viewportRef.current.height = height;
    updateRowWindow();
    updateColumnWindow(columnOffsets);
    scheduleRequestRows();
  });

  const selectRow = useStableCallback((nextSelected: boolean, index: number | null, shift: boolean) => {
    // The rows belong to the previous query, so the consumer's selection is about to be replaced.
    if (index === null || loading) return;
    const selection = getSelectionGesture(selected, gestureRef.current, index, nextSelected, shift);
    const proposed = setRowsSelected(selection.base, selection.range, selection.adding);
    gestureRef.current = { ...selection, proposed };
    setSelected(proposed, shift ? 'range-selection' : 'row-toggle');
  });

  const setSelectedUnlessLoading = useStableCallback((next: Selected, reason: SelectedChangeDetails['reason']) => {
    if (loading) return;
    gestureRef.current = null;
    setSelected(next, reason);
  });

  // Check what's needed after scrolling pauses, and when rows arrive, the query changes or the grid mounts.
  const requestRowsAfterUpdate = React.useEffectEvent(() => {
    // The pending request's rows have arrived, so it no longer holds back the next request.
    const pending = pendingRef.current;
    // It can come back short at the end of the rows, so only what exists has to arrive.
    const arrived = pending && { start: pending.range.start, end: Math.min(pending.range.end, rowState.rowCount) };
    if (arrived && containsRange(loaded, arrived)) pendingRef.current = null;
    requestRows();
  });

  React.useEffect(() => {
    requestRowsAfterUpdate();
  }, [scheduledRequest, queryKey, loading, offset, sorted.length, rowState.rowCount]);

  React.useEffect(() => () => clearTimeout(requestTimerRef.current), []);

  React.useLayoutEffect(() => {
    if (selected !== previousSelectedRef.current && selected !== gestureRef.current?.proposed)
      gestureRef.current = null;
    previousSelectedRef.current = selected;
  }, [selected]);

  React.useLayoutEffect(() => {
    const previous = previousQueryRef.current;
    if (previous.queryKey === queryKey) return;
    previousQueryRef.current = { queryKey, sort };
    // Tell consumers what changed, so they can treat sorting and searching differently.
    const sortChanged = previous.sort.column !== sort.column || previous.sort.direction !== sort.direction;
    gestureRef.current = null;
    setSelected(EMPTY_SELECTED, sortChanged ? 'sort-change' : 'search-change');
  }, [queryKey, sort, setSelected]);

  const value = React.useMemo<GridContextValue<T>>(
    () => ({
      rowCount,
      rowHeight,
      sort,
      setSort,
      canSort,
      loading,
      showLoading,
      selected,
      setSelected: setSelectedUnlessLoading,
      isSelected,
      setScrollPosition,
      columnCount,
      columnsBefore,
      columnPositions,
      setViewportSize,
      reportColumnLayout,
      rowsBefore,
      totalRows,
      reportRowLayout,
      search,
      queryKey,
      setSearch,
      selectRow,
    }),
    [
      rowCount,
      rowHeight,
      sort,
      setSort,
      canSort,
      loading,
      showLoading,
      selected,
      setSelectedUnlessLoading,
      isSelected,
      setScrollPosition,
      columnCount,
      columnsBefore,
      columnPositions,
      setViewportSize,
      reportColumnLayout,
      rowsBefore,
      totalRows,
      reportRowLayout,
      search,
      queryKey,
      setSearch,
      selectRow,
    ],
  );

  const rowWindowValue = React.useMemo<RowWindowContextValue<T>>(
    () => ({ visible, start: rowState.start, end: rowState.end }),
    [visible, rowState.start, rowState.end],
  );

  const columnWindowValue = React.useMemo<ColumnWindowContextValue>(
    () => ({ virtualColumnCount, start: columnStart, end: columnEnd, offsets: columnOffsets }),
    [virtualColumnCount, columnStart, columnEnd, columnOffsets],
  );

  return (
    <Context.Provider value={value as unknown as GridContextValue<RowData>}>
      <RowWindowContext.Provider value={rowWindowValue as unknown as RowWindowContextValue<RowData>}>
        <ColumnWindowContext.Provider value={columnWindowValue}>{children}</ColumnWindowContext.Provider>
      </RowWindowContext.Provider>
    </Context.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridViewport
 * -----------------------------------------------------------------------------------------------*/

export function Viewport({ onScroll, ...props }: React.ComponentProps<'div'>) {
  const grid = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  const setScrollPosition = React.useEffectEvent(grid.setScrollPosition);
  const setViewportSize = React.useEffectEvent(grid.setViewportSize);

  // Before paint, so the new query's rows don't show for a frame at the old scroll position.
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = 0;
    setScrollPosition(0, ref.current.scrollLeft);
  }, [grid.queryKey]);

  // The viewport's size decides which rows and columns are visible. It's the only size the grid measures.
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportSize(element.clientWidth, element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      {...props}
      ref={ref}
      onScroll={(event) => {
        onScroll?.(event);
        if (!event.defaultPrevented) {
          grid.setScrollPosition(event.currentTarget.scrollTop, event.currentTarget.scrollLeft);
        }
      }}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridSearchInput
 * -----------------------------------------------------------------------------------------------*/

export function SearchInput({ onChange, ...props }: Omit<React.ComponentProps<'input'>, 'value' | 'defaultValue'>) {
  const grid = useGridContext();
  return (
    <input
      type="search"
      {...props}
      value={grid.search}
      onChange={(event) => {
        onChange?.(event);
        if (!event.defaultPrevented) grid.setSearch(event.target.value);
      }}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridTable
 * -----------------------------------------------------------------------------------------------*/

const TableContext = React.createContext<{ id: string } | null>(null);

export function Table({ children, style, ...props }: React.ComponentProps<'div'>) {
  const grid = useGridContext();
  const id = React.useId();
  const table = React.useMemo(() => ({ id }), [id]);

  return (
    <TableContext.Provider value={table}>
      <div
        role="grid"
        data-grid={id}
        aria-busy={grid.loading}
        aria-rowcount={grid.totalRows}
        aria-colcount={grid.columnCount}
        {...props}
        style={{ width: 'max-content', minWidth: '100%', ...style }}
      >
        {children}
      </div>
    </TableContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridColumnGroup
 * -----------------------------------------------------------------------------------------------*/

/**
 * Declares the grid's columns: how wide they are, and which are pinned. Also offsets each pinned column by the widths
 * of the ones pinned before it on the same side, so they sit side by side, which needs the `Grid.Column`s to be its
 * direct children.
 */
export function ColumnGroup({ children }: { children?: React.ReactNode }) {
  const id = React.useContext(TableContext)?.id;
  const columns = React.Children.toArray(children).flatMap((child) =>
    React.isValidElement<ColumnProps>(child) && typeof child.props.name === 'string' ? [child.props] : [],
  );
  const offsets: string[] = [];
  // Columns pinned to the end are offset from the right, so they're counted from the last one.
  for (const pinned of [
    columns.filter((c) => c.pinned === 'start'),
    columns.filter((c) => c.pinned === 'end').reverse(),
  ]) {
    let offset = '0px';
    for (const column of pinned) {
      offsets.push(`${pinVariable(column.name)}: ${offset};`);
      offset = `calc(var(${pinVariable(column.name)}) + ${cssLength(column.width!)})`;
    }
  }
  return (
    <>
      {id && offsets.length > 0 && (
        <style>{`:where([data-grid=${JSON.stringify(id)}]) { ${offsets.join(' ')} }`}</style>
      )}
      {children}
    </>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridColumn
 * -----------------------------------------------------------------------------------------------*/

export type ColumnProps = {
  /**
   * Matches the `name` of a `Grid.HeaderCell` and a `Grid.Cell`. Characters other than letters,
   * numbers, `-` and `_` are treated as `_`, so names differing only in those (like `a b` and `a_b`) clash.
   */
  name: string;
} & (
  | {
      /** A fixed width. Columns without one share the remaining space equally. */
      width?: number | string;
      pinned?: undefined;
    }
  | {
      width: number | string;
      /** Sticks to an edge while scrolling sideways. Pinned columns need a fixed `width`, to offset the ones after. */
      pinned: 'start' | 'end';
    }
);

/**
 * The width (and optionally pinning) for one column. Columns without one share the remaining space.
 * Renders its own CSS rule: a width variable those cells read, and sticky positioning when pinned.
 */
export function Column({ name, width, pinned }: ColumnProps) {
  const id = React.useContext(TableContext)?.id;
  if (!id) return null;
  // Rules are wrapped in :where() so they have no specificity, and any of the consumer's own styles win.
  const grid = `[data-grid=${JSON.stringify(id)}]`;
  const rules: string[] = [];

  if (width !== undefined) rules.push(`:where(${grid}) { ${columnVariable(name)}: 0 0 ${cssLength(width)}; }`);

  if (pinned) {
    // `Grid.ColumnGroup` sets the offset: the widths of the columns pinned before this one, on the same side.
    const side = pinned === 'start' ? 'left' : 'right';
    rules.push(
      `:where(${grid} [data-column=${JSON.stringify(cssValue(name))}]) { position: sticky; ${side}: var(${pinVariable(name)}, 0); z-index: 1; }`,
    );
  }

  return rules.length ? <style>{rules.join('\n')}</style> : null;
}

/* -------------------------------------------------------------------------------------------------
 * GridHeader
 * -----------------------------------------------------------------------------------------------*/

export function Header({ style, ...props }: React.ComponentProps<'div'>) {
  return <div role="rowgroup" {...props} style={{ position: 'sticky', top: 0, zIndex: 2, ...style }} />;
}

/* -------------------------------------------------------------------------------------------------
 * GridHeaderRow
 * -----------------------------------------------------------------------------------------------*/

const HeaderRowContext = React.createContext<HeaderCellRegistry | null>(null);
function useHeaderRowContext(part: string) {
  const registry = React.useContext(HeaderRowContext);
  if (!registry) throw new Error(`${part} must be inside Grid.HeaderRow.`);
  return registry;
}

type HeaderRowProps = Omit<React.ComponentProps<'div'>, 'children'> & { children?: RowChildren };

export function HeaderRow({ children, style, ...props }: HeaderRowProps) {
  const [registry] = React.useState(createHeaderCellRegistry);
  return (
    <HeaderRowContext.Provider value={registry}>
      <div role="row" aria-rowindex={1} {...props} style={{ display: 'flex', ...style }}>
        {typeof children === 'function' ? <VirtualHeaderCells>{children}</VirtualHeaderCells> : children}
      </div>
    </HeaderRowContext.Provider>
  );
}

/** A header cell's element, with its name and, for a virtualised one, its column index. */
type HeaderCellEntry = { name: string; index: number | undefined };
/**
 * The header cells rendered in a `Grid.HeaderRow`, added and removed by their refs, so `Grid.VirtualHeaderCells` can
 * measure them without searching the DOM. Listeners hear about each cell added or removed.
 */
type HeaderCellRegistry = {
  cells: Map<Element, HeaderCellEntry>;
  add: (element: Element, entry: HeaderCellEntry) => () => void;
  subscribe: (listener: (element: Element, added: boolean) => void) => () => void;
};

function createHeaderCellRegistry(): HeaderCellRegistry {
  const cells = new Map<Element, HeaderCellEntry>();
  const listeners = new Set<(element: Element, added: boolean) => void>();
  return {
    cells,
    add(element, entry) {
      cells.set(element, entry);
      listeners.forEach((listener) => listener(element, true));
      return () => {
        cells.delete(element);
        listeners.forEach((listener) => listener(element, false));
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * GridVirtualHeaderCells
 * -----------------------------------------------------------------------------------------------*/

/**
 * Header cells for virtualised columns: `{(index) => <Grid.HeaderCell … />}` is called for visible columns only.
 * Also measures them, so columns sized by a `Grid.Column` (or their content) correct `defaultColumnWidth`.
 */
export function VirtualHeaderCells({ children }: VirtualColumnsProps) {
  const grid = useGridContext();
  const registry = useHeaderRowContext('Grid.VirtualHeaderCells');
  const spacerRef = React.useRef<HTMLDivElement>(null);
  const reportColumnLayout = React.useEffectEvent(grid.reportColumnLayout);

  React.useLayoutEffect(() => {
    const spacer = spacerRef.current;
    if (!spacer) return;

    // Measured when the observer reports, after the browser's own layout, so nothing here forces an extra one. It
    // reports each cell when it starts being observed, and again whenever one's width changes, for example when a
    // column's CSS loads or the consumer restyles it. The other header cells are observed too, so the virtualised
    // ones' start, and which columns come before and after them, stay current as those change.
    const observer = new ResizeObserver((entries) => {
      const widths = new Map<number, number>();
      for (const entry of entries) {
        const index = registry.cells.get(entry.target)?.index;
        if (index !== undefined) widths.set(index, entry.borderBoxSize[0].inlineSize);
      }
      // The other header cells, by name and in the row's order: the ones before the virtualised cells, then after.
      const others = [...registry.cells]
        .filter(([, cell]) => cell.index === undefined)
        .sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const before: string[] = [];
      const after: string[] = [];
      for (const [element, cell] of others) {
        const isBefore = spacer.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING;
        (isBefore ? before : after).push(cell.name);
      }
      reportColumnLayout({ virtualStart: spacer.offsetLeft, widths, before, after });
    });

    // Cells come and go as the visible columns change, so follow the registry rather than the ones here now.
    for (const element of registry.cells.keys()) observer.observe(element);
    const unsubscribe = registry.subscribe((element, added) => {
      return added ? observer.observe(element) : observer.unobserve(element);
    });

    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [registry]);

  return <VirtualColumns spacerRef={spacerRef}>{children}</VirtualColumns>;
}

/* -------------------------------------------------------------------------------------------------
 * GridHeaderCell
 * -----------------------------------------------------------------------------------------------*/

export function HeaderCell({
  name,
  style,
  ref: forwardedRef,
  ...props
}: React.ComponentProps<'div'> & { name: string }) {
  const grid = useGridContext();
  const { sort } = grid;
  const virtual = React.useContext(VirtualColumnContext);
  const registry = useHeaderRowContext('Grid.HeaderCell');
  const index = virtual?.index;
  // Adds the cell to its row's registry while it's mounted, so `Grid.VirtualHeaderCells` can measure it.
  const ref = React.useCallback(
    (element: HTMLDivElement) => {
      const remove = registry.add(element, { name, index });
      const detach = attachRef(forwardedRef, element);
      return () => {
        remove();
        detach();
      };
    },
    [registry, name, index, forwardedRef],
  );
  return (
    <HeaderCellContext.Provider value={name}>
      <div
        role="columnheader"
        data-column={name}
        aria-colindex={getColumnIndex(grid, name, virtual)}
        aria-sort={name === sort.column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
        {...props}
        ref={ref}
        style={{ ...columnStyle(name, virtual?.width), ...style }}
      />
    </HeaderCellContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridSortButton
 * -----------------------------------------------------------------------------------------------*/

export function SortButton({ onClick, disabled, ...props }: React.ComponentProps<'button'>) {
  const grid = useGridContext();
  const column = useHeaderCellContext();
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || !grid.canSort}
      data-direction={grid.sort.column === column ? grid.sort.direction : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          const direction = grid.sort.column === column && grid.sort.direction === 'asc' ? 'desc' : 'asc';
          grid.setSort({ column, direction });
        }
      }}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridBody
 * -----------------------------------------------------------------------------------------------*/

type VirtualRowsProps = {
  /**
   * Called for each rendered row, with where that row sits in the `rows` given to `Grid.Root`, so `rows[index]` (or
   * `source.at(index)`) is the row, however the grid has sorted or filtered them. The index is `undefined` for a row
   * that hasn't loaded: its `Grid.Row` renders as a loading row, with placeholder cells or none. The index is
   * only valid for the `rows` given in this render: look the row up straight away, and keep the row or its `id`.
   */
  children: (index: number | undefined) => React.ReactNode;
};

/** A function as children renders only virtualised rows, the same as `Grid.VirtualRows`. */
export function Body({
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  children: React.ReactNode | VirtualRowsProps['children'];
}) {
  return (
    <div role="rowgroup" {...props}>
      {typeof children === 'function' ? <VirtualRows>{children}</VirtualRows> : children}
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridVirtualRows
 * -----------------------------------------------------------------------------------------------*/

/**
 * Rows for every position up to `virtualRowCount`: `{(index) => <Grid.Row … />}` is called for each rendered row, with
 * the row's index in `rows`, or `undefined` if it hasn't loaded, and the rest are spacers. Other rows can sit before or
 * after it, like an inline row for adding one.
 */
export function VirtualRows({ children }: VirtualRowsProps) {
  const grid = useGridContext();
  const rowWindow = useRowWindowContext();
  const startRef = React.useRef<HTMLDivElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const reportRowLayout = React.useEffectEvent(grid.reportRowLayout);

  // Count the other rows in the grid, header rows included, so the virtualised rows' `aria-rowindex` follows them.
  // Rows added or removed around the virtualised ones after mounting aren't picked up.
  React.useLayoutEffect(() => {
    const start = startRef.current;
    const end = endRef.current;
    const grid = start?.closest('[role="grid"]');
    if (!start || !end || !grid) return;
    let before = 0;
    let after = 0;
    for (const row of grid.querySelectorAll('[role="row"]')) {
      if (start.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) before++;
      else if (end.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) after++;
    }
    reportRowLayout({ before, after });
  }, []);

  return (
    <>
      <Spacer ref={startRef} height={rowWindow.start * grid.rowHeight} />
      {rowWindow.visible.map((row, i) => {
        const index = rowWindow.start + i;
        return (
          <BodyRow
            key={row ? row.id : `loading-${index}`}
            item={row?.item}
            index={index}
            itemIndex={row?.itemIndex}
            render={children}
          />
        );
      })}
      <Spacer ref={endRef} height={(grid.rowCount - rowWindow.end) * grid.rowHeight} />
    </>
  );
}

/**
 * `index` is the row's position in the grid, for selection and `aria-rowindex`; `itemIndex` is where it sits in `rows`,
 * and both `item` and `itemIndex` are `undefined` until it loads. `item` isn't rendered, but it's compared, so a row
 * whose index now holds a different item renders again.
 */
type BodyRowProps = {
  item: RowData | undefined;
  index: number;
  itemIndex: number | undefined;
  render: VirtualRowsProps['children'];
};

// Memoised, so moving the rendered window only renders the rows that came into view.
const BodyRow = React.memo(function BodyRow({ index, itemIndex, render }: BodyRowProps) {
  const row = React.useMemo(() => ({ index, itemIndex }), [index, itemIndex]);
  return <BodyRowContext.Provider value={row}>{render(itemIndex)}</BodyRowContext.Provider>;
});

/* -------------------------------------------------------------------------------------------------
 * GridRow
 * -----------------------------------------------------------------------------------------------*/

type RowProps = Omit<React.ComponentProps<'div'>, 'children'> & { index?: number; children?: RowChildren };

// Parts inside a row read the grid and pass what they need to a memoised part, which only renders when that changes.
/** A function as children renders only virtualised cells, the same as `Grid.VirtualCells`. */
export function Row({ index, ...props }: RowProps) {
  const grid = useGridContext();
  const bodyRow = React.useContext(BodyRowContext);
  const rowIndex = index ?? bodyRow?.index;
  // A virtualised row that hasn't loaded. It still renders, so it can hold placeholder cells, or none.
  const loading = bodyRow !== null && bodyRow.itemIndex === undefined;
  return (
    <MemoRow
      {...props}
      index={rowIndex}
      ariaRowIndex={rowIndex === undefined ? undefined : grid.rowsBefore + rowIndex + 1}
      selected={grid.isSelected(rowIndex)}
      loadingHeight={loading ? grid.rowHeight : undefined}
    />
  );
}

const MemoRow = React.memo(function Row({
  index,
  ariaRowIndex,
  selected,
  loadingHeight,
  children,
  style,
  ...props
}: RowProps & { ariaRowIndex?: number; selected: boolean; loadingHeight?: number }) {
  const loading = loadingHeight !== undefined;
  return (
    <RowIndexContext.Provider value={index}>
      <div
        role="row"
        aria-rowindex={ariaRowIndex}
        aria-selected={selected}
        data-selected={selected ? '' : undefined}
        aria-busy={loading || undefined}
        aria-label={loading ? 'Loading row' : undefined}
        data-placeholder={loading ? '' : undefined}
        {...props}
        // A loading row may have no cells to give it height.
        style={{ display: 'flex', height: loadingHeight, ...style }}
      >
        {typeof children === 'function' ? <VirtualColumns>{children}</VirtualColumns> : children}
      </div>
    </RowIndexContext.Provider>
  );
});

/* -------------------------------------------------------------------------------------------------
 * GridVirtualCells
 * -----------------------------------------------------------------------------------------------*/

/** Body cells for virtualised columns: `{(index) => <Grid.Cell … />}` is called for visible columns only. */
export function VirtualCells({ children }: VirtualColumnsProps) {
  return <VirtualColumns>{children}</VirtualColumns>;
}

/* -------------------------------------------------------------------------------------------------
 * GridCell
 * -----------------------------------------------------------------------------------------------*/

/** `column` sets the cell's width and position; its content is whatever the consumer renders, like `row[column]`. */
type CellProps = React.ComponentProps<'div'> & { name: string };

export function Cell(props: CellProps) {
  const grid = useGridContext();
  const virtual = React.useContext(VirtualColumnContext);
  return <MemoCell {...props} columnWidth={virtual?.width} ariaColIndex={getColumnIndex(grid, props.name, virtual)} />;
}

const MemoCell = React.memo(function Cell({
  name,
  style,
  columnWidth,
  ariaColIndex,
  ...props
}: CellProps & { columnWidth?: number; ariaColIndex?: number }) {
  return (
    <div
      role="gridcell"
      data-column={name}
      aria-colindex={ariaColIndex}
      {...props}
      style={{ ...columnStyle(name, columnWidth), ...style }}
    />
  );
});

/* -------------------------------------------------------------------------------------------------
 * VirtualColumn
 * -----------------------------------------------------------------------------------------------*/

const VirtualColumnContext = React.createContext<{ index: number; width: number } | null>(null);

type VirtualColumnsProps = { children: (index: number) => React.ReactNode };
/** A row's cells, or a function that renders its virtualised cells, the same as `Grid.VirtualCells`. */
type RowChildren = React.ReactNode | VirtualColumnsProps['children'];

/** Renders the visible virtualised columns, with a spacer on each side standing in for the rest. */
function VirtualColumns(props: VirtualColumnsProps & { spacerRef?: React.Ref<HTMLDivElement> }) {
  const columnWindow = useColumnWindowContext();
  return (
    <MemoVirtualColumns
      {...props}
      offsets={columnWindow.offsets}
      virtualColumnCount={columnWindow.virtualColumnCount}
      columnStart={columnWindow.start}
      columnEnd={columnWindow.end}
    />
  );
}

const MemoVirtualColumns = React.memo(function VirtualColumns({
  children,
  spacerRef,
  offsets,
  virtualColumnCount,
  columnStart,
  columnEnd,
}: VirtualColumnsProps & {
  spacerRef?: React.Ref<HTMLDivElement>;
  offsets: Float64Array;
  virtualColumnCount: number;
  columnStart: number;
  columnEnd: number;
}) {
  const total = offsets[virtualColumnCount] ?? 0;
  const before = offsets[columnStart] ?? 0;
  const after = total - (offsets[columnEnd] ?? total);
  const columns: React.ReactNode[] = [];
  for (let index = columnStart; index < columnEnd; index++) {
    columns.push(
      <VirtualColumnContext.Provider key={index} value={{ index, width: offsets[index + 1] - offsets[index] }}>
        {children(index)}
      </VirtualColumnContext.Provider>,
    );
  }
  return (
    <>
      <div aria-hidden="true" ref={spacerRef} style={{ flex: `0 0 ${before}px` }} />
      {columns}
      <div aria-hidden="true" style={{ flex: `0 0 ${after}px` }} />
    </>
  );
});

/* -------------------------------------------------------------------------------------------------
 * GridCheckbox
 * -----------------------------------------------------------------------------------------------*/

type CheckboxProps = Omit<React.ComponentProps<'input'>, 'type' | 'checked' | 'defaultChecked'>;

export function Checkbox(props: CheckboxProps) {
  const grid = useGridContext();
  const index = React.useContext(RowIndexContext);
  const bodyRow = React.useContext(BodyRowContext);
  // A row that hasn't loaded can't be selected: there's nothing to see yet.
  const rowLoading = bodyRow !== null && bodyRow.itemIndex === undefined;
  return (
    <MemoCheckbox
      {...props}
      index={index}
      checked={grid.isSelected(index)}
      showLoading={grid.showLoading || rowLoading}
      selectRow={grid.selectRow}
    />
  );
}

const MemoCheckbox = React.memo(function Checkbox({
  index,
  checked,
  showLoading,
  selectRow,
  onChange,
  onClick,
  ...props
}: CheckboxProps & {
  index?: number;
  checked: boolean;
  showLoading: boolean;
  selectRow: GridContextValue<RowData>['selectRow'];
}) {
  const shiftRef = React.useRef(false);
  return (
    <input
      {...props}
      disabled={props.disabled ?? showLoading}
      type="checkbox"
      checked={checked}
      onClick={(event) => {
        onClick?.(event);
        shiftRef.current = event.shiftKey;
      }}
      onChange={(event) => {
        onChange?.(event);
        if (!event.defaultPrevented) selectRow(event.currentTarget.checked, index ?? null, shiftRef.current);
      }}
    />
  );
});

/* -------------------------------------------------------------------------------------------------
 * GridSelectAll
 * -----------------------------------------------------------------------------------------------*/

type SelectAllProps = Omit<React.ComponentProps<'input'>, 'type' | 'checked' | 'defaultChecked'>;

export function SelectAll({ onChange, ...props }: SelectAllProps) {
  const grid = useGridContext();
  const count = countSelected(grid.selected, grid.rowCount);
  // Checked for `all` with no exceptions, or when every row has been picked individually.
  const checked = grid.rowCount > 0 && count >= grid.rowCount;
  const mixed = count > 0 && !checked;
  const ref = React.useRef<HTMLInputElement>(null);

  React.useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);

  return (
    <input
      aria-label="Select all matching rows"
      {...props}
      ref={ref}
      type="checkbox"
      disabled={props.disabled ?? (grid.showLoading || grid.rowCount === 0)}
      checked={checked}
      aria-checked={mixed ? 'mixed' : checked}
      onChange={(event) => {
        onChange?.(event);
        if (!event.defaultPrevented) grid.setSelected({ all: event.currentTarget.checked, ranges: [] }, 'select-all');
      }}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridSpacer
 * -----------------------------------------------------------------------------------------------*/

function Spacer({ height, ref }: { height: number; ref?: React.Ref<HTMLDivElement> }) {
  // Always rendered, even when empty, since `Grid.VirtualRows` finds its rows' neighbours from its spacers.
  return <div aria-hidden="true" ref={ref} style={{ height }} />;
}

/* -------------------------------------------------------------------------------------------------
 * GridEmpty
 * -----------------------------------------------------------------------------------------------*/

export function Empty(props: React.ComponentProps<'p'>) {
  const grid = useGridContext();
  return grid.rowCount || grid.loading ? null : <p {...props} />;
}

/* -------------------------------------------------------------------------------------------------
 * GridState
 * -----------------------------------------------------------------------------------------------*/

export function State({
  children,
}: {
  children: (state: { rowCount: number; mountedCount: number; selectedCount: number }) => React.ReactNode;
}) {
  const grid = useGridContext();
  const rowWindow = useRowWindowContext();
  return children({
    rowCount: grid.rowCount,
    mountedCount: rowWindow.visible.filter(Boolean).length,
    selectedCount: countSelected(grid.selected, grid.rowCount),
  });
}

/* ---------------------------------------------------------------------------------------------- */

// Cells size themselves from CSS variables that each `Grid.Column` defines, so widths apply in the server's HTML before
// any JavaScript runs, even when the grid's JSX comes from a Server Component. A column with a width gets a fixed
// `flex` from its variable; columns without one fall back to sharing the remaining space equally.
// Column names become part of CSS variable names, so anything else becomes `_` (so `a b` and `a_b` share one).
const cssIdent = (name: string) => name.replace(/[^\w-]/g, '_');
// Values go into a <style> element, so keep them from closing the rule or the element.
const cssValue = (value: string) => value.replace(/[;{}<>]/g, '');
const cssLength = (value: number | string) => cssValue(typeof value === 'number' ? `${value}px` : value);
const columnVariable = (name: string) => `--grid-col-${cssIdent(name)}`;
// How far a pinned column sticks from its edge: the width of the columns pinned before it.
const pinVariable = (name: string) => `--grid-pin-${cssIdent(name)}`;

// Virtualised columns fall back to their known width (measured, or `defaultColumnWidth`), since the grid has to add
// their widths up. Other columns fall back to sharing the remaining space.
const columnStyle = (name: string, width?: number): React.CSSProperties => ({
  flex: `var(${columnVariable(name)}, ${width === undefined ? '1 1 0' : `0 0 ${width}px`})`,
  minWidth: 0,
});

/** Gives `element` to a consumer's ref, of either kind, and returns how to take it back. */
function attachRef<T>(ref: React.Ref<T> | undefined, element: T): () => void {
  if (typeof ref === 'function') {
    const cleanup = ref(element);
    return typeof cleanup === 'function' ? cleanup : () => ref(null);
  }
  if (ref) {
    ref.current = element;
    return () => {
      ref.current = null;
    };
  }
  return () => {};
}

/**
 * A cell's position among every column. Virtualised columns leave the rest out of the DOM, so assistive tech can't count
 * positions from it: the virtualised cells give theirs, and so do the others, since those after them would be miscounted.
 * Unknown until `Grid.VirtualHeaderCells` has measured its row.
 */
function getColumnIndex(
  grid: Pick<GridContextValue<RowData>, 'columnsBefore' | 'columnPositions'>,
  column: string,
  virtual: { index: number } | null,
) {
  if (!virtual) return grid.columnPositions?.get(column);
  return grid.columnsBefore === undefined ? undefined : grid.columnsBefore + virtual.index + 1;
}
