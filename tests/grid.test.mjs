import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
async function compile(file) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}
const modules = new Map();
async function moduleUrl(file) {
  if (modules.has(file)) return modules.get(file);
  let code = await compile(file);
  for (const name of ['react', 'spin-delay']) {
    code = code.replace(`'${name}'`, JSON.stringify(pathToFileURL(require.resolve(name)).href));
  }
  for (const match of code.matchAll(/from '(@\/[^']+)'/g)) {
    const dependency = `../${match[1].slice(2)}.ts`;
    code = code.replace(`'${match[1]}'`, JSON.stringify(await moduleUrl(dependency)));
  }
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(file, url);
  return url;
}
const Grid = await import(await moduleUrl('../components/grid.tsx'));
const rows = [
  { id: 2, name: 'Second', category: 'Furniture', price: 20, quantity: 1 },
  { id: 1, name: 'First', category: 'Furniture', price: 10, quantity: 1 },
];
// The render function gets each row's index in the rows given, so look it up there, like a consumer would.
const rowAt = (given, index) => (Array.isArray(given) ? given[index] : given.at(index));
function render(props) {
  const given = props.rows ?? props.defaultRows;
  const body = React.createElement(Grid.Body, null, (index) => {
    const item = rowAt(given, index);
    return React.createElement(
      Grid.Row,
      { name: item.id },
      React.createElement(
        Grid.Cell,
        { name: 'select' },
        React.createElement(Grid.Checkbox, { 'aria-label': `Select ${item.name}` }),
      ),
    );
  });
  const state = React.createElement(Grid.State, null, ({ rowCount, mountedCount }) =>
    React.createElement('p', null, `${rowCount} rows in this view · ${mountedCount} row elements mounted`),
  );
  return renderToStaticMarkup(
    React.createElement(Grid.Root, props, React.createElement(Grid.Table, null, body), state),
  );
}

test('controlled search and sort preserve caller processing', () => {
  const html = render({
    rows,
    sort: { column: 'id', direction: 'asc' },
    search: 'no match',
    searchColumns: ['name'],
  });
  assert.ok(html.indexOf('Select Second') < html.indexOf('Select First'));
  assert.match(html, /2 rows in this view/);
});

test('loaded rows, and rows outside virtualised ones, are not marked as loading', () => {
  const h = React.createElement;
  const virtual = h(Grid.Body, null, (index) =>
    h(Grid.Row, null, h(Grid.Cell, { name: 'name' }, index === undefined ? null : rows[index].name)),
  );
  const ordinary = h(Grid.Body, null, h(Grid.Row, null, h(Grid.Cell, { name: 'name' }, 'Totals')));
  for (const body of [virtual, ordinary]) {
    const html = renderToStaticMarkup(h(Grid.Root, { rows }, h(Grid.Table, null, body)));
    assert.doesNotMatch(html, /data-placeholder|aria-busy="true"|Loading row/);
    assert.match(html, /role="gridcell"/);
  }
});

test('default rows use internal sorting', () => {
  const html = render({ defaultRows: rows });
  assert.ok(html.indexOf('Select First') < html.indexOf('Select Second'));
});

test('rows take precedence over defaultRows, including an empty controlled array', () => {
  assert.match(render({ rows: [], defaultRows: rows }), /0 rows in this view/);
});

test('consumers compose their own columns, markup and cell content', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Grid.Root,
      { rows },
      React.createElement(
        Grid.Table,
        { 'aria-label': 'Custom view', className: 'custom-table' },
        React.createElement(
          Grid.Header,
          null,
          React.createElement(Grid.HeaderRow, null, React.createElement(Grid.HeaderCell, { name: 'name' }, 'My label')),
        ),
        React.createElement(Grid.Body, null, (index) =>
          React.createElement(
            Grid.Row,
            null,
            React.createElement(Grid.Cell, { name: 'name' }, React.createElement('strong', null, rows[index].name)),
          ),
        ),
      ),
    ),
  );
  assert.match(html, /class="custom-table"/);
  assert.match(html, /My label/);
  assert.match(html, /<strong>Second<\/strong>/);
  assert.doesNotMatch(html, /Inventory value|Select|£/);
});

