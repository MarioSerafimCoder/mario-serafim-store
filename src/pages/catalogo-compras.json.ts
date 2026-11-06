import type { APIRoute } from 'astro';
import { getPublicProducts } from '../lib/shop';

export const GET: APIRoute = async ({ locals }) => Response.json(
  (await getPublicProducts(locals.storeDB))
    .map(({ data }) => data)
    .filter(({ status, slug, sku, priceCents }) =>
      status === 'published' && !slug.startsWith('demo-') && !sku.startsWith('DEMO-') && priceCents > 0,
    )
    .map(({ sku, name, version, currency, priceCents }) => ({ sku, name, version, currency, priceCents })),
);
