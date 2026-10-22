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
  const source = React.useMemo(() => createDataSource(rows), [rows]);
  return (
    <Grid.Body>
      {(index) => {
        // Every row is given up front, so this only guards the type.
        if (index === undefined) return <Grid.Row />;
        const row = source.at(index)!;
        return (
          <Grid.Row>
            <Grid.Cell name="select">
              <Grid.Checkbox aria-label={`Select ${row.name}`} />
            </Grid.Cell>

            {columns.map((column) => (
              <Grid.Cell key={column.name} name={column.name}>
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
