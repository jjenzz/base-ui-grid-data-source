'use client';

import * as React from 'react';
import { type Product, type ProductRow, columns, itemsPerPage, productCategories, weeks } from '@/lib/products';
import { currency } from '@/lib/currency';
import * as Grid from './grid';
import type { Sort } from './grid';

type View = { search: string; sort: Sort<ProductRow> };
type Range = { start: number; end: number };
const searchColumns = ['name', 'category'] as const;

export function ConsumerLazyGrid({
  defaultRows = [],
  totalRowCount,
}: {
  defaultRows?: ProductRow[];
  totalRowCount: number;
}) {
  const activeRequestRef = React.useRef<AbortController | null>(null);
  // Saving isn't connected yet, so the last product submitted is just shown.
  const [added, setAdded] = React.useState<Omit<Product, 'id'> | null>(null);
  const [view, setView] = React.useState<View>({ search: '', sort: { column: 'id', direction: 'asc' } });
  const [error, setError] = React.useState<{ range: Range; message: string } | null>(null);
  const [data, setData] = React.useState({
    view,
    start: 0,
    items: defaultRows,
    total: totalRowCount,
    selected: { all: false, ranges: [] } as Grid.Selected,
  });

  // Rows and selection still belong to data.view until the new view arrives.
  const loading = data.view !== view;

  function loadRange(range: Range, signal: AbortSignal) {
    const previousQuery = { ...data.view, searchColumns };
    // Ignore selection changes while loading, so snapshot can't go stale mid-request.
    const selection = loading && { previousQuery, selected: data.selected };
    return getProducts({ ...view, ...selection, searchColumns, range }, signal);
  }

  function handleRangeChange(range: Range) {
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;

    loadRange(range, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setError(null);
        setData((previous) => ({ view, ...result, selected: result.selected ?? previous.selected }));
      },
      (error) => {
        if (controller.signal.aborted) return;
        setError({ range, message: error instanceof Error ? error.message : 'Could not load products.' });
      },
    );
  }

  return (
    <section className="panel">
      <Grid.Root
        rows={data.items}
        offset={data.start}
        loading={loading && !error}
        search={view.search}
        sort={view.sort}
        threshold={50}
        virtualRowCount={data.total}
        virtualColumnCount={weeks}
        defaultColumnWidth={90}
        searchColumns={searchColumns}
        selected={data.selected}
        rangeSize={itemsPerPage}
        onRangeChange={handleRangeChange}
        onSearchChange={(search) => setView((prev) => ({ ...prev, search }))}
        onSortChange={(sort) => setView((prev) => ({ ...prev, sort }))}
        onSelectedChange={(selected, details) => {
          // The server translates the selection for a new sort or search, so ignore the grid clearing it.
          if (details.reason !== 'search-change' && details.reason !== 'sort-change') {
            setData((d) => ({ ...d, selected }));
          }
        }}
      >
        <div className="toolbar">
          <label>
            Search products
            <Grid.SearchInput placeholder="Try furniture…" />
          </label>
        </div>

        <Grid.Viewport className="grid-scroll">
          <Grid.Table aria-label="Product inventory">
            <Grid.ColumnGroup>
              <Grid.Column name="select" width={44} pinned="start" />
              <Grid.Column name="id" width={80} pinned="start" />
            </Grid.ColumnGroup>

            <Grid.Header>
              <Grid.HeaderRow>
                <Grid.HeaderCell name="select">
                  <Grid.SelectAll />
                </Grid.HeaderCell>

                {columns.map((column) => (
                  <Grid.HeaderCell key={column.name} name={column.name}>
                    {column.name === 'category' ? column.label : <Grid.SortButton>{column.label}</Grid.SortButton>}
                  </Grid.HeaderCell>
                ))}

                {/* Virtualize 52 weeks of sales */}
                <Grid.VirtualHeaderCells>
                  {(index) => (
                    <Grid.HeaderCell name={`week-${index}`}>
                      <Grid.SortButton>Week {index + 1}</Grid.SortButton>
                    </Grid.HeaderCell>
                  )}
                </Grid.VirtualHeaderCells>
              </Grid.HeaderRow>
            </Grid.Header>

            <Grid.Body>
              {/* Not virtualised: always rendered, and pinned under the header */}
              <AddProductRow onAdd={setAdded} />

              <Grid.VirtualRows>
                {(index) => {
                  const row = index !== undefined ? data.items[index] : null;
                  return (
                    <Grid.Row>
                      <Grid.Cell name="select">
                        <Grid.Checkbox disabled={!row} aria-label={row ? `Select ${row.name}` : ''} />
                      </Grid.Cell>

                      {columns.map((column) => (
                        <Grid.Cell key={column.name} name={column.name}>
                          {!row ? (
                            <Skeleton />
                          ) : column.name === 'price' || column.name === 'total' ? (
                            currency(row[column.name])
                          ) : (
                            String(row[column.name])
                          )}
                        </Grid.Cell>
                      ))}

                      <Grid.VirtualCells>
                        {(week) => <Grid.Cell name={`week-${week}`}>{row?.sales[week] ?? '-'}</Grid.Cell>}
                      </Grid.VirtualCells>
                    </Grid.Row>
                  );
                }}
              </Grid.VirtualRows>
            </Grid.Body>
          </Grid.Table>
          <Grid.Empty className="empty">No matching products.</Grid.Empty>
        </Grid.Viewport>

        <Grid.State>
          {({ rowCount, mountedCount, selectedCount }) => (
            <p className="grid-caption">
              {rowCount} rows in this view · {mountedCount} row elements mounted · {selectedCount} selected
            </p>
          )}
        </Grid.State>
      </Grid.Root>

      {added && (
        <p role="status" className="status">
          Saving isn&apos;t connected yet. Would add {added.name} ({added.category}, {currency(added.price)} ×{' '}
          {added.quantity}).
        </p>
      )}

      {error && (
        <p role="alert">
          {error.message} <button onClick={() => handleRangeChange(error.range)}>Retry</button>
        </p>
      )}

      <footer>
        {data.items.length} of {data.total} products held in memory · Scroll to load another range
      </footer>
    </section>
  );
}

