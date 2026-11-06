import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const astro = join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
const preview = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=',
  'base64',
);

test('rotas, validação e publicação do catálogo estático', async (t) => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'mario-store-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));

  for (const file of ['src', 'public', 'worker', 'package.json', 'package-lock.json', 'tsconfig.json', 'astro.config.mjs']) {
    await cp(join(root, file), join(project, file), { recursive: true });
  }

  const products = join(project, 'src', 'content', 'products');
  const assets = join(project, 'src', 'assets', 'products');
  await rm(products, { recursive: true });
  await mkdir(products);
  await mkdir(assets, { recursive: true });
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'junction');

  // The temporary project shares dependencies, but needs its own content cache.
  await writeFile(join(project, 'astro.test.config.mjs'), `
    import config from './astro.config.mjs';
    export default { ...config, cacheDir: './.astro/cache' };
  `);

  const dist = join(project, 'dist');
  const read = (file) => readFile(join(dist, file), 'utf8');
  const build = () => execFileSync(process.execPath, [astro, 'build', '--config', 'astro.test.config.mjs'], {
    cwd: project,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const assertBuildFails = (message) => {
    assert.throws(build, (error) => {
      assert.match(error.stdout + error.stderr, message);
      return true;
    });
  };

  async function writeProduct(file, overrides = {}, body = 'Descrição de fixture para teste.') {
    const asset = `fixture-${file}-preview.png`;
    const data = {
      sku: `TEST-${file.toUpperCase()}`,
      slug: `fixture-${file}`,
      name: `Fixture ${file}`,
      summary: 'Resumo de fixture para teste.',
      category: 'Categoria A',
      priceCents: 1299,
      currency: 'BRL',
      images: [{ src: `../../assets/products/${asset}`, alt: 'Prévia de teste' }],
      includes: ['Item de teste'],
      formats: ['TXT'],
      requirements: [],
      license: { type: 'Teste', summary: 'Licença fictícia.' },
      version: '1.0',
      updatedAt: '2026-11-01',
      featured: true,
      ...overrides,
    };

    await writeFile(join(assets, asset), preview);
    const fields = Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    await writeFile(join(products, `${file}.md`), `---\n${fields.join('\n')}\n---\n\n${body}\n`);
  }

  build();
  const pages = ['index.html', 'produtos/index.html', 'sobre/index.html', 'licencas/index.html',
    'termos/index.html', 'privacidade/index.html', 'contato/index.html', 'entrega-digital/index.html',
    'reembolsos/index.html', '404.html'];
  for (const page of pages) {
    const html = await read(page);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<script id="store-theme">/);
    const withoutTheme = html.replace(/<script id="store-theme">[\s\S]*?<\/script>/, '');
    assert.doesNotMatch(withoutTheme, /<script\b|<form\b|data-add-to-cart|isle.thorne|newsletter/i);
  }
  assert.match(await read('produtos/index.html'), /catálogo ainda está vazio/);
  for (const page of ['termos/index.html', 'privacidade/index.html', 'licencas/index.html', 'reembolsos/index.html', '404.html']) {
    assert.match(await read(page), /name="robots" content="noindex"/);
  }
  const contact = await read('contato/index.html');
  assert.match(contact, /https:\/\/marioserafim\.com\.br\/contato\//);
  assert.match(await read('entrega-digital/index.html'), /Como recebo meu produto\?/);
  assert.match(await read('entrega-digital/index.html'), /Posso usar o produto em projetos comerciais/);
  assert.match(await read('reembolsos/index.html'), /sete dias/);
  assert.match(await read('reembolsos/index.html'), /não condiciona esse direito ao fato de o arquivo ter sido baixado ou aberto/);
  assert.match(await read('avisos-legais.txt'), /Copyright \(c\) 2026 Codrops[\s\S]+SIL OPEN FONT LICENSE/);

  await writeProduct('private'); // Sem status: precisa ser draft por padrão.
  await writeProduct('alpha', { status: 'published', featured: false }, 'Descrição de fixture para teste.\n\n### Perguntas frequentes\n\nResposta de teste.');
  build();
  assert.doesNotMatch(await read('produtos/index.html'), /catalog-controls|catalog-order/);
  assert.match(await read('index.html'), /id="featured"[^>]*>Produtos digitais[\s\S]+fixture-alpha/);
  assert.deepEqual((await readdir(join(dist, 'produtos'))).sort(), ['fixture-alpha', 'index.html']);

  await writeProduct('beta', { status: 'coming_soon', category: 'Categoria B', updatedAt: '2026-11-02' });
  build();
  const catalog = await read('produtos/index.html');
  const alpha = await read('produtos/fixture-alpha/index.html');
  const beta = await read('produtos/fixture-beta/index.html');
  const sitemap = await read('sitemap-0.xml');
  assert.match(catalog, /id="catalog-category"/);
  assert.match(catalog, /id="catalog-order"/);
  assert.match(catalog, /fixture-alpha[\s\S]+fixture-beta/);
  assert.match(await read('index.html'), /Em destaque[\s\S]+fixture-alpha/);
  assert.match(alpha, /https:\/\/loja\.marioserafim\.com\.br\/produtos\/fixture-alpha\//);
  assert.match(alpha, /R\$\s*12,99/);
  assert.match(alpha, /Descrição de fixture para teste/);
  assert.match(alpha, /\.webp/);
  const betaProduct = beta.slice(beta.indexOf('<main'), beta.indexOf('</article>'));
  const betaPurchase = betaProduct.match(/<aside class="purchase-panel"[\s\S]*?<\/aside>/)?.[0];
  assert.match(betaPurchase, /Em breve/);
  assert.doesNotMatch(betaPurchase, /R\$|<button\b/);
  assert.doesNotMatch(betaProduct, /<form\b|data-add-to-cart|checkout|schema.org\/InStock/i);
  assert.match(alpha, /href="#perguntas-frequentes"/);
  assert.match(alpha, /id="perguntas-frequentes"/);
  assert.match(alpha, /Produtos relacionados[\s\S]+fixture-beta/);
  assert.doesNotMatch(beta, /Perguntas frequentes/);
  assert.match(alpha, /Compra indisponível nesta etapa/);
  assert.match(alpha, /href="\/licencas\/"[^>]*>Licença de uso/);
  assert.match(alpha, /href="\/entrega-digital\/"[^>]*>Entrega digital/);
  assert.match(alpha, /href="\/reembolsos\/"[^>]*>Cancelamentos e reembolsos/);
  assert.match(alpha, /href="\/contato\/"[^>]*>Contato e suporte/);
  assert.match(beta, /Este produto ainda não está disponível/);
  assert.match(sitemap, /fixture-alpha/);
  assert.match(sitemap, /fixture-beta/);
  assert.doesNotMatch(sitemap, /\/404|\/termos|\/privacidade/);
  assert.doesNotMatch(catalog + sitemap + await read('index.html'), /fixture-private/i);
  assert.deepEqual(
    (await readdir(join(dist, 'produtos'))).sort(),
    ['fixture-alpha', 'fixture-beta', 'index.html'],
  );
  assert.ok((await readdir(dist, { recursive: true })).every((file) => !file.includes('fixture-private')));

  await writeProduct('duplicate', { slug: 'fixture-alpha' });
  assertBuildFails(/slug duplicado/);
  await writeProduct('duplicate', { sku: 'TEST-ALPHA' });
  assertBuildFails(/SKU duplicado/);
  await writeProduct('duplicate', { priceCents: 12.99 });
  assertBuildFails(/priceCents/);
  await writeProduct('duplicate', { currency: 'USD' });
  assertBuildFails(/currency/);
  await writeProduct('duplicate', { slug: 'slug inválido' });
  assertBuildFails(/slug/);
  await writeProduct('duplicate', {}, '');
  assertBuildFails(/descrição Markdown obrigatória/);
});
