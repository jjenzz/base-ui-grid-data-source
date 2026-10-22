import { GridBody } from '@/components/client-grid';
import { createDataSource } from '@/lib/data-source';
import { products, columns } from '@/lib/products';
import * as Grid from '@/components/grid';

export default function ClientDemo() {
  const source = createDataSource(products, {
    metadata: (item) => ({
      total: item.price * item.quantity,
      searchText: item.name.includes('Coffee') ? item.name + ' Boop' : item.name,
    }),
  });

  return (
    <div>
      <header>
        <h1>Server + client source</h1>
        <p>All products are supplied by the server. Search and sort them locally on the client.</p>
      </header>

      <section className="panel">
        <Grid.Root rows={source} searchColumns={['searchText']} defaultSort={{ column: 'id', direction: 'asc' }}>
          <div className="toolbar">
            <label>
              Search products
              <Grid.SearchInput placeholder="Try furniture…" />
            </label>
          </div>

          <Grid.Viewport className="grid-scroll">
            <Grid.Table aria-label="Product inventory">
              <Grid.ColumnGroup>
                <Grid.Column name="select" width={44} pinned="start" />
                <Grid.Column name="id" width={80} />
                <Grid.Column name="price" width={80} />
                <Grid.Column name="quantity" width={80} />
              </Grid.ColumnGroup>

              <Grid.Header>
                <Grid.HeaderRow>
                  <Grid.HeaderCell name="select">
                    <Grid.SelectAll />
                  </Grid.HeaderCell>
                  {columns.map((column) => (
                    <Grid.HeaderCell key={column.name} name={column.name}>
                      {column.name === 'category' ? column.label : <Grid.SortButton>{column.label}</Grid.SortButton>}
                    </Grid.HeaderCell>
                  ))}
                </Grid.HeaderRow>
              </Grid.Header>

              {/* we have to abstract this because of the render prop child */}
              <GridBody rows={source} columns={columns} />
            </Grid.Table>
            <Grid.Empty className="empty">No matching products.</Grid.Empty>
          </Grid.Viewport>
        </Grid.Root>
        <footer>All {products.length} products loaded</footer>
      </section>
    </div>
  );
}
