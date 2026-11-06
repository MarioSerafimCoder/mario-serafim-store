import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import base from './astro.config.mjs';

export default defineConfig({
  ...base,
  output: 'server',
  session: false,
  adapter: cloudflare({ imageService: 'passthrough', prerenderEnvironment: 'node' }),
  integrations: [{
    name: 'store-catalog-runtime',
    hooks: {
      'astro:config:setup': ({ addMiddleware }) => {
        addMiddleware({ entrypoint: new URL('./src/store-runtime.ts', import.meta.url), order: 'pre' });
      },
    },
  }],
});
