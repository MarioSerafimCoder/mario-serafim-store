// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://loja.marioserafim.com.br',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      filter: (url) => !['/404', '/termos', '/privacidade', '/compras', '/carrinho'].includes(
        new URL(url).pathname.replace(/\/$/, ''),
      ),
    }),
  ],
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'Instrument Sans',
      cssVariable: '--font-instrument-sans',
      options: {
        variants: [
          {
            src: [
              '@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2',
            ],
            weight: '400 700',
            style: 'normal',
          },
        ],
      },
    },
  ],
  devToolbar: { enabled: false },
  vite: { cacheDir: '.astro/vite', plugins: [tailwindcss()] },
});
