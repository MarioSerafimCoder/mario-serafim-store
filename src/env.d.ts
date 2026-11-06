/// <reference types="@astrojs/cloudflare/types.d.ts" />

declare namespace App {
  interface Locals {
    storeDB?: import('../worker/catalog').StoreDB;
    adminPreview?: boolean;
  }
}

declare module 'cloudflare:workers' {
  export const env: unknown;
}
