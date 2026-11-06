import type { Env } from './types.ts';

export type Status = 'draft' | 'coming_soon' | 'published' | 'archived';
export const statuses = { draft: 'Rascunho', coming_soon: 'Em breve', published: 'Publicado', archived: 'Arquivado' } as const;
export const skuPattern = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
export const imageIdPattern = /^[a-f0-9-]{36}$/;

export interface CatalogImage { src: string; alt: string; width: number; height: number }
export interface Details {
  summary: string;
  description: string;
  images: CatalogImage[];
  includes: string[];
  formats: string[];
  requirements: string[];
  license: { type: string; summary: string };
  featured: boolean;
}
export interface ProductRow {
  sku: string; slug: string; name: string; category: string; price_cents: number;
  version: string; status: Status; details: string; updated_at: string; revision: number;
}
export type CatalogProduct = ReturnType<typeof toProduct>;
export type StoreDB = NonNullable<Env['DB']>;
export interface Settings {
  announcement: string; support_url: string; period: number;
  legal_name: string; legal_id: string; legal_address: string; legal_email: string; legal_phone: string;
}

export function toProduct(row: ProductRow) {
  const details = JSON.parse(row.details) as Details;
  return {
    id: row.sku,
    data: { ...details, sku: row.sku, slug: row.slug, name: row.name, category: row.category,
      priceCents: row.price_cents, currency: 'BRL' as const, version: row.version, status: row.status, updatedAt: row.updated_at },
  };
}

export async function publicProducts(db: StoreDB, slug?: string) {
  const { results } = await db.prepare(`
    SELECT * FROM products WHERE status IN ('published','coming_soon')
    ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END, name COLLATE NOCASE
  `).bind(slug ?? '').all<ProductRow>();
  return results.map(toProduct);
}

export async function catalogOffer(db: StoreDB, sku: string) {
  return db.prepare(`
    SELECT p.sku, p.name, p.price_cents AS priceCents, 'BRL' AS currency, p.version,
           f.object_key, f.filename
    FROM products p JOIN fulfillment f ON f.sku=p.sku AND f.version=p.version AND f.enabled=1
    WHERE p.sku=? AND p.status='published' AND p.price_cents>0 AND p.slug NOT LIKE 'demo-%'
  `).bind(sku).first<{ sku: string; name: string; priceCents: number; currency: 'BRL'; version: string; object_key: string; filename: string }>();
}

export function getSettings(db: StoreDB) {
  return db.prepare('SELECT announcement, support_url, period, legal_name, legal_id, legal_address, legal_email, legal_phone FROM store_settings WHERE id=1').first<Settings>();
}
