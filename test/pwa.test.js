import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const precached = [...sw.matchAll(/^\s+'(\/[^']*)',?$/gm)].map((match) => match[1]);

test('o service worker pré-carrega todos os módulos de src/', () => {
  for (const dir of ['src', 'src/ui']) {
    for (const file of readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.js'))) {
      assert.ok(precached.includes(`/${dir}/${file}`), `/${dir}/${file} falta no PRECACHE de sw.js`);
    }
  }
});

test('tudo que o service worker pré-carrega existe (exceto /vendor, gerado na instalação)', () => {
  for (const url of precached.filter((u) => u !== '/' && !u.startsWith('/vendor/'))) {
    assert.ok(existsSync(new URL(`..${url}`, import.meta.url)), `${url} não existe`);
  }
});

test('manifest aponta para ícones existentes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(`../${icon.src}`, import.meta.url)), icon.src);
});

test('index.html declara manifest e tags de compartilhamento', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const needle of ['rel="manifest"', 'og:title', 'og:image"', 'twitter:card'])
    assert.ok(html.includes(needle), needle);
});
