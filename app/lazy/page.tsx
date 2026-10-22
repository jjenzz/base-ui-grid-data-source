import { ConsumerLazyGrid } from '@/components/lazy-grid';
import { getProductsPage } from '@/lib/products-query';

export default function ClientDemo() {
  // Only enough to fill the viewport
  const firstPage = getProductsPage({
    start: 0,
    end: 20,
    search: '',
    searchColumns: ['name', 'category'],
    sort: { column: 'id', direction: 'asc' },
  });

  return (
    <div>
      <header>
        <h1>Server + client lazy grid</h1>
        <p>Start with server-prepared rows, then load a buffered range as you scroll, sort and filter.</p>
      </header>

      <ConsumerLazyGrid defaultRows={firstPage.items} totalRowCount={firstPage.total} />
    </div>
  );
}
