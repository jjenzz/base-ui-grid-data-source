import { createDataSource } from '@/lib/data-source';
import * as Grid from '@/components/grid';
import { products, columns } from '@/lib/products';

const currency = (value: unknown) => `£${Number(value ?? 0).toLocaleString('en-GB')}`;

export default function ServerDemo() {
  const rows = createDataSource(products, {
    metadata: (item) => ({ total: item.price * item.quantity }),
  });

  return (
    <div>
      <header>
        <h1>Server source</h1>
        <p>A Server Component prepares rows and passes them directly to the Grid.</p>
      </header>
      <section className="panel">
        <Grid.Root>
          <Grid.Viewport className="grid-scroll">
            <Grid.Table aria-label="Product inventory">
              <Grid.ColumnGroup>
                <Grid.Column name="id" width={80} />
                <Grid.Column name="price" width={80} />
                <Grid.Column name="quantity" width={80} />
              </Grid.ColumnGroup>

              <Grid.Header>
                <Grid.HeaderRow>
                  {columns.map((column) => (
                    <Grid.HeaderCell key={column.name} name={column.name}>
                      {column.label}
                    </Grid.HeaderCell>
                  ))}
                </Grid.HeaderRow>
              </Grid.Header>

              <Grid.Body>
                {rows.map((item) => (
                  <Grid.Row key={item.id}>
                    {columns.map((column) => (
                      <Grid.Cell key={column.name} column={column.name}>
                        {column.name === 'price' || column.name === 'total' ? (
                          <>{currency(rows.get(item, column.name))}</>
                        ) : (
                          <>{String(rows.get(item, column.name) ?? '')}</>
                        )}
                      </Grid.Cell>
                    ))}
                  </Grid.Row>
                ))}
              </Grid.Body>
            </Grid.Table>
          </Grid.Viewport>
          <p className="grid-caption">{rows.length} server-rendered rows</p>
        </Grid.Root>
      </section>
    </div>
  );
}