test('parts report missing root context', () => {
  assert.throws(
    () => renderToStaticMarkup(React.createElement(Grid.VirtualRows, null, () => null)),
    /inside Grid.Root/,
  );
});

test('before the viewport is measured, the rows given render, with a spacer for the rest of the total', () => {
  const items = Array.from({ length: 15 }, (_, id) => ({ ...rows[0], id, name: `Product ${id}` }));
  const html = render({ rows: items, virtualRowCount: 100, rowHeight: 44 });
  assert.match(html, /100 rows in this view/);
  assert.match(html, /15 row elements mounted/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 15);
  assert.match(html, /height:3740px/);
});

test('body reserves the full row count including unloaded rows without consumer spacers', async () => {
  const { createDataSource } = await import(await moduleUrl('../lib/data-source.ts'));
  const html = render({ rows: createDataSource(rows), virtualRowCount: 240, rowHeight: 44 });
  assert.match(html, /240 rows in this view/);
  assert.doesNotMatch(html, /data-placeholder/);
  assert.match(html, /height:10472px/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
});

test('ordinary body children are rendered without virtualization spacers', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Grid.Root,
      { rows },
      React.createElement(
        Grid.Table,
        null,
        React.createElement(
          Grid.Body,
          null,
          rows.map((item) =>
            React.createElement(
              Grid.Row,
              { key: item.id, name: item.id },
              React.createElement(Grid.Cell, { name: 'name' }, item.name),
            ),
          ),
        ),
      ),
    ),
  );
  assert.doesNotMatch(html, /aria-hidden|data-placeholder/);
  assert.match(html, /Second/);
});

test('controlled rows allow sorting requests when the consumer handles them', () => {
  function header(props) {
    return renderToStaticMarkup(
      React.createElement(
        Grid.Root,
        { rows, ...props },
        React.createElement(
          Grid.Table,
          null,
          React.createElement(
            Grid.Header,
            null,
            React.createElement(
              Grid.HeaderRow,
              null,
              React.createElement(
                Grid.HeaderCell,
                { name: 'name' },
                React.createElement(Grid.SortButton, null, 'Product'),
              ),
            ),
          ),
        ),
      ),
    );
  }
  assert.doesNotMatch(header({}), /disabled=""/);
  assert.match(header({ sort: { column: 'id', direction: 'asc' } }), /disabled=""/);
  assert.doesNotMatch(header({ onSortChange: () => {} }), /disabled=""/);
});

test('controlled rows can use internal sorting without mutating caller rows', () => {
  const html = render({ rows });
  assert.ok(html.indexOf('Select First') < html.indexOf('Select Second'));
  assert.deepEqual(
    rows.map((item) => item.id),
    [2, 1],
  );
});

test('defaultSearch filters locally even with controlled rows', () => {
  const html = render({ rows, defaultSearch: 'Second', searchColumns: ['name'] });
  assert.match(html, /1 rows in this view/);
  assert.match(html, /Select Second/);
  assert.doesNotMatch(html, /Select First/);
});

test('controlled search leaves filtering to the consumer and takes precedence over defaultSearch', () => {
  const html = render({ rows, search: 'unmatched', defaultSearch: 'Second' });
  assert.match(html, /2 rows in this view/);
});

test('SearchInput displays the controlled or initial search value', () => {
  function input(props) {
    return renderToStaticMarkup(
      React.createElement(
        Grid.Root,
        { rows, ...props },
        React.createElement(Grid.SearchInput, { 'aria-label': 'Search products' }),
      ),
    );
  }
  assert.match(input({ defaultSearch: 'Second' }), /value="Second"/);
  assert.match(input({ search: 'First', defaultSearch: 'Second' }), /value="First"/);
});

