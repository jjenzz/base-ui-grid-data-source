'use client';

import * as React from 'react';
import { type Product, type Columns } from '@/lib/products';
import { currency } from '@/lib/currency';
import { createDataSource, type DataSourceInput, type Metadata } from '@/lib/data-source';
import * as Grid from './grid';

export function GridBody<M extends Metadata>({
  rows,
  columns,
}: {
  rows: DataSourceInput<Product, M>;
  columns: Columns;
}) {
  // The same rows given to `Grid.Root`, so the grid's indexes point into them however it sorts or filters.
  const source = React.useMemo(() => createDataSource(rows), [rows]);
  return (
    <Grid.Body>
      {(index) => {
        const row = source.at(index)!;
        return (
          <Grid.Row>
            <Grid.Cell column="select">
              <Grid.Checkbox aria-label={`Select ${row.name}`} />
            </Grid.Cell>

            {columns.map((column) => (
              <Grid.Cell key={column.name} column={column.name}>
                {/* `source.get` also reads computed metadata, like `total`, which isn't a field of the product. */}
                {column.name === 'price' || column.name === 'total'
                  ? currency(source.get(row, column.name))
                  : String(source.get(row, column.name))}
              </Grid.Cell>
            ))}
          </Grid.Row>
        );
      }}
    </Grid.Body>
  );
}
