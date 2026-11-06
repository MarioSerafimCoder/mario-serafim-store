interface Statement {
  bind(...values: (string | number | null | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB?: { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ results: unknown[]; meta?: {changes:number} }[]> };
  FILES?: {
    head(key: string): Promise<unknown>;
    get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
    put?(key: string, value: ArrayBuffer): Promise<unknown>;
  };
  DYNAMIC_CATALOG?: string;
  RELEASE?: { id: string };
  ADMIN_ACCESS_ISSUER?: string;
  ADMIN_ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  STORE_ORIGIN?: string;
  CHECKOUT_ENABLED?: string;
  COUPONS_ENABLED?: string;
  MP_MODE?: 'test' | 'production';
  MP_SELLER_ID?: string;
  MP_ACCESS_TOKEN?: string;
  MP_WEBHOOK_SECRET?: string;
  STORE_SESSION_SECRET?: string;
}

export interface Product {
  sku: string;
  name: string;
  image?: string;
  priceCents: number;
  currency: 'BRL';
  version: string;
}

export interface Order {
  id: string;
  recovery_hash: string;
  sku: string;
  title: string;
  price_cents: number;
  coupon_code?: string | null;
  discount_cents?: number;
  currency: 'BRL';
  object_key: string;
  filename: string;
  mode: 'test' | 'production';
  seller: string;
  remote_id: string | null;
  checkout_url: string | null;
  payment_id: string | null;
  status: string;
  provider_updated: number;
  last_check: number;
  created_at: number;
  cart_id?: string | null;
}

export interface CheckoutCart {
  id: string;
  recovery_hash: string;
  total_cents: number;
  currency: 'BRL';
  mode: 'test' | 'production';
  seller: string;
  remote_id: string | null;
  checkout_url: string | null;
  payment_id: string | null;
  status: string;
  provider_updated: number;
  last_check: number;
  created_at: number;
}

export interface CartLine extends Order {
  cart_id: string;
  cart_position: number;
}
