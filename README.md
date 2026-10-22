# Data Source Explorer

Two examples of a unified `createDataSource` API:

- `/server`: a Server Component creates the source and passes it directly to the Grid. The iterator carries computed metadata over RSC. The Grid normalizes controlled `rows` internally and renders the supplied order. Rows only change when the caller changes them.
- `/client`: a Server Component supplies the first 25 products. The client loads and replaces one buffered window of at most 100 products as you scroll. `createDataSource(items, { offset, rowCount, metadata })` wraps the loaded window without traversing it. `.at(index)` addresses global row positions; `.items` and `.map()` cover loaded items. The grid reserves the full scroll height and renders placeholders for missing visible rows. The application owns remote sorting, filtering, cancellation, loading, and retry.

`/` redirects to `/server`.

## Run

Run `pnpm dev`, or `node node_modules/next/dist/bin/next dev` if the installed pnpm version cannot run with your Node version.

## Source contract

`createDataSource(input, options?)` returns a new `DataSource` class instance from an array, a live source, or serialized entries. Optional `select` computes metadata keyed by column ID. Without it, cells read the corresponding row field. A client getter overrides server-prepared metadata.

`filter(predicate)`, `sort(comparator)`, and `slice(start, end?)` return new sources. `defaultRows` seeds internal state once; subsequent default changes are ignored. `rows` takes precedence and is controlled: the Grid does not replace it. Sorting and search ownership are independent of row ownership. `useControllableState` handles row ownership. Optional `onRowsChange` reports row state updates; the client demo calls it when a fetched batch updates its rows. Rendering and derived views do not fire it. There are no imperative mutations or server/raw modes. Row identity is the row's existing `id`.

The Grid is a small demo table, not Mosaic. It virtualizes fixed-height DOM rows while retaining supplied data. It does not implement grouped/tree data, sparse remote windows, persistence, or spreadsheet keyboard navigation.

## Verify

- `node --test tests/*.test.mjs`
- `node node_modules/typescript/bin/tsc --noEmit`
- `node node_modules/next/dist/bin/next build`

## Composing the view

Import the parts with `import * as Grid from './grid'`. `Grid.Root` owns normalized data, controlled state, sorting, selection, and the visible window; it adds no DOM. The consumer composes `Grid.Viewport`, `Grid.Table`, `Grid.Header`, `Grid.HeaderRow`, `Grid.HeaderCell`, `Grid.SortButton`, `Grid.Body`, `Grid.Row`, and `Grid.Cell`.

`Grid.Body` accepts ordinary children or a render function, called for each visible loaded row with that row's index in the `rows` given to `Grid.Root`. The grid may sort or filter its own copy, but the index always points into the rows you passed, so `rows[index]` (or `source.at(index)`) is the row. The index is only valid for the `rows` given in that render: look the row up straight away, and keep the row or its `id`, not the index. `Grid.Cell` renders whatever content it's given, like `rows[index].name`; its `column` only sets its width and position. Read computed metadata with `source.get(row, column)`, since it isn't a field of the row. `Grid.RowSelection`, `Grid.Empty`, and `Grid.State` are optional. Classes, labels, column order, currency formatting, and empty content belong to the consumer. The demos compose these parts directly in `app/server/page.tsx` and `app/consumer-grid.tsx`. The server example maps all prepared rows using ordinary children; the client example uses a render function for its virtualized rows.

```tsx
<Grid.Root rows={rows}>
  <Grid.Table aria-label="Products">
    <Grid.Header>
      <Grid.HeaderRow>
        <Grid.HeaderCell field="name"><Grid.SortButton>Product</Grid.SortButton></Grid.HeaderCell>
      </Grid.HeaderRow>
    </Grid.Header>
    <Grid.Body>
      {(index) => (
        <Grid.Row aria-label={rows[index].name}>
          <Grid.Cell column="name">{rows[index].name}</Grid.Cell>
        </Grid.Row>
      )}
    </Grid.Body>
  </Grid.Table>
</Grid.Root>
```

