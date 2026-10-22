export type Product = {
  id: number;
  name: string;
  category: string;
  price: number;
  quantity: number;
};

const names = ['Desk lamp', 'Oak chair', 'Wool rug', 'Notebook', 'Coffee cup', 'Standing desk'];
const categories = ['Lighting', 'Furniture', 'Textiles', 'Stationery', 'Kitchen', 'Furniture'];
/** Each category once, for picking one. */
export const productCategories = [...new Set(categories)];

/** How many weeks of sales each product has: wide enough to need column virtualisation. */
export const weeks = 52;

/** A product with its computed inventory value and weekly sales, as the API returns it. */
export type ProductRow = Product & { total: number; sales: number[] };

export const products: Product[] = Array.from({ length: 5000 }, (_, index) => ({
  id: index + 1,
  name: `${names[index % names.length]} ${Math.floor(index / names.length) + 1}`,
  category: categories[index % categories.length],
  price: 12 + ((index * 17) % 380),
  quantity: 1 + ((index * 7) % 50),
}));

// How many products the lazy grid requests and holds in memory at once.
export const itemsPerPage = 200;

export type Columns = typeof columns;
export const columns = [
  { name: 'id', label: 'ID' },
  { name: 'name', label: 'Product' },
  { name: 'category', label: 'Category' },
  { name: 'price', label: 'Price' },
  { name: 'quantity', label: 'Stock' },
  { name: 'total', label: 'Inventory value' },
] as const;
