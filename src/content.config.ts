import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const text = z.string().trim().min(1);

// O nome do arquivo identifica a entrada. O slug público é validado à parte.
const products = defineCollection({
  loader: glob({
    pattern: '*.md',
    base: './src/content/products',
    generateId: ({ entry }) => entry,
  }),
  schema: ({ image }) =>
    z.object({
      sku: z.string().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      name: text,
      summary: text,
      category: text,
      priceCents: z.number().int().nonnegative(),
      currency: z.literal('BRL'),
      images: z.array(z.object({ src: image(), alt: text })).min(1),
      includes: z.array(text).min(1),
      formats: z.array(text).min(1),
      requirements: z.array(text),
      license: z.object({ type: text, summary: text }),
      version: text,
      updatedAt: z.iso.date(),
      featured: z.boolean().default(false),
      status: z.enum(['draft', 'coming_soon', 'published']).default('draft'),
    }).strict(),
});

export const collections = { products };
