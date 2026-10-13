// Build de produção em dist/: JS e CSS minificados com hash no nome (cache de
// 1 ano), worker de simulação separado, index.html apontando para os arquivos
// novos e service worker com a lista de arquivos desta versão.
// Uso: npm run build   (o servidor entrega dist/ com NODE_ENV=production)
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: {
    app: 'app.js',
    worker: 'src/model/monte-carlo.worker.js',
    theme: 'theme.js',
    styles: 'styles.css',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  target: ['es2022', 'chrome100', 'safari15.4', 'firefox100'],
  outdir: path.join(dist, 'assets/build'),
  entryNames: '[name]-[hash]',
  // Fontes e imagens continuam em /assets/ (já são estáticas).
  external: ['/assets/*'],
  metafile: true,
  logLevel: 'warning',
});

const outputs = {};
for (const [file, info] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.map') || !info.entryPoint) continue;
  const name = path
    .basename(info.entryPoint)
    .replace(/\.(js|css)$/, '')
    .replace('monte-carlo.worker', 'worker');
  outputs[name] = `/${path.relative(dist, path.join(root, file)).replace(/\\/g, '/')}`;
}
for (const name of ['app', 'worker', 'theme', 'styles']) {
  if (!outputs[name]) throw new Error(`Saída do build sem ${name}`);
}

// Arquivos estáticos (sem código do servidor).
for (const folder of ['assets', 'data']) {
  await cp(path.join(root, folder), path.join(dist, folder), {
    recursive: true,
    filter: (source) => !path.basename(source).startsWith('.') && !source.includes(`${path.sep}build${path.sep}`),
  });
}
await cp(path.join(root, 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));

// index.html apontando para os arquivos com hash.
let html = await readFile(path.join(root, 'index.html'), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html sem ${from}`);
  html = html.replace(from, to);
};
swap('<script src="theme.js"></script>', `<script src="${outputs.theme}"></script>`);
swap('<link rel="stylesheet" href="styles.css" />', `<link rel="stylesheet" href="${outputs.styles}" />`);
swap('<script type="module" src="app.js"></script>', `<script type="module" src="${outputs.app}"></script>`);
swap(
  '<meta charset="utf-8" />',
  `<meta charset="utf-8" />\n    <meta name="simulabr-worker" content="${outputs.worker}" />`,
);
await writeFile(path.join(dist, 'index.html'), html);

// Service worker com a lista desta versão; o nome do cache muda a cada build.
const precache = [
  '/',
  '/manifest.webmanifest',
  outputs.app,
  outputs.worker,
  outputs.theme,
  outputs.styles,
  '/assets/logos.json',
  '/assets/simulabr-logo.webp',
  '/assets/fonts/inter-latin.woff2',
  '/assets/crests/map.json',
  '/data/season-2026.json',
  '/data/historical-backfill-2026.json',
  '/data/probability-history-2026.json',
  '/data/club-ratings-2026.json',
  '/data/club-ratings-overrides.json',
];
const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 10);
let sw = await readFile(path.join(root, 'sw.js'), 'utf8');
sw = sw
  .replace(/const CACHE = '[^']*';/, `const CACHE = 'simulabr-${version}';`)
  .replace(/const PRECACHE = \[[\s\S]*?\];/, `const PRECACHE = ${JSON.stringify(precache, null, 2)};`);
await writeFile(path.join(dist, 'sw.js'), sw);
await writeFile(
  path.join(dist, 'build.json'),
  `${JSON.stringify({ version, builtAt: new Date().toISOString(), outputs }, null, 2)}\n`,
);

const sizes = Object.entries(result.metafile.outputs)
  .filter(([file]) => !file.endsWith('.map'))
  .map(([file, info]) => `${path.basename(file)} ${(info.bytes / 1024).toFixed(0)} KB`);
console.log(`Build ${version} em dist/: ${sizes.join(' · ')}`);