/** A grey bar standing in for a cell's value while its row loads. The row already says it's loading, so it's hidden. */
function Skeleton() {
  return <span className="skeleton" aria-hidden="true" />;
}

function AddProductRow({ onAdd }: { onAdd: (product: Omit<Product, 'id'>) => void }) {
  return (
    <form
      role="none"
      className="add-row"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        onAdd({
          name: String(data.get('name')).trim(),
          category: String(data.get('category')),
          price: Number(data.get('price')),
          quantity: Number(data.get('quantity')),
        });
        form.reset();
      }}
    >
      <Grid.Row aria-label="Add a product">
        <Grid.Cell name="select">
          <button type="submit" aria-label="Add product">
            +
          </button>
        </Grid.Cell>
        <Grid.Cell name="id">New</Grid.Cell>
        <Grid.Cell name="name">
          <input name="name" required placeholder="Product name" aria-label="Product name" />
        </Grid.Cell>
        <Grid.Cell name="category">
          <select name="category" aria-label="Category">
            {productCategories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </Grid.Cell>
        <Grid.Cell name="price">
          <input name="price" type="number" min={0} required placeholder="£" aria-label="Price" />
        </Grid.Cell>
        <Grid.Cell name="quantity">
          <input name="quantity" type="number" min={0} required placeholder="0" aria-label="Stock" />
        </Grid.Cell>
        <Grid.Cell name="total" />
        <Grid.VirtualCells>{(index) => <Grid.Cell name={`week-${index}`} />}</Grid.VirtualCells>
      </Grid.Row>
    </form>
  );
}

type ProductsQuery = {
  range: { start: number; end: number };
  search: string;
  searchColumns: readonly (keyof ProductRow)[];
  sort: Sort<ProductRow>;
  previousQuery?: { search: string; searchColumns: readonly (keyof ProductRow)[]; sort: Sort<ProductRow> };
  selected?: Grid.Selected;
};

async function getProducts(
  query: ProductsQuery,
  signal: AbortSignal,
): Promise<{ items: ProductRow[]; start: number; total: number; selected?: Grid.Selected }> {
  const url = `/api/products?${toSearchParams(query)}`;
  // Paging uses GET so the browser can cache it. Translating a selection needs a body, so it uses POST.
  const response = query.previousQuery
    ? await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previousQuery: toSearchParams(query.previousQuery).toString(),
          selected: query.selected,
        }),
        signal,
      })
    : await fetch(url, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not load products.');
  return result;
}

// Always built in the same order, because the URL is the browser's cache key.
function toSearchParams({
  range,
  search,
  sort,
  searchColumns,
}: Pick<ProductsQuery, 'search' | 'sort' | 'searchColumns'> & { range?: Range }) {
  const params = new URLSearchParams({ search, sort: sort.column, direction: sort.direction });
  for (const column of searchColumns) params.append('searchField', column);
  if (range) {
    params.set('start', String(range.start));
    params.set('end', String(range.end));
  }
  return params;
}
