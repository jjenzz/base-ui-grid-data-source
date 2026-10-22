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
import { useItemRegistry, type ItemRegistry } from '@/lib/use-item-registry';
import { useStableCallback } from '@/lib/use-stable-callback';

const EMPTY_ROWS: never[] = [];
const EMPTY_SELECTED: Selected = { all: false, ranges: [] };
const DEFAULT_SORT = { column: 'id', direction: 'asc' } as const;
// Scroll pause before requesting rows, and the most a request waits while scrolling continues.
const REQUEST_DELAY = 30;
const MAX_REQUEST_DELAY = 100;
// Viewport width assumed before it's measured, so the server renders enough columns for most screens.
const UNMEASURED_WIDTH = 1920;

type RowData = { [key: string]: unknown };
/** No metadata columns. `Metadata` allows any key, so `RequireId` would always pass. */
type NoMetadata = Record<never, never>;

/** Rows need an `id`, as a field or from metadata, like `metadata: (row) => ({ id: row.sku })`. */
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

// Scroll-driven state has its own contexts, so scrolling doesn't re-render every part that reads the grid.
type GridContextValue<T extends RowData> = {
  rowCount: number;
  rowHeight: number;
  sort: Sort<T>;
  search: string;
  queryKey: string;
  canSort: boolean;
  loading: boolean;
  /** `loading` after a short delay. Use it for visuals, so fast loads don't flicker. */
  showLoading: boolean;
  selected: Selected;
  setSelected: (selection: Selected, reason: SelectedChangeDetails['reason']) => void;
  isSelected: (index?: number) => boolean;
  selectRow: (checked: boolean, index: number | null, shift: boolean) => void;
  setSort: (sort: Sort<T>) => void;
  setScrollPosition: (top: number, left: number) => void;
  setSearch: (search: string) => void;
  /** Every column, rendered or not. Unknown until `Grid.VirtualHeaderCells` measures its row. */
  columnCount: number | undefined;
  /** Columns before the virtualised ones, which their `aria-colindex` counts. */
  columnsBefore: number | undefined;
  /** Each non-virtualised column's `aria-colindex`, by name. */
  columnPositions: ReadonlyMap<string, number> | undefined;
  setViewportSize: (width: number, height: number) => void;
  reportColumnLayout: (layout: ColumnLayout) => void;
  /** Rows before the virtualised ones, which their `aria-rowindex` counts. Unknown until counted on the client. */
  rowsBefore: number | undefined;
  /** Every row, rendered or not. Unknown until counted. */
  totalRows: number | undefined;
  /** Each non-virtualised row's position, by registry key. Unknown until counted. */
  rowPositions: ReadonlyMap<symbol, RowPosition> | undefined;
  reportRowLayout: (layout: RowLayout) => void;
};

/** The rows `Grid.VirtualRows` renders. Changes on vertical scroll. */
type RowWindowContextValue<T extends RowData> = {
  /** Each rendered row with its `id` and index in the given `rows`, or `undefined` if not loaded. */
  visible: ({ item: T; id: string | number; itemIndex: number } | undefined)[];
  start: number;
  end: number;
};

/** The columns `Grid.VirtualHeaderCells` and `Grid.VirtualCells` render. Changes on horizontal scroll. */
type ColumnWindowContextValue = {
  virtualColumnCount: number;
  start: number;
  end: number;
  /** Where each virtualised column starts, from measured widths once known. */
  offsets: Float64Array;
};

/** Counted by `Grid.VirtualRows` after render: the other rows before and after it, and where each one sits. */
type RowLayout = { before: number; after: number; positions: ReadonlyMap<symbol, RowPosition> };
/** A non-virtualised row's side of the virtualised rows, and its place there from 1. */
type RowPosition = { before: boolean; place: number };

/**
 * Measured by `Grid.VirtualHeaderCells` after render: where the virtualised columns start, their widths, and the other
 * columns' names before and after them.
 */
type ColumnLayout = { virtualStart: number; widths: ReadonlyMap<number, number> } & PermaColumns;
type PermaColumns = { before: readonly string[]; after: readonly string[] };

