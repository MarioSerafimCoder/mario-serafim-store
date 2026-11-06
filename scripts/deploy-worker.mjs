import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const target = process.argv[2];
const staging = target === 'homologacao';
if (!staging && target !== 'producao') throw new Error('Informe homologacao ou producao.');
const dryRun = process.argv[3] === '--dry-run';
if (process.argv.length > (dryRun ? 4 : 3)) throw new Error('Opção de deploy inválida.');
const env = { ...process.env };
delete env.CLOUDFLARE_ENV;

function run(args, environment = env) {
  const result = spawnSync(process.execPath, args, { env: environment, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['node_modules/astro/bin/astro.mjs', 'check']);
run(['--test', ...readdirSync('tests').filter(name => name.endsWith('.test.mjs')).map(name => 'tests/' + name)]);
run(['node_modules/astro/bin/astro.mjs', 'build', '--config', 'astro.runtime.config.mjs'],
  staging ? { ...env, CLOUDFLARE_ENV: 'homologacao' } : env);

const config = 'dist/server/wrangler.json';
const built = JSON.parse(readFileSync(config,'utf8'));
const productionRoute = built.routes?.length === 1 && built.routes[0].pattern === 'loja.marioserafim.com.br' &&
  built.routes[0].custom_domain === true;
const expected = staging
  ? { worker:'mario-serafim-store-homologacao', db:'mario-serafim-store-homologacao', mode:'test' }
  : { worker:'mario-serafim-store-demo-ed0faa', db:'mario-serafim-store-producao', mode:'production' };
if (built.name !== expected.worker || built.vars?.MP_MODE !== expected.mode ||
    built.d1_databases?.find(db=>db.binding==='DB')?.database_name !== expected.db ||
    (staging ? Boolean(built.routes?.length) : !productionRoute)) {
  throw new Error('O Worker, o banco ou o domínio do build não correspondem ao ambiente de destino.');
}
run(['node_modules/wrangler/bin/wrangler.js','deploy','--config',config,...(dryRun ? ['--dry-run'] : [])]);