test('rows given at an offset render at their global positions, after a spacer', async () => {
  const { createDataSource } = await import(await moduleUrl('../lib/data-source.ts'));
  const html = render({
    rows: createDataSource(rows),
    offset: 10,
    virtualRowCount: 1000,
    rowHeight: 44,
    sort: { column: 'id', direction: 'asc' },
    search: '',
  });
  assert.doesNotMatch(html, /aria-label="Loading row"/);
  assert.match(html, /height:440px/);
  assert.match(html, /Select Second/);
  assert.match(html, /Select First/);
  assert.match(html, /1000 rows in this view · 2 row elements mounted/);
});

test('before the viewport is measured, every row given renders, without requiring remote loading', () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ ...rows[0], id }));
  const html = render({ rows: items });
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 100);
  assert.doesNotMatch(html, /data-placeholder/);
});

function selectionMarkup(selected) {
  return renderToStaticMarkup(
    React.createElement(
      Grid.Root,
      { rows, virtualRowCount: 240, selected },
      React.createElement(Grid.SelectAll),
      React.createElement(Grid.Body, null, (index) =>
        React.createElement(
          Grid.Row,
          { name: rows[index].id },
          React.createElement(Grid.Checkbox, { 'aria-label': `Row ${rows[index].id}` }),
        ),
      ),
      React.createElement(Grid.State, null, (state) =>
        React.createElement('span', null, `${state.selectedCount} selected`),
      ),
    ),
  );
}
test('selected empty array is controlled even with a nonempty default', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Grid.Root,
      { rows, selected: { all: false, ranges: [] }, defaultSelected: { all: false, ranges: [[0, 2]] } },
      React.createElement(Grid.SelectAll),
    ),
  );
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /checked=""/);
});
test('select all represents unloaded positions and counts them exactly', () => {
  const html = selectionMarkup({ all: true, ranges: [] });
  assert.match(html, /240 selected/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-label="Row 1"[^>]*checked/);
});
test('a deselected hole renders mixed state and leaves its row unchecked', () => {
  const html = selectionMarkup({ all: true, ranges: [[0, 1]] });
  assert.match(html, /239 selected/);
  assert.match(html, /aria-checked="mixed"/);
  assert.doesNotMatch(html, /aria-label="Row 1"[^>]*checked/);
  assert.match(html, /aria-label="Row 2"[^>]*checked/);
});

function columnGroupMarkup(cols, rootProps = { rows }) {
  const h = React.createElement;
  return renderToStaticMarkup(
    h(
      Grid.Root,
      rootProps,
      h(
        Grid.Table,
        null,
        h(Grid.ColumnGroup, null, ...cols),
        h(
          Grid.Header,
          null,
          h(Grid.HeaderRow, null, h(Grid.HeaderCell, { name: 'select' }), h(Grid.HeaderCell, { name: 'name' })),
        ),
        h(Grid.Body, null, () => h(Grid.Row, null, h(Grid.Cell, { name: 'select' }), h(Grid.Cell, { name: 'name' }))),
      ),
    ),
  );
}

