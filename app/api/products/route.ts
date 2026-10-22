import {
  getProductsPage,
  isSelection,
  parseProductsQuery,
  queryProducts,
  translateSelection,
} from '@/lib/products-query';

const FIVE_MINS = 60 * 5;

export async function GET(request: Request) {
  const query = parseProductsQuery(new URL(request.url).searchParams);
  if (!query) return Response.json({ error: 'Invalid query.' }, { status: 400 });

  return Response.json(
    getProductsPage(query),
    // Let the browser reuse pages for a bit, so scrolling back to a range doesn't refetch it.
    { headers: { 'Cache-Control': `private, max-age=${FIVE_MINS}` } },
  );
}

/**
 * Same query as GET, plus a selection to carry over from the previous query:
 * `{ previousQuery: '<search params>', selected: { all, ranges: [[start, end], …] } }`.
 */
export async function POST(request: Request) {
  const query = parseProductsQuery(new URL(request.url).searchParams);
  const body = await request.json().catch(() => null);
  const prevQuery =
    typeof body?.previousQuery === 'string' ? parseProductsQuery(new URLSearchParams(body.previousQuery)) : null;

  if (!query || !prevQuery || !isSelection(body.selected)) {
    return Response.json({ error: 'Invalid selection translation request.' }, { status: 400 });
  }

  const matching = queryProducts(query);
  return Response.json({
    ...getProductsPage(query, matching),
    selected: translateSelection(body.selected, prevQuery, matching),
  });
}
