const DATA_SOURCE_ENTRY_SYMBOL = Symbol.for('@base-ui/react/data-source-entry');
// Created once: `localeCompare` with options rebuilds its rules on every call, making text sorts ~25× slower.
const collator = new Intl.Collator(undefined, { numeric: true });

/** What the iterator yields: rows with metadata already computed, since functions can't cross the RSC boundary. */
export interface DataSourceEntry<T, M extends Metadata = Metadata> {
  $$typeof: typeof DATA_SOURCE_ENTRY_SYMBOL;
  item: T;
  metadata?: M;
}

interface Options<T, M extends Metadata> {
  metadata?: (item: T) => M;
}

export type RowId = string | number;
export type Metadata = Record<string, string | number | boolean | null>;
export type Column<T, M extends Metadata = Metadata> = ((keyof T | keyof M) & string) & string;
export type ColumnValue<T, M, C> = C extends keyof M ? M[C] : C extends keyof T ? T[C] : T;
export type DataSourceInput<T, M extends Metadata = Metadata> = T[] | DataSource<T, M> | DataSourceEntry<T, M>[];
export type DataSourceSort<T, M extends Metadata = Metadata> = { column: Column<T, M>; direction: 'asc' | 'desc' };

/** A span of row positions. `end` is exclusive. */
export type SelectedRange = [start: number, end: number];
/** Which rows are selected. With `all`, every row is selected except those in `ranges`. */
export type Selected = { all: boolean; ranges: SelectedRange[] };

export class DataSource<T, M extends Metadata = Metadata> implements Iterable<DataSourceEntry<T, M>> {
  private data: T[] | DataSourceEntry<T, M>[];
  private readonly prepared: boolean;
  private readonly metadata?: (item: T) => M;
  private selectedMetadata: Map<T, M>;
  private entryByItem: Map<T, DataSourceEntry<T, M>>;
  private indexed = 0;
  private itemsCache?: T[];
  // Each row's index in the rows this source was created from, once filtered or sorted. Unset means unchanged.
  private positions?: readonly number[];

  constructor(input: DataSourceInput<T, M>, options?: Options<T, M>) {
    if (input instanceof DataSource) {
      this.data = input.data;
      this.prepared = input.prepared;
      this.metadata = options?.metadata ?? input.metadata;
      this.selectedMetadata = this.metadata === input.metadata ? input.selectedMetadata : new Map();
      this.entryByItem = input.entryByItem;
      this.itemsCache = input.itemsCache;
    } else {
      const first = input[0];
      this.data = input;
      this.metadata = options?.metadata;
      this.selectedMetadata = new Map();
      this.entryByItem = new Map();
      this.prepared =
        typeof first === 'object' &&
        first !== null &&
        '$$typeof' in first &&
        first.$$typeof === DATA_SOURCE_ENTRY_SYMBOL;
    }
  }

  *[Symbol.iterator](): IterableIterator<DataSourceEntry<T, M>> {
    for (let index = 0; index < this.length; index++) {
      const item = this.at(index)!;
      yield { $$typeof: DATA_SOURCE_ENTRY_SYMBOL, item, metadata: this.getMetadata(item) };
    }
  }

  private unwrap(entry: T | DataSourceEntry<T, M>): T {
    return this.prepared ? (entry as DataSourceEntry<T, M>).item : (entry as T);
  }

  get items(): T[] {
    if (!this.prepared) return this.data as T[];
    return (this.itemsCache ??= (this.data as DataSourceEntry<T, M>[]).map((entry) => entry.item));
  }

  get columns(): readonly Column<T, M>[] {
    const item = this.at(0);
    if (item === undefined) return [];
    const itemColumns = typeof item === 'object' && item !== null ? Object.keys(item) : [];
    return [...new Set([...itemColumns, ...Object.keys(this.getMetadata(item) ?? {})])];
  }

  get length() {
    return this.data.length;
  }

  private getStoredMetadata(item: T): M | undefined {
    if (!this.prepared) return undefined;
    const cached = this.entryByItem.get(item);
    if (cached) return cached.metadata;
    const entries = this.data as DataSourceEntry<T, M>[];
    while (this.indexed < entries.length) {
      const entry = entries[this.indexed++];
      this.entryByItem.set(entry.item, entry);
      if (entry.item === item) return entry.metadata;
    }
    return undefined;
  }

  private getMetadata(item: T): M | undefined {
    if (!this.metadata) return this.getStoredMetadata(item);
    if (!this.selectedMetadata.has(item)) this.selectedMetadata.set(item, this.metadata(item));
    return this.selectedMetadata.get(item);
  }

  at(index: number): T | undefined {
    const entry = this.data.at(index);
    if (entry === undefined) return undefined;
    if (this.prepared) {
      const stored = entry as DataSourceEntry<T, M>;
      this.entryByItem.set(stored.item, stored);
    }
    return this.unwrap(entry);
  }

  /** The row's index in the rows this source was created from, before any `filter` or `sort`. */
  originalIndex(index: number): number | undefined {
    if (index < 0 || index >= this.length) return undefined;
    return this.positions ? this.positions[index] : index;
  }

  get<C extends Column<T, M>>(item: T, column: C): ColumnValue<T, M, C> {
    const metadata = this.getMetadata(item);
    const value =
      metadata && Object.hasOwn(metadata, column)
        ? metadata[column]
        : typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>)[column]
          : item;
    return value as ColumnValue<T, M, C>;
  }

  map<U>(callback: (item: T, index: number, items: T[]) => U): U[] {
    return this.items.map(callback);
  }

  filter(search: string | ((item: T) => boolean), columns = this.columns): DataSource<T, M> {
    if (search === '') return this;
    const query = typeof search === 'string' ? search.toLowerCase() : '';
    const predicate =
      typeof search === 'function'
        ? search
        : (item: T) => columns.some((column) => String(this.get(item, column)).toLowerCase().includes(query));
    const kept = Array.from(this.data.keys()).filter((index) => predicate(this.unwrap(this.data[index])));
    return this.reorder(kept);
  }

  /** A new source with the rows at `order`, remembering where each one started. */
  private reorder(order: number[]): DataSource<T, M> {
    const source = new DataSource(this);
    source.data = order.map((index) => this.data[index]) as typeof this.data;
    source.itemsCache = undefined;
    source.positions = order.map((index) => this.positions?.[index] ?? index);
    return source;
  }

  sort(sort: DataSourceSort<T, M> | ((a: T, b: T) => number)): DataSource<T, M> {
    const indexes = Array.from(this.data.keys());
    // Nothing to reorder.
    if (!sort || this.data.length < 2) return this.reorder(indexes);
    if (typeof sort === 'function') {
      return this.reorder(indexes.sort((a, b) => sort(this.unwrap(this.data[a]), this.unwrap(this.data[b]))));
    }

    const values = this.data.map((entry) => this.get(this.unwrap(entry), sort.column) as unknown);
    const texts = values.map(String);
    const direction = sort.direction === 'asc' ? 1 : -1;
    const compare = (a: number, b: number) => {
      const left = values[a];
      const right = values[b];
      const comparison =
        typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(texts![a], texts![b]);
      return direction * comparison;
    };

    return this.reorder(indexes.sort(compare));
  }
}

export function createDataSource<T extends Record<string, unknown> | string | number, M extends Metadata = {}>(
  input: DataSourceInput<T, M>,
  options?: Options<T, M>,
): DataSource<T, M> {
  return new DataSource(input, options);
}