For virtual scrolling, include `Grid.Viewport` and match the consumer's row CSS to `rowHeight`. `Grid.Body` automatically inserts spacers when given a row render function, and infers their column span from the table header. Ordinary children are rendered directly. The defaults are 44px rows and 15 mounted rows, matching this demo. Native table semantics and checkbox selection are retained; these parts do not implement a full ARIA spreadsheet keyboard model.

The client passes `rowCount` to reserve the full matching dataset height, including unloaded rows. `onRangeChange` requests enough batches to cover the visible range, appending 25 products at a time immutably. Unloaded visible positions show placeholder rows while the sequential fetches catch up. Search and sort changes fetch a new first batch; previous rows remain visible until it arrives. Concurrent scroll requests are guarded, stale fetches are cancelled, failures can be retried, and loading stops at the matching total. Virtualization removes DOM rows while retaining loaded products.

`source.items` always contains the original row objects in source order, including when constructed from serialized entries or another source. The iterator retains computed cell metadata separately. The client row updater always receives a source and can append with `[...previous.items, ...result.items]`.

Search uses a model like sorting: `search={{ value: 'oak', fields: ['name', 'category'] }}`. Omit `fields` to search all row fields; an empty list searches none. Empty search text includes every row. Computed fields can be explicitly included. A controlled `search` model is processed by the consumer; `defaultSearch` enables local filtering. A controlled `sort` model is processed by the consumer; omitted `sort` enables local sorting, using `defaultSort` as its initial model. Controlled rows can use either local operation; the demo sends the same selected fields to its endpoint.

Search is controllable with `search`, `defaultSearch`, and `onSearchChange`. `Grid.SearchInput` inside `Grid.Root` reads the current model and requests value changes while preserving its selected fields. With `defaultSearch`, the grid filters locally. With `search`, the consumer handles filtering and updates its rows.

Data-source creation retains backing arrays without traversing them. Existing sources share storage and selected-metadata caches. Original input rows are treated as immutable: replace changed row objects rather than mutating them in place. Serialized `.items` is materialized on first access; serialization still visits the full collection.

Serialized entries use `{ item, metadata }`: `item` is the original row, and `metadata` holds computed fields from `select`.

## Selection

`Selected` is `{ all: boolean; ranges: [number, number][] }`, with exclusive range ends. With `all: false`, `ranges` are the selected rows; with `all: true`, every row is selected except those in `ranges`, so Select All never needs to list positions. `{ all: false, ranges: [] }` is a controlled empty selection; omitting `selected` enables internal state. The lazy consumer retains `checked` / `setChecked` names.

The grid privately retains Shift-click gesture history to allow growing and shrinking the active span. That history calculates proposed updates only: the supplied `selected` determines the rendered checkboxes. External replacements and query changes reset gesture history; loading another chunk does not.

The range maths behind selection (normalizing, adding and removing spans, counting) is internal to the grid, in `grid-model.ts`. Neither mutates the previous array. Pass the effective ranges with their search/sort query to the backend for bulk operations. Selection is cleared when search/sort changes; insertions or deletions that change positions also require invalidation. Server actions need a stable order and snapshot/version policy for concurrent dataset changes.

### Preserving selection across lazy query changes

The lazy demo posts `{ range, search, searchColumns, sort, previousQuery?, selectedRanges? }` to `/api/products`. The server resolves old positions to record IDs, ranks those records under the new query, and returns translated ranges with the new rows. Filtering retains selection only for records still visible in the filtered dataset. Rows, applied ordering, and selection update together; selection controls are disabled while translating. Older requests are aborted, and failed requests can be retried.

The grid clears selection automatically on query changes only when uncontrolled. Controlled consumers choose whether to clear or translate. This demo uses an immutable 240-product dataset and in-memory translation; a production database implementation needs snapshot consistency and ranking/join operations for large datasets.

### Grid internals

`grid-model.ts` contains pure window calculations, row-waiting transitions, and Shift-click proposals. `Grid.Root` retains controlled/uncontrolled state ownership and uses one previous-input record for query changes. The dynamic render-function body always virtualizes (`rangeSize` defaults to 25); missing buffered data alone triggers range requests. Ordinary RSC body children remain directly rendered markup.
