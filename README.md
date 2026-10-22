# Data Source Explorer

A proof of concept for `createDataSource`, one API for rows that come from the server, the client, or both. It also
includes a small composable grid (`components/grid.tsx`) for showing the rows. The grid supports sorting, search,
selection, and row and column virtualisation.

## Demos

| Route     | What it shows                                                                                                                                                 | Code                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `/server` | A Server Component builds the source, with a computed `total`, and renders every row. No client sorting.                                                      | `app/server/page.tsx`      |
| `/client` | The server sends all 5000 rows with their metadata. The client sorts, searches and virtualises them.                                                          | `app/client/page.tsx`      |
| `/lazy`   | The server renders the first 20 rows. The client fetches 200-row ranges from `/api/products` as you scroll, sort and search, and virtualises 52 week columns. | `components/lazy-grid.tsx` |

`/` redirects to `/server`.

## Run and verify

```bash
pnpm dev
```

```bash
node --test tests/*.test.mjs
```

```bash
pnpm exec tsc --noEmit
```

## Data source

```ts
const source = createDataSource(products, {
  metadata: (item) => ({ total: item.price * item.quantity }),
});
```

- **Input:** an array of rows, another `DataSource`, or serialised entries.
- **Metadata:** computed columns, keyed by column name.
- **Crossing to the client:** passing a source from a Server Component sends `{ item, metadata }` entries. Metadata
  functions can't be serialised, so the values are computed on the server.
- **Reading rows:**
  - `at(index)` returns a row.
  - `get(row, column)` returns a column's value, checking metadata before the row's own fields.
  - `items`, `map()`, `length` and `columns` describe the rows.
- **Deriving sources:** `filter(text | predicate, columns?)` and `sort({ column, direction } | comparator)` return new
  sources and leave the original as it was. `originalIndex(i)` gives a row's position before filtering or sorting.
- **Immutability:** treat rows as immutable. Replace a row object instead of changing it in place, because
  metadata is cached per object.

## Grid

Import the parts with `import * as Grid from '@/components/grid'`. `Grid.Root` holds state and renders no DOM of its
own. You build the table from the other parts:

```tsx
<Grid.Root rows={rows} searchColumns={['name']} defaultSort={{ column: 'id', direction: 'asc' }}>
  <Grid.SearchInput />
  <Grid.Viewport className="grid-scroll">
    <Grid.Table aria-label="Products">
      <Grid.ColumnGroup>
        <Grid.Column name="id" width={80} pinned="start" />
      </Grid.ColumnGroup>
      <Grid.Header>
        <Grid.HeaderRow>
          <Grid.HeaderCell name="select">
            <Grid.SelectAll />
          </Grid.HeaderCell>
          <Grid.HeaderCell name="id">
            <Grid.SortButton>ID</Grid.SortButton>
          </Grid.HeaderCell>
          <Grid.HeaderCell name="name">
            <Grid.SortButton>Product</Grid.SortButton>
          </Grid.HeaderCell>
        </Grid.HeaderRow>
      </Grid.Header>
      <Grid.Body>
        {(index) => {
          const row = index !== undefined ? rows[index] : undefined;
          return (
            <Grid.Row>
              <Grid.Cell name="select">
                <Grid.Checkbox disabled={!row} aria-label={row && `Select ${row.name}`} />
              </Grid.Cell>
              <Grid.Cell name="id">{row?.id ?? <Skeleton />}</Grid.Cell>
              <Grid.Cell name="name">{row?.name ?? <Skeleton />}</Grid.Cell>
            </Grid.Row>
          );
        }}
      </Grid.Body>
    </Grid.Table>
    <Grid.Empty>No matching products.</Grid.Empty>
  </Grid.Viewport>
</Grid.Root>
```

- **Children for `Grid.Body`:**
  - Ordinary children render as they are.
  - A function renders only the rows in view. It's called with the row's index in the `rows` you passed, whatever the
    grid's sort or filter. Look the row up in the same render, and keep the row or its `id`, not the index.
  - For a row that hasn't loaded, the index is `undefined`, and its `Grid.Row` renders as a loading row
    (`aria-busy`, `data-placeholder`, `rowHeight` tall, checkboxes disabled). Fill it with placeholder cells, like
    `<Grid.Cell name="name">{row?.name ?? <Skeleton />}</Grid.Cell>`, or return an empty `<Grid.Row />`.
  - A function given in a Server Component can't reach the client, so wrap it in a Client Component, as
    `components/client-grid.tsx` does.
- **Rows:** each needs an `id`, either a field or metadata. Rows are a fixed `rowHeight` (44px by default), so match
  your CSS to it.
- **State:** `rows`, `sort`, `search` and `selected` can each be controlled, or left uncontrolled with `default…`
  props. Leave `sort` or `search` uncontrolled and the grid sorts or filters locally. Control them and you do it
  yourself, through `onSortChange` or `onSearchChange`.
- **Columns:** `Grid.Column` sets widths and pins columns. Columns without a width share the remaining space.
  `Grid.VirtualHeaderCells` and `Grid.VirtualCells` render only the columns in view (`virtualColumnCount`,
  `defaultColumnWidth`).
- **Selection parts:** `Grid.Checkbox`, `Grid.SelectAll`, `Grid.Empty` and `Grid.State` (row and selection counts)
  are optional.

### Lazy loading

Pass the rows you have, where they start (`offset`), and the full count (`virtualRowCount`). The grid reserves the
whole scroll height, renders loading rows for rows that haven't loaded, and calls `onRangeChange({ start, end })` when
it needs more. `rangeSize` and `threshold` control how much it asks for and how early. Set `loading` while a new sort
or search is on its way, so the old rows aren't treated as current. `/lazy` handles cancelling, caching and retries.

### Selection

`Selected` is `{ all, ranges }`, with ranges as `[start, end)` row positions. With `all: true`, the ranges are the
rows _not_ selected, so Select All never lists positions. Shift-click selects a span.

When the sort or search changes, the grid calls `onSelectedChange` with an empty selection and the reason
`'sort-change'` or `'search-change'`. Ignore that to keep the selection, as `/lazy` does: it POSTs the old query and
selection to `/api/products`, which maps them to the same products' positions in the new results. Products the new
search hides are dropped.

## Limitations

- Fixed-height rows only.
- No grouped or tree data, no persistence, and no spreadsheet-style keyboard navigation.
- `lib/products-query.ts` stands in for a database. It filters and sorts in memory, and its comments give the SQL a
  real backend would use. Selection translation assumes the data doesn't change between requests.
