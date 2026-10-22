import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const text = await readFile(new URL('../lib/data-source.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { createDataSource, DataSource } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const rows = [
  { id: 1, name: 'Lamp', price: 10, quantity: 3 },
  { id: 2, name: 'Chair', price: 20, quantity: 2 },
];
const options = {
  metadata: (item) => ({ total: item.price * item.quantity }),
};

test('wire entries recover accessors and derived column values without functions', () => {
  const original = createDataSource(rows, options);
  const wire = structuredClone(Array.from(original).map(({ $$typeof, ...entry }) => entry)).map((entry) => ({
    ...entry,
    $$typeof: Symbol.for('@base-ui/react/data-source-entry'),
  }));
  const hydrated = createDataSource(wire);
  assert.equal(hydrated.get(hydrated.at(1), 'total'), 40);
  assert.deepEqual(Array.from(hydrated), Array.from(hydrated));
});

test('filter and sort preserve metadata and never mutate the input', () => {
  const source = createDataSource(rows, options);
  const sorted = source.sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(sorted.at(0).id, 2);
  assert.equal(sorted.get(sorted.at(0), 'total'), 40);
  assert.equal(source.at(0).id, 1);
  assert.equal(source.filter((item) => item.quantity > 2).length, 1);
  const copy = createDataSource(source);
  assert.ok(copy instanceof DataSource);
  assert.notEqual(copy, source);
  assert.deepEqual(Array.from(copy), Array.from(source));
});

test('client selectors override stored metadata and methods process live sources', () => {
  const server = createDataSource(rows, options);
  const client = createDataSource(Array.from(server), { metadata: (item) => ({ total: item.price * 5 }) });
  assert.equal(client.get(client.at(0), 'total'), 50);
  const filtered = createDataSource(server)
    .filter((item) => item.id === 2)
    .sort((a, b) => b.id - a.id);
  assert.equal(filtered.length, 1);
  assert.equal(filtered.at(0).id, 2);
});

test('empty and primitive collections remain usable', () => {
  assert.equal(
    createDataSource([])
      .sort()
      .filter(() => true).length,
    0,
  );
  const source = createDataSource(['b', 'a']);
  assert.equal(source.sort((a, b) => a.localeCompare(b)).at(0), 'a');
});

test('factory and transformations return DataSource instances', () => {
  const source = createDataSource(rows, options);
  assert.ok(source instanceof DataSource);
  assert.ok(source.filter(() => true) instanceof DataSource);
  assert.ok(source.sort((a, b) => a.id - b.id) instanceof DataSource);
  assert.equal(new DataSource(rows, options).get(rows[0], 'total'), 30);
});

test('items normalizes raw rows, serialized entries and sources to original items', () => {
  const source = createDataSource(rows, options);
  assert.deepEqual(source.items, rows);
  const recovered = createDataSource(Array.from(source));
  assert.deepEqual(recovered.items, rows);
  assert.equal(recovered.get(recovered.items[0], 'total'), 30);
  assert.deepEqual(createDataSource(source).items, rows);
  assert.deepEqual(createDataSource([]).items, []);
});

test('items reflects filtering and sorting without mutating serialized input', () => {
  const entries = Array.from(createDataSource(rows, options));
  const source = createDataSource(entries).sort((a, b) => b.id - a.id);
  assert.deepEqual(
    source.items.map((item) => item.id),
    [2, 1],
  );
  assert.deepEqual(
    entries.map((entry) => entry.item.id),
    [1, 2],
  );
  assert.deepEqual(source.filter((item) => item.id === 1).items, [rows[0]]);
});

test('map receives original rows and indexes and returns an array of results', () => {
  const source = createDataSource(Array.from(createDataSource(rows, options)));
  assert.deepEqual(
    source.map((item, index, items) => {
      assert.equal(items, source.items);
      return `${index}: ${item.name}`;
    }),
    ['0: Lamp', '1: Chair'],
  );
  assert.deepEqual(source.items, rows);
  assert.equal(source.get(rows[0], 'total'), 30);
  assert.deepEqual(
    createDataSource([]).map(() => 'unused'),
    [],
  );
});

test('creating and rewrapping a source does not traverse rows or compute values', () => {
  let reads = 0;
  let selects = 0;
  const input = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const source = createDataSource(input, {
    metadata: (item) => {
      selects++;
      return { total: item.price * item.quantity };
    },
  });
  assert.equal(reads, 1);
  assert.equal(selects, 0);
  assert.equal(source.items, input);
  source[Symbol.iterator] = () => {
    throw new Error('Must not iterate while wrapping');
  };
  const copy = createDataSource(source);
  assert.equal(reads, 1);
  assert.equal(copy.items, input);
  assert.equal(copy.get(copy.at(0), 'total'), 30);
  assert.equal(copy.get(copy.at(0), 'total'), 30);
  assert.equal(selects, 1);
});

test('serialized items are unwrapped only on access and materialized once', () => {
  let reads = 0;
  const entries = rows.map((item) => ({
    $$typeof: Symbol.for('@base-ui/react/data-source-entry'),
    get item() {
      reads++;
      return item;
    },
    metadata: { total: item.price * item.quantity },
  }));
  const source = createDataSource(entries);
  assert.equal(reads, 0);
  assert.equal(source.get(source.at(1), 'total'), 40);
  assert.ok(reads <= 2);
  const items = source.items;
  const previousReads = reads;
  assert.deepEqual(items, rows);
  assert.equal(source.items, items);
  assert.equal(reads, previousReads);
});

test('filter does not compute selected metadata for discarded rows', () => {
  const selected = [];
  const source = createDataSource(rows, {
    metadata: (item) => {
      selected.push(item.id);
      return { total: item.price * item.quantity };
    },
  });
  const view = source.filter((item) => item.id === 2, []);
  assert.deepEqual(selected, []);
  assert.equal(view.get(view.at(0), 'total'), 40);
  assert.deepEqual(selected, [2]);
});

test('source indexes are local to its items', () => {
  const source = createDataSource(rows, options);
  assert.equal(source.at(0), rows[0]);
  assert.equal(source.at(1), rows[1]);
  assert.equal(source.at(2), undefined);
  assert.equal(source.at(-1), rows[1]);
  assert.equal(Array.from(source)[0].metadata.total, 30);
});

test('built-in search and sort use raw fields and computed metadata', () => {
  const source = createDataSource(rows, options);
  assert.equal(source.filter('CHA', ['name']).at(0).id, 2);
  assert.equal(source.filter('40', ['total']).at(0).id, 2);
  assert.equal(source.filter('Chair', ['price']).length, 0);
  assert.equal(source.filter('Chair').length, 1);
  assert.equal(source.filter(''), source);
  assert.deepEqual(
    source.sort({ column: 'total', direction: 'desc' }).map((row) => row.id),
    [2, 1],
  );
  assert.deepEqual(
    source.sort({ column: 'name', direction: 'asc' }).map((row) => row.id),
    [2, 1],
  );
  assert.deepEqual(
    source.map((row) => row.id),
    [1, 2],
  );
});

test('originalIndex follows each row back through filtering and sorting', () => {
  const items = [
    { id: 1, name: 'Lamp', price: 30 },
    { id: 2, name: 'Chair', price: 10 },
    { id: 3, name: 'Lamp shade', price: 20 },
  ];
  const source = createDataSource(items);
  assert.equal(source.originalIndex(1), 1);
  assert.equal(source.originalIndex(3), undefined);
  assert.equal(source.originalIndex(-1), undefined);

  const view = source.filter('lamp', ['name']).sort({ column: 'price', direction: 'asc' });
  assert.deepEqual(
    view.items.map((item) => item.id),
    [3, 1],
  );
  assert.deepEqual([view.originalIndex(0), view.originalIndex(1)], [2, 0]);
  for (let index = 0; index < view.length; index++) assert.equal(items[view.originalIndex(index)], view.at(index));

  const byComparator = source.sort((a, b) => b.id - a.id);
  assert.deepEqual(
    [0, 1, 2].map((index) => byComparator.originalIndex(index)),
    [2, 1, 0],
  );
});

test('a source created from another counts from that source’s rows', () => {
  const sorted = createDataSource(rows).sort({ column: 'price', direction: 'desc' });
  assert.equal(sorted.originalIndex(0), 1);
  const rewrapped = createDataSource(sorted);
  assert.equal(rewrapped.originalIndex(0), 0);
  assert.equal(rewrapped.at(0), sorted.at(0));
});