const Context = React.createContext<GridContextValue<RowData> | null>(null);
const RowWindowContext = React.createContext<RowWindowContextValue<RowData> | null>(null);
const ColumnWindowContext = React.createContext<ColumnWindowContextValue | null>(null);
// The row `Grid.VirtualRows` is rendering: its grid position, and its index in `rows` (`undefined` until loaded).
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
  /** The rows are from a previous sort or search and about to be replaced. Not needed while paging. */
  loading?: boolean;
  rowHeight?: number;
  /** Rows `Grid.VirtualRows` covers, loaded or not. Ordinary `Grid.Row`s, like an add row, aren't counted. */
  virtualRowCount?: number;
  offset?: number;
  /** How many rows each request asks for and keeps in memory. */
  rangeSize?: number;
  /** Rows to load ahead of those rendered, in the scroll direction. Keep it well under `rangeSize`. */
  threshold?: number;
  /**
   * Pixels rendered beyond each edge of the viewport. Until it's measured (on the server and first client render),
   * every row in `rows` renders, so give the server only the rows it should render.
   */
  bufferPx?: number;
  /** Columns the virtual header and body cells cover. Ordinary cells, like pinned ones, aren't counted. */
  virtualColumnCount?: number;
  /** Width assumed for virtualised columns until they're measured, unless a `Grid.Column` sets one. */
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
  // Measured widths of virtualised columns. Unmeasured ones use `defaultColumnWidth`.
  const [columnWidths, setColumnWidths] = React.useState<ReadonlyMap<number, number>>(() => new Map());
  // Names of the columns around the virtualised ones, once their header row is measured.
  const [permaColumns, setPermaColumns] = React.useState<PermaColumns | null>(null);
  // Rows around the virtualised ones, counted on the client. The server can't count them, so its HTML has no row
  // numbers, and doesn't need them: every row it renders is in the HTML.
  const [permaRows, setPermaRows] = React.useState<RowLayout | null>(null);
  // Bumped by `scheduleRequestRows`. State, so the row request effect runs after a render, with the latest window.
  const [scheduledRequest, setScheduledRequest] = React.useState(0);
  // The request in flight, so one that still covers what's needed isn't replaced.
  const pendingRef = React.useRef<{ queryKey: string; range: Range } | null>(null);
  const gestureRef = React.useRef<SelectionGesture | null>(null);
  // Throttle requests while scrolling. Requesting on every scroll event would cancel each request before it arrived,
  // so a scrollbar drag would load nothing until it stopped.
  const requestTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const requestDeadlineRef = React.useRef<number | null>(null);
  // Kept out of state, so scrolling only re-renders when the rendered rows or columns change.
  const viewportRef = React.useRef({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
    virtualStart: 0,
    // The top visible row, and which way it last moved, to load ahead in that direction.
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

  // Columns after the virtualised ones count all of them, rendered or not.
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
  // The row count, and which rows are rendered.
  const rowState = getWindow({ loadedCount: sorted.length, totalRowCount: virtualRowCount, range });
  const rowCount = rowState.rowCount;
  const rowsBefore = permaRows?.before;
  const totalRows = permaRows ? permaRows.before + rowCount + permaRows.after : undefined;
  const rowPositions = permaRows?.positions;
  // Rows from a previous query (loading) don't count as loaded.
  const loaded = loading ? null : { start: offset, end: offset + sorted.length };
  const showLoading = useSpinDelay(loading);
  // While loading, the row count is the previous query's. Capping requests with it would let a query with no results
  // block the next one forever.
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

  // Requests rows the viewport needs that aren't loaded or already requested.
  function requestRows() {
    const { height, row, direction } = viewportRef.current;
    // Before measuring, the rendered rows are just those given, not the ones needed.
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
    // Keep a pending request that still has the top visible row. Replacing it restarts the wait, over and over on a
    // slow network. The rest is requested when it arrives.
    const first = Math.min(row, Math.max(0, requestableRowCount - 1));
    const pending = pendingRef.current;
    if (pending?.queryKey === queryKey && containsRange(pending.range, { start: first, end: first + 1 })) return;
    pendingRef.current = { queryKey, range: requested };
    onRangeChange?.(requested);
  }

  function scheduleRequestRows() {
    // No one to request from, so don't re-render when scrolling pauses.
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
    // The most rows the viewport and buffer span. Caps the every-row window rendered before measuring.
    const maxRows = Math.ceil((height + bufferPx * 2) / rowHeight) + 1;
    // From the latest window, since scrolling can move it again before a re-render.
    setRange((current) => getRenderedRange(current, around(bufferPx / 2), around(bufferPx), maxRows));
  }

  function updateColumnWindow(offsets: Float64Array) {
    const { scrollLeft, width, virtualStart } = viewportRef.current;
    if (width === 0) return;
    const left = scrollLeft - virtualStart;
    const around = (margin: number) => getColumnRange(offsets, left - margin, left + width + margin);
    setColumnWindow((current) => getRenderedRange(current, around(bufferPx / 2), around(bufferPx)));
  }

  // Only updates state, from its latest value, so measures before a re-render aren't lost. The column window follows
  // the new widths in the layout effect below.
  const reportColumnLayout = useStableCallback(({ virtualStart, widths, before, after }: ColumnLayout) => {
    const startMoved = viewportRef.current.virtualStart !== virtualStart;
    viewportRef.current.virtualStart = virtualStart;
    // Kept when unchanged, so cells reading column positions don't re-render on every measure.
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => n === b[i]);
    setPermaColumns((current) =>
      current && same(current.before, before) && same(current.after, after) ? current : { before, after },
    );
    setColumnWidths((current) => {
      let next: Map<number, number> | null = null;
      for (const [index, width] of widths) {
        const known = current.get(index) ?? defaultColumnWidth;
        if (Math.abs(known - width) < 0.5) continue;
        next ??= new Map(current);
        next.set(index, width);
      }
      return next ?? current;
    });
    // The virtualised columns moved, even if their widths didn't.
    if (startMoved) updateColumnWindow(columnOffsets);
  });

  // Moves the column window to new widths once they render, before paint.
  const moveColumnWindow = React.useEffectEvent(() => updateColumnWindow(columnOffsets));
  React.useLayoutEffect(() => {
    moveColumnWindow();
  }, [columnOffsets]);

  // Counted once per change to the registered rows, from a complete snapshot.
  const reportRowLayout = useStableCallback((layout: RowLayout) => setPermaRows(layout));

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
    // The rows are the previous query's, whose selection is about to be replaced.
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

  // Checks for missing rows when scrolling pauses, rows arrive, the query changes, and on mount.
  const requestRowsAfterUpdate = React.useEffectEvent(() => {
    // Its rows arrived, so it no longer holds back the next request.
    const pending = pendingRef.current;
    // It can come back short at the end, so only rows that exist must arrive.
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
    // The reason lets consumers treat sorting and searching differently.
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
      rowPositions,
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
      rowPositions,
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
  const { queryKey, setScrollPosition, setViewportSize } = grid;

  // Before paint, so the new query's rows don't flash at the old scroll position.
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = 0;
    setScrollPosition(0, ref.current.scrollLeft);
  }, [queryKey, setScrollPosition]);

  // The viewport's size decides which rows and columns are visible.
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportSize(element.clientWidth, element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [setViewportSize]);

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
/** Non-virtualised rows, like header rows, so `Grid.VirtualRows` can number them without searching the DOM. */
type RowRegistry = ItemRegistry<symbol, Registered<null>>;
const RowRegistryContext = React.createContext<RowRegistry | null>(null);

export function Table({ children, style, ...props }: React.ComponentProps<'div'>) {
  const grid = useGridContext();
  const id = React.useId();
  const table = React.useMemo(() => ({ id }), [id]);
  const rows = useItemRegistry<symbol, Registered<null>>();

  return (
    <TableContext.Provider value={table}>
      <RowRegistryContext.Provider value={rows}>
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
      </RowRegistryContext.Provider>
    </TableContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * GridColumnGroup
 * -----------------------------------------------------------------------------------------------*/

/**
 * Declares column widths and pinning. Offsets each pinned column by those pinned before it on its side, so the
 * `Grid.Column`s must be direct children.
 */
export function ColumnGroup({ children }: { children?: React.ReactNode }) {
  const id = React.useContext(TableContext)?.id;
  const columns = React.Children.toArray(children).flatMap((child) =>
    React.isValidElement<ColumnProps>(child) && typeof child.props.name === 'string' ? [child.props] : [],
  );
  const offsets: string[] = [];
  // End-pinned columns are offset from the right, so count from the last.
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
   * Matches a `Grid.HeaderCell` and `Grid.Cell` `name`. Characters other than letters, numbers, `-` and `_` become `_`,
   * so names like `a b` and `a_b` clash.
   */
  name: string;
} & (
  | {
      /** A fixed width. Columns without one share the remaining space. */
      width?: number | string;
      pinned?: undefined;
    }
  | {
      width: number | string;
      /** Sticks to an edge when scrolling sideways. Needs `width` to offset the columns pinned after it. */
      pinned: 'start' | 'end';
    }
);

/** One column's width and pinning, as CSS rules its cells read, so widths apply before any JavaScript runs. */
export function Column({ name, width, pinned }: ColumnProps) {
  const id = React.useContext(TableContext)?.id;
  if (!id) return null;
  // :where() has no specificity, so the consumer's own styles win.
  const grid = `[data-grid=${JSON.stringify(id)}]`;
  const rules: string[] = [];

  if (width !== undefined) rules.push(`:where(${grid}) { ${columnVariable(name)}: 0 0 ${cssLength(width)}; }`);

  if (pinned) {
    // `Grid.ColumnGroup` sets the offset from the columns pinned before this one.
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

export function HeaderRow({ children, style, ref: forwardedRef, ...props }: HeaderRowProps) {
  const registry = useItemRegistry<symbol, Registered<HeaderCellData>>();
  const { ref, ariaRowIndex } = useRowNumber(true, forwardedRef);
  return (
    <HeaderRowContext.Provider value={registry}>
      <div role="row" aria-rowindex={ariaRowIndex} {...props} ref={ref} style={{ display: 'flex', ...style }}>
        {typeof children === 'function' ? <VirtualHeaderCells>{children}</VirtualHeaderCells> : children}
      </div>
    </HeaderRowContext.Provider>
  );
}

/** A header cell's name, and its column index if virtualised. */
type HeaderCellData = { name: string; index: number | undefined };
/** The header cells rendered in a `Grid.HeaderRow`, so `Grid.VirtualHeaderCells` can measure them. */
type HeaderCellRegistry = ItemRegistry<symbol, Registered<HeaderCellData>>;

/* -------------------------------------------------------------------------------------------------
 * GridVirtualHeaderCells
 * -----------------------------------------------------------------------------------------------*/

/**
 * Header cells for virtualised columns: `{(index) => <Grid.HeaderCell … />}` is called for visible ones only. Also
 * measures them, replacing `defaultColumnWidth` with their real widths.
 */
export function VirtualHeaderCells({ children }: VirtualColumnsProps) {
  const grid = useGridContext();
  const registry = useHeaderRowContext('Grid.VirtualHeaderCells');
  const spacerRef = React.useRef<HTMLDivElement>(null);
  const { reportColumnLayout } = grid;
  const { items, liveItems } = registry;

  // Observes every header cell in the latest snapshot, starting again as cells come and go with the visible columns.
  React.useLayoutEffect(() => {
    const spacer = spacerRef.current;
    if (!spacer) return;

    // Reports after the browser's own layout, so measuring forces no extra one: once per cell, then on width changes
    // (CSS loading, restyling). Other header cells are observed too, so where the virtualised columns start, and the
    // columns around them, stay current.
    const observer = new ResizeObserver((entries) => {
      // Live cells, which can be ahead of the snapshot when the observer reports.
      const cells = inPageOrder(liveItems);
      const indexByElement = new Map(cells.map(([, cell]) => [cell.element, cell.data.index]));
      const widths = new Map<number, number>();
      for (const entry of entries) {
        const index = indexByElement.get(entry.target);
        if (index !== undefined) widths.set(index, entry.borderBoxSize[0].inlineSize);
      }
      // Non-virtualised columns' names, in order, split around the virtualised ones.
      const before: string[] = [];
      const after: string[] = [];
      for (const [, cell] of cells) {
        if (cell.data.index !== undefined) continue;
        const isBefore = spacer.compareDocumentPosition(cell.element) & Node.DOCUMENT_POSITION_PRECEDING;
        (isBefore ? before : after).push(cell.data.name);
      }
      reportColumnLayout({ virtualStart: spacer.offsetLeft, widths, before, after });
    });

    for (const cell of items.values()) observer.observe(cell.element);
    return () => observer.disconnect();
  }, [items, liveItems, reportColumnLayout]);

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
  // Registered while mounted, so `Grid.VirtualHeaderCells` can measure it.
  const data = React.useMemo(() => ({ name, index }), [name, index]);
  const { ref } = useRegisteredElement(registry, data, forwardedRef);
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
   * Called for each rendered row with its index in the `rows` given to `Grid.Root`, whatever the grid's sort or filter,
   * or `undefined` if it hasn't loaded (its `Grid.Row` then renders as a loading row). The index is only valid for
   * this render's `rows`, so keep the row or its `id`, not the index.
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
 * Rows up to `virtualRowCount`: `{(index) => <Grid.Row … />}` is called for each rendered row, and spacers stand in
 * for the rest. Other rows can sit before or after it, like an add row.
 */
export function VirtualRows({ children }: VirtualRowsProps) {
  const grid = useGridContext();
  const rowWindow = useRowWindowContext();
  const startRef = React.useRef<HTMLDivElement>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const registeredRows = React.useContext(RowRegistryContext)?.items;
  const { reportRowLayout } = grid;

  // Counts and numbers the rows around these ones, once per registry snapshot, so rows added later are included.
  React.useLayoutEffect(() => {
    const start = startRef.current;
    const end = endRef.current;
    if (!registeredRows || !start || !end) return;
    const positions = new Map<symbol, RowPosition>();
    let before = 0;
    let after = 0;
    for (const [key, { element }] of inPageOrder(registeredRows)) {
      if (start.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) {
        positions.set(key, { before: true, place: ++before });
      } else if (end.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
        positions.set(key, { before: false, place: ++after });
      }
    }
    reportRowLayout({ before, after, positions });
  }, [registeredRows, reportRowLayout]);

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
 * `index`: grid position, for selection and `aria-rowindex`. `itemIndex`: position in `rows`. Both `item` and
 * `itemIndex` are `undefined` until loaded. `item` isn't rendered, but comparing it re-renders a row given a new item.
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

// Parts read the grid here and pass only what they need to a memoised part, so they render only when that changes.
/** A function as children renders only virtualised cells, the same as `Grid.VirtualCells`. */
export function Row({ index, ref: forwardedRef, ...props }: RowProps) {
  const grid = useGridContext();
  const bodyRow = React.useContext(BodyRowContext);
  // Non-virtualised rows register, so `Grid.VirtualRows` can number them.
  const { ref, ariaRowIndex: placeIndex } = useRowNumber(bodyRow === null, forwardedRef);
  const rowIndex = index ?? bodyRow?.index;
  // An unloaded virtualised row still renders, to hold placeholder cells or none.
  const loading = bodyRow !== null && bodyRow.itemIndex === undefined;
  // Virtualised rows come after the rows counted before them.
  const ariaRowIndex =
    rowIndex !== undefined && grid.rowsBefore !== undefined ? grid.rowsBefore + rowIndex + 1 : placeIndex;
  return (
    <MemoRow
      {...props}
      ref={ref}
      index={rowIndex}
      ariaRowIndex={ariaRowIndex}
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

/** `name` sets the cell's width and position. Its content is up to the consumer. */
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
  // An unloaded row can't be selected: there's nothing to see yet.
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
  // Checked when every row is selected, through `all` or one by one.
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
  // Always rendered, even at 0px: `Grid.VirtualRows` uses its spacers to find the rows around it.
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

// Cells size from CSS variables each `Grid.Column` defines, so widths apply in the server's HTML before any JavaScript
// runs. Names become part of the variable names, so other characters become `_` (`a b` and `a_b` share one).
const cssIdent = (name: string) => name.replace(/[^\w-]/g, '_');
// Values go into a <style> element, so strip anything that could close the rule or the element.
const cssValue = (value: string) => value.replace(/[;{}<>]/g, '');
const cssLength = (value: number | string) => cssValue(typeof value === 'number' ? `${value}px` : value);
const columnVariable = (name: string) => `--grid-col-${cssIdent(name)}`;
// A pinned column's offset from its edge: the widths of the columns pinned before it.
const pinVariable = (name: string) => `--grid-pin-${cssIdent(name)}`;

// Without a width variable, virtualised columns use their known width, since the grid adds them up. Others share the
// remaining space.
const columnStyle = (name: string, width?: number): React.CSSProperties => ({
  flex: `var(${columnVariable(name)}, ${width === undefined ? '1 1 0' : `0 0 ${width}px`})`,
  minWidth: 0,
});

/**
 * Registers a non-virtualised row, and gives its `aria-rowindex` once `Grid.VirtualRows` counts it on the client.
 * Without virtualised rows nothing is counted, and none needs one: every row is in the DOM.
 */
function useRowNumber(registered: boolean, forwardedRef: React.Ref<HTMLDivElement> | undefined) {
  const grid = useGridContext();
  const rows = React.useContext(RowRegistryContext);
  const { key, ref } = useRegisteredElement(registered ? rows : null, null, forwardedRef);
  const position = grid.rowPositions?.get(key);
  let ariaRowIndex: number | undefined;
  if (position?.before) ariaRowIndex = position.place;
  else if (position && grid.rowsBefore !== undefined) ariaRowIndex = grid.rowsBefore + grid.rowCount + position.place;
  return { ref, ariaRowIndex };
}

/** A registered element, with the data its part gives the registry's owner. */
type Registered<Data> = { element: Element; data: Data };

/**
 * Registers the ref's element under its own key while mounted, and sets `forwardedRef` too. Without a registry, the
 * ref is just `forwardedRef`. Keep `data` memoised, or the element re-registers on every render.
 */
function useRegisteredElement<Data>(
  registry: ItemRegistry<symbol, Registered<Data>> | null,
  data: Data,
  forwardedRef: React.Ref<HTMLDivElement> | undefined,
) {
  const [key] = React.useState(() => Symbol());
  const register = registry?.registerItem;
  const ref = React.useCallback(
    (element: HTMLDivElement) => {
      const unregister = register?.(key, { element, data });
      const detach = attachRef(forwardedRef, element);
      return () => {
        unregister?.();
        detach();
      };
    },
    [register, key, data, forwardedRef],
  );
  return { key, ref: register ? ref : forwardedRef };
}

/** Sorts registered elements into the order they appear in the page. */
function inPageOrder<Item extends { element: Element }>(items: Iterable<[symbol, Item]>) {
  return [...items].sort(([, a], [, b]) =>
    a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

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
 * A cell's `aria-colindex`. Virtualisation leaves columns out of the DOM, so assistive tech can't count positions:
 * every cell gives its own, or those after the virtualised ones would be miscounted. Unknown until measured.
 */
function getColumnIndex(
  grid: Pick<GridContextValue<RowData>, 'columnsBefore' | 'columnPositions'>,
  column: string,
  virtual: { index: number } | null,
) {
  if (!virtual) return grid.columnPositions?.get(column);
  return grid.columnsBefore === undefined ? undefined : grid.columnsBefore + virtual.index + 1;
}
