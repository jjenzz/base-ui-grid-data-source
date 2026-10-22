import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
}
const dataUrl = async (path) => `data:text/javascript;base64,${Buffer.from(await compile(path)).toString('base64')}`;
// 'server-only' is a marker Next resolves itself, so it's replaced with an empty module here.
const serverOnlyUrl = `data:text/javascript;base64,${Buffer.from('').toString('base64')}`;
const queryCode = (await compile('../lib/products-query.ts'))
  .replace("'server-only'", JSON.stringify(serverOnlyUrl))
  .replace("'@/lib/products'", JSON.stringify(await dataUrl('../lib/products.ts')))
  .replace("'@/lib/data-source'", JSON.stringify(await dataUrl('../lib/data-source.ts')));
const routeCode = (await compile('../app/api/products/route.ts')).replace(
  "'@/lib/products-query'",
  JSON.stringify(`data:text/javascript;base64,${Buffer.from(queryCode).toString('base64')}`),
);
const { GET, POST } = await import(`data:text/javascript;base64,${Buffer.from(routeCode).toString('base64')}`);

test('paging uses deterministic ordering for ties', async () => {
  const url = 'http://localhost/api/products?start=0&end=100&sort=quantity';
  const result = await (await GET(new Request(url))).json();
  for (let i = 1; i < result.items.length; i++) {
    const a = result.items[i - 1],
      b = result.items[i];
    assert.ok(a.quantity < b.quantity || (a.quantity === b.quantity && a.id < b.id));
  }
});
test('invalid ranges return an error', async () => {
  assert.equal((await GET(new Request('http://localhost/api/products?start=-1&end=10'))).status, 400);
});

const initialQuery = 'search=&sort=id&direction=asc&searchField=name&searchField=category';
function translate(nextQuery, selected, previousQuery = initialQuery) {
  return POST(
    new Request(`http://localhost/api/products?${nextQuery}&start=0&end=240`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previousQuery, selected }),
    }),
  );
}
// The product ids at the given positions of a query's results, fetched with GET so it works for any dataset size.
async function idsAt(query, ranges) {
  const pages = await Promise.all(
    ranges.map(async ([start, end]) =>
      (await GET(new Request(`http://localhost/api/products?${query}&start=${start}&end=${end}`))).json(),
    ),
  );
  return pages.flatMap((page) => page.items.map((row) => row.id));
}
const byPriceDesc = 'search=&sort=price&direction=desc&searchField=name&searchField=category';
const furniture = 'search=furniture&sort=id&direction=asc&searchField=name&searchField=category';

const byWeek3Desc = 'search=&sort=week-2&direction=desc&searchField=name&searchField=category';

test('a week column sorts by that week of sales, with ties in id order', async () => {
  const result = await (await GET(new Request(`http://localhost/api/products?${byWeek3Desc}&start=0&end=200`))).json();
  for (let i = 1; i < result.items.length; i++) {
    const a = result.items[i - 1],
      b = result.items[i];
    assert.ok(a.sales[2] > b.sales[2] || (a.sales[2] === b.sales[2] && a.id < b.id));
  }
});

test('week columns past the last week are rejected', async () => {
  const response = await GET(new Request('http://localhost/api/products?sort=week-52&start=0&end=10'));
  assert.equal(response.status, 400);
});

test('a selection is translated to and from a week sort', async () => {
  const toWeek = await (await translate(byWeek3Desc, { all: false, ranges: [[0, 5]] })).json();
  assert.deepEqual(
    (await idsAt(byWeek3Desc, toWeek.selected.ranges)).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  const back = await (await translate(initialQuery, toWeek.selected, byWeek3Desc)).json();
  assert.deepEqual(back.selected.ranges, [[0, 5]]);
});

test('sort translation preserves selected record IDs and merges positions', async () => {
  const result = await (
    await translate('search=&sort=price&direction=desc&searchField=name&searchField=category', {
      all: false,
      ranges: [
        [10, 20],
        [80, 90],
      ],
    })
  ).json();
  const selectedIds = (await idsAt(byPriceDesc, result.selected.ranges)).sort((a, b) => a - b);
  assert.deepEqual(selectedIds, [
    ...Array.from({ length: 10 }, (_, i) => i + 11),
    ...Array.from({ length: 10 }, (_, i) => i + 81),
  ]);
});
test('filter translation retains only selected rows still matching', async () => {
  const result = await (
    await translate('search=furniture&sort=id&direction=asc&searchField=name&searchField=category', {
      all: false,
      ranges: [[0, 6]],
    })
  ).json();
  assert.deepEqual(await idsAt(furniture, result.selected.ranges), [2, 6]);
});
test('translation validates queries and ranges', async () => {
  assert.equal((await translate(initialQuery, { all: false, ranges: [[-1, 20]] })).status, 400);
  assert.equal((await translate('sort=bad&direction=asc', { all: false, ranges: [] })).status, 400);
  assert.equal((await translate(initialQuery, { all: false, ranges: [] }, 'sort=bad')).status, 400);
});
test('POST without a previous query is rejected', async () => {
  const response = await POST(
    new Request(`http://localhost/api/products?${initialQuery}`, { method: 'POST', body: JSON.stringify({}) }),
  );
  assert.equal(response.status, 400);
});
test('select all stays all across a sort, and only its exceptions are translated', async () => {
  const result = await (
    await translate('search=&sort=price&direction=desc&searchField=name&searchField=category', {
      all: true,
      ranges: [[0, 1]],
    })
  ).json();
  assert.equal(result.selected.all, true);
  assert.deepEqual(await idsAt(byPriceDesc, result.selected.ranges), [1]);
});
test('a selection without all is rejected', async () => {
  assert.equal((await translate(initialQuery, [[0, 1]])).status, 400);
});
test('selections without positions come back unchanged', async () => {
  const sorted = 'search=&sort=price&direction=desc&searchField=name&searchField=category';
  for (const selected of [
    { all: true, ranges: [] },
    { all: false, ranges: [] },
  ]) {
    const result = await (await translate(sorted, selected)).json();
    assert.deepEqual(result.selected, selected);
  }
});
