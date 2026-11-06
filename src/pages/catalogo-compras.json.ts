import type { APIRoute } from 'astro';
import { getImage } from 'astro:assets';
import { getPublicProducts } from '../lib/shop';

export const GET: APIRoute = async ({ locals }) => Response.json(await Promise.all(
  (await getPublicProducts(locals.storeDB))
    .map(({ data }) => data)
    .filter(({ status, slug, sku, priceCents }) =>
      status === 'published' && !slug.startsWith('demo-') && !sku.startsWith('DEMO-') && priceCents > 0,
    )
    .map(async ({ sku, name, version, currency, priceCents, images }) => {
      const src = images[0]?.src;
      const image = typeof src === 'string' ? src : src
        ? (await getImage({ src, width: Math.min(src.width, 160), format: 'webp' })).src
        : undefined;
      return { sku, name, version, currency, priceCents, image };
    }),
));