test('columns with a width are fixed, columns without one share the remaining space', () => {
  const h = React.createElement;
  const html = columnGroupMarkup([
    h(Grid.Column, { key: 'select', name: 'select', width: 44, pinned: 'start' }),
    h(Grid.Column, { key: 'id', name: 'id', width: 80, pinned: 'start' }),
    h(Grid.Column, { key: 'name', name: 'name' }),
  ]);
  const grid = html.match(/data-grid="([^"]+)"/)[1];
  assert.ok(html.includes(`<style>:where([data-grid="${grid}"]) { --grid-col-select: 0 0 44px; }`));
  assert.ok(
    html.includes(
      `:where([data-grid="${grid}"] [data-column="select"]) { position: sticky; left: var(--grid-pin-select, 0); z-index: 1; }`,
    ),
  );
  // each pinned column is offset by the ones pinned before it
  assert.ok(
    html.includes(
      `:where([data-grid="${grid}"]) { --grid-pin-select: 0px; --grid-pin-id: calc(var(--grid-pin-select) + 44px); }`,
    ),
  );
  // no width, so no variable: the cell falls back to filling the remaining space
  assert.doesNotMatch(html, /--grid-col-name:/);
  assert.match(html, /role="gridcell" data-column="select" style="flex:var\(--grid-col-select, 1 1 0\)/);
  assert.match(html, /role="gridcell" data-column="name" style="flex:var\(--grid-col-name, 1 1 0\)/);
});

test('virtualised columns render an initial window on the server, with a spacer for the rest', () => {
  const h = React.createElement;
  const keys = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const html = renderToStaticMarkup(
    h(
      Grid.Root,
      { rows, virtualColumnCount: keys.length, defaultColumnWidth: 100 },
      h(
        Grid.Table,
        null,
        h(
          Grid.Header,
          null,
          h(
            Grid.HeaderRow,
            null,
            h(Grid.VirtualHeaderCells, null, (i) => h(Grid.HeaderCell, { name: keys[i] }, keys[i])),
          ),
        ),
        h(Grid.Body, null, () =>
          h(
            Grid.Row,
            null,
            h(Grid.VirtualCells, null, (i) => h(Grid.Cell, { name: keys[i] })),
          ),
        ),
      ),
    ),
  );
  // enough 100px columns to fill 1920px: 20 header cells, plus 20 cells in each of the 2 rows
  assert.equal((html.match(/data-column="c\d+"/g) ?? []).length, 60);
  assert.match(html, /data-column="c19"/);
  assert.doesNotMatch(html, /data-column="c20"/);
  // the 20 columns not rendered are one 2000px spacer, and each cell falls back to the default width
  assert.match(html, /aria-hidden="true" style="flex:0 0 2000px"/);
  assert.match(html, /flex:var\(--grid-col-c0, 0 0 100px\)/);
});

test('rows given a function render only virtualised cells, like VirtualHeaderCells and VirtualCells', () => {
  const h = React.createElement;
  const keys = Array.from({ length: 40 }, (_, i) => `c${i}`);
  const grid = (header, cells) =>
    renderToStaticMarkup(
      h(
        Grid.Root,
        { rows, virtualColumnCount: keys.length, defaultColumnWidth: 100 },
        h(
          Grid.Table,
          null,
          h(Grid.Header, null, h(Grid.HeaderRow, null, header)),
          h(Grid.Body, null, () => h(Grid.Row, null, cells)),
        ),
      ),
    ).replace(/data-grid="[^"]+"/g, '');
  const headerCell = (i) => h(Grid.HeaderCell, { name: keys[i] }, keys[i]);
  const cell = (i) => h(Grid.Cell, { name: keys[i] });
  const shorthand = grid(headerCell, cell);
  assert.equal(shorthand, grid(h(Grid.VirtualHeaderCells, null, headerCell), h(Grid.VirtualCells, null, cell)));
  assert.equal((shorthand.match(/data-column="c\d+"/g) ?? []).length, 60);
});

test('fixed rows render around VirtualRows, and a function body is the same as VirtualRows', () => {
  const h = React.createElement;
  const grid = (body) =>
    renderToStaticMarkup(
      h(Grid.Root, { rows, virtualRowCount: 100, rowHeight: 44 }, h(Grid.Table, null, h(Grid.Body, null, ...body))),
    ).replace(/data-grid="[^"]+"/g, '');
  const row = () => h(Grid.Row, null, h(Grid.Cell, { name: 'name' }));
  const totals = h(Grid.Row, { key: 'totals', 'aria-label': 'Totals' }, h(Grid.Cell, { name: 'name' }, 'Total'));
  const html = grid([totals, h(Grid.VirtualRows, { key: 'rows' }, row)]);
  assert.match(html, /aria-label="Totals"/);
  assert.equal((html.match(/role="row"/g) ?? []).length, 3);
  // rows are only numbered once they're counted on the client, so the server's HTML has no indexes or row count
  assert.doesNotMatch(html, /aria-rowindex|aria-rowcount/);
  assert.equal(grid([row]), grid([h(Grid.VirtualRows, null, row)]));
});

test('the render function gets each row’s index in the rows given, however the grid sorts or filters them', () => {
  const h = React.createElement;
  const items = [
    { id: 3, name: 'Oak chair', price: 30 },
    { id: 1, name: 'Desk lamp', price: 10 },
    { id: 2, name: 'Oak table', price: 20 },
  ];
  const indexes = (props) => {
    const seen = [];
    renderToStaticMarkup(
      h(
        Grid.Root,
        { rows: items, ...props },
        h(Grid.Body, null, (index) => {
          seen.push(index);
          return h(Grid.Row, null, h(Grid.Cell, { name: 'name' }));
        }),
      ),
    );
    return seen;
  };
  // sorted by id by default: ids 1, 2, 3 are at indexes 1, 2, 0
  assert.deepEqual(indexes({}), [1, 2, 0]);
  assert.deepEqual(indexes({ defaultSort: { column: 'price', direction: 'desc' } }), [0, 2, 1]);
  assert.deepEqual(indexes({ defaultSearch: 'oak', searchColumns: ['name'] }), [2, 0]);
  // controlled sort and search leave the rows as given
  assert.deepEqual(indexes({ sort: { column: 'id', direction: 'asc' }, search: '' }), [0, 1, 2]);
});

test('rows given at an offset still get their index in the rows given, not their global position', () => {
  const seen = [];
  renderToStaticMarkup(
    React.createElement(
      Grid.Root,
      { rows, offset: 10, virtualRowCount: 1000, sort: { column: 'id', direction: 'asc' }, search: '' },
      React.createElement(Grid.Body, null, (index) => {
        seen.push(index);
        return React.createElement(Grid.Row, null);
      }),
    ),
  );
  assert.deepEqual(seen, [0, 1]);
});

test('virtualised cells carry no index attribute: header cells are measured through their refs', () => {
  const h = React.createElement;
  const html = renderToStaticMarkup(
    h(
      Grid.Root,
      { rows, virtualColumnCount: 5 },
      h(
        Grid.Table,
        null,
        h(
          Grid.Header,
          null,
          h(Grid.HeaderRow, null, (i) => h(Grid.HeaderCell, { name: `c${i}` })),
        ),
        h(Grid.Body, null, () => h(Grid.Row, null, (i) => h(Grid.Cell, { name: `c${i}` }))),
      ),
    ),
  );
  assert.equal((html.match(/data-column="c\d+"/g) ?? []).length, 15);
  assert.doesNotMatch(html, /data-column-index/);
});

test('VirtualHeaderCells needs a HeaderRow to measure its cells', () => {
  const h = React.createElement;
  assert.throws(
    () =>
      renderToStaticMarkup(
        h(
          Grid.Root,
          { rows, virtualColumnCount: 5 },
          h(Grid.VirtualHeaderCells, null, (i) => h(Grid.HeaderCell, { name: `c${i}` })),
        ),
      ),
    /inside Grid.HeaderRow/,
  );
});

test('HeaderCell needs a HeaderRow, so the grid can count it among the columns', () => {
  const h = React.createElement;
  assert.throws(
    () => renderToStaticMarkup(h(Grid.Root, { rows }, h(Grid.HeaderCell, { name: 'name' }))),
    /Grid.HeaderCell must be inside Grid.HeaderRow/,
  );
});

test('rows are keyed by their id from metadata when they have no id field of their own', async () => {
  const { createDataSource } = await import(await moduleUrl('../lib/data-source.ts'));
  const items = [
    { sku: 'chair', name: 'Oak chair' },
    { sku: 'lamp', name: 'Desk lamp' },
  ];
  const keyWarnings = (source) => {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      renderToStaticMarkup(
        React.createElement(
          Grid.Root,
          { rows: source },
          React.createElement(Grid.Body, null, (index) => React.createElement(Grid.Row, null, items[index].name)),
        ),
      );
    } finally {
      console.error = original;
    }
    return errors.filter((message) => /unique "key"/.test(message)).length;
  };
  assert.equal(keyWarnings(createDataSource(items, { metadata: (row) => ({ id: row.sku }) })), 0);
  // without one, React can't tell the rows apart
  assert.equal(keyWarnings(createDataSource(items)), 1);
});
