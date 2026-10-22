import 'server-only';
import { createDataSource, type Selected } from '@/lib/data-source';
import { products, weeks, type Product, type ProductRow } from '@/lib/products';

const rows = products.map((item) => ({
  ...item,
  total: item.price * item.quantity,
  sales: Array.from({ length: weeks }, (_, week) => 5 + ((item.id * 31 + week * 17) % 95)),
}));
// This module stands in for a database. Everything lives in memory here, so each query filters and sorts every row;
// a real backend would let its indexes do that, as the SQL comments below show.
// createDataSource here just provides the equivalent of the consumer's search and sorting, so this PoC doesn't
// need to reimplement them.
const source = createDataSource(rows);

type ColumnSort = Exclude<Parameters<typeof source.sort>[0], (...args: never[]) => unknown>;
type ProductColumn = ColumnSort['column'];
// One week's sales, named like the grid's week columns: `week-0` to `week-51`.
type WeekColumn = `week-${number}`;
type ProductSort = { column: ProductColumn | WeekColumn; direction: ColumnSort['direction'] };
export type ProductsQuery = {
  start: number;
  end: number;
  search: string;
  searchColumns: ProductColumn[];
  sort: ProductSort;
};

// Weekly sales are numbers per week, not text worth searching.
const searchableColumns = Object.keys(rows[0]).filter((key) => key !== 'sales') as ProductColumn[];
const sortableColumns: ProductColumn[] = ['id', 'name', 'price', 'quantity', 'total'];

/** The week a `week-<index>` column sorts by, or null if it isn't one of the weeks. */
function getWeek(column: string) {
  const week = /^week-(\d+)$/.exec(column)?.[1];
  return week !== undefined && Number(week) < weeks ? Number(week) : null;
}

/** Reads a query from search params, or returns null if it's invalid. */
export function parseProductsQuery(params: URLSearchParams): ProductsQuery | null {
  const start = Number(params.get('start') ?? 0);
  const end = Number(params.get('end') ?? 25);
  const requestedColumns = params.getAll('searchField').filter(Boolean);
  const column = params.get('sort') ?? 'id';
  const direction = params.get('direction') ?? 'asc';

  const validRange = Number.isInteger(start) && start >= 0 && Number.isInteger(end) && end >= start;
  const validColumns = requestedColumns.every((name) => searchableColumns.includes(name as ProductColumn));
  const validColumn = sortableColumns.includes(column as ProductColumn) || getWeek(column) !== null;
  const validSort = validColumn && (direction === 'asc' || direction === 'desc');
  if (!validRange || !validColumns || !validSort) return null;

  return {
    start,
    end,
    search: params.get('search') ?? '',
    searchColumns: requestedColumns.length ? (requestedColumns as ProductColumn[]) : searchableColumns,
    sort: { column: column as ProductSort['column'], direction },
  };
}

// Recently sorted results, so paging through one sort (and translating a selection from the query the user was just
// on) doesn't sort every product again. The data never changes here; a store that changes would clear this on writes.
const recentResults = new Map<string, ProductRow[]>();
const maxRecentResults = 10;

/**
 * Every product matching the query, in its sort order.
 * SQL: `SELECT * FROM products WHERE name ILIKE $search OR … ORDER BY price DESC, id`, or for a week,
 * `ORDER BY sales[$week + 1] DESC, id`.
 */
export function queryProducts({ search, searchColumns, sort }: Omit<ProductsQuery, 'start' | 'end'>) {
  const key = JSON.stringify([search.toLowerCase(), searchColumns, sort.column, sort.direction]);
  let result = recentResults.get(key);
  if (result) {
    recentResults.delete(key); // re-insert below, so the map stays ordered from least to most recently used
  } else {
    const matching = source.filter(search, searchColumns);
    const week = getWeek(sort.column);
    const direction = sort.direction === 'asc' ? 1 : -1;
    const sorted =
      week === null
        ? matching.sort(sort as ColumnSort)
        : matching.sort((a, b) => direction * (a.sales[week] - b.sales[week]));
    result = sorted.items;
    if (recentResults.size >= maxRecentResults) recentResults.delete(recentResults.keys().next().value!);
  }
  recentResults.set(key, result);
  return result;
}

/**
 * The rows in the query's range, plus where they start and how many rows match in total.
 * Pass `matching` when you already have the query's rows, to avoid sorting them again.
 * SQL: the query above with `LIMIT $end - $start OFFSET $start`, plus `SELECT count(*)` for the total.
 */
export function getProductsPage(query: ProductsQuery, matching = queryProducts(query)) {
  return { items: matching.slice(query.start, query.end), start: query.start, total: matching.length };
}

function isRanges(value: unknown): value is Selected['ranges'] {
  return (
    Array.isArray(value) &&
    value.every(
      (range) =>
        Array.isArray(range) &&
        range.length === 2 &&
        Number.isInteger(range[0]) &&
        Number.isInteger(range[1]) &&
        range[0] >= 0 &&
        range[1] >= range[0],
    )
  );
}

export function isSelection(value: unknown): value is Selected {
  return (
    typeof value === 'object' &&
    value !== null &&
    'all' in value &&
    typeof value.all === 'boolean' &&
    'ranges' in value &&
    isRanges(value.ranges)
  );
}

/**
 * Maps a selection from `previousQuery`'s results to the same products in `rows` (the new query's results).
 * With `all`, only the exceptions are positions, so only they need translating.
 *
 * In SQL: find the ids at the old positions (`ORDER BY <old sort> LIMIT … OFFSET …` per range), then their new
 * positions (`row_number() OVER (ORDER BY <new sort>)`, keeping only those ids), so the indexes do the work.
 */
export function translateSelection(
  { all, ranges }: Selected,
  previousQuery: Omit<ProductsQuery, 'start' | 'end'>,
  rows: Product[],
): Selected {
  // Nothing selected, or everything with no exceptions: there are no positions to move.
  if (ranges.length === 0) return { all, ranges: [] };

  const previousRows = queryProducts(previousQuery);
  const selectedIds = new Set(ranges.flatMap(([start, end]) => previousRows.slice(start, end).map((row) => row.id)));
  const translated: Selected['ranges'] = [];
  let found = 0;
  for (let index = 0; index < rows.length && found < selectedIds.size; index++) {
    if (!selectedIds.has(rows[index].id)) continue;
    found++;
    const last = translated.at(-1);
    if (last && last[1] === index) last[1] = index + 1;
    else translated.push([index, index + 1]);
  }
  return { all, ranges: translated };
}
