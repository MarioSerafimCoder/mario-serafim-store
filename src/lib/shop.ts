import { getCollection, render, type CollectionEntry } from 'astro:content';

export type Product = CollectionEntry<'products'>;

const byName = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

export async function getPublicProducts(): Promise<Product[]> {
  const products = await getCollection('products');
  const skus = new Set<string>();
  const slugs = new Set<string>();

  for (const { id, body, data: { sku, slug } } of products) {
    if (!body?.trim()) throw new Error(`${id}: descrição Markdown obrigatória`);
    if (skus.has(sku)) throw new Error(`${id}: SKU duplicado: ${sku}`);
    if (slugs.has(slug)) throw new Error(`${id}: slug duplicado: ${slug}`);
    skus.add(sku);
    slugs.add(slug);
  }

  return products
    .filter(({ data }) => data.status !== 'draft')
    .sort((a, b) => byName.compare(a.data.name, b.data.name) || a.data.slug.localeCompare(b.data.slug));
}

export const productUrl = ({ data }: Product) => `/produtos/${data.slug}/`;

export const renderProductDescription = (product: Product) => render(product);
