import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { allPaths, pathFor, routeFromPath, slugify } from '../src/client/routes.js';
import { applyMeta, describeRoute } from '../src/server/seo.js';

const season = JSON.parse(await readFile(new URL('../data/season-2026.json', import.meta.url), 'utf8'));
const teams = season.teams;

test('slugify tira acentos e símbolos', () => {
  assert.equal(slugify('São Paulo'), 'sao-paulo');
  assert.equal(slugify('Atlético-MG'), 'atletico-mg');
  assert.equal(slugify('Red Bull Bragantino'), 'red-bull-bragantino');
});

test('ida e volta: todo endereço do sitemap vira uma rota e volta ao mesmo endereço', () => {
  for (const path of allPaths(teams)) {
    const route = routeFromPath(path, teams);
    assert.ok(route, path);
    assert.equal(pathFor(route, teams), path, path);
  }
});

test('rotas conhecidas e desconhecidas', () => {
  assert.deepEqual(routeFromPath('/clube/flamengo', teams), { view: 'clubs', team: 'FLA' });
  assert.deepEqual(routeFromPath('/chances/vagas/', teams), { view: 'cor', sub: 'vagas' });
  assert.deepEqual(routeFromPath('/copas/sul-americana', teams), { view: 'copas', cup: 'sudamericana' });
  assert.deepEqual(routeFromPath('/rodada/31', teams), { view: 'est', sub: 'rounds', round: 31 });
  for (const path of ['/clube/inexistente', '/rodada/39', '/rodada/0', '/chances/x', '/styles.css', '/api/config']) {
    assert.equal(routeFromPath(path, teams), null, path);
  }
});

test('descrição usa as chances atuais e o HTML recebe meta tags escapadas', () => {
  const chances = Object.fromEntries(
    Object.keys(teams).map((code) => [code, { title: 0, libertadores: 0, relegation: 0 }]),
  );
  chances.FLA = { title: 61.7, libertadores: 99.9, relegation: 0.2 };
  const meta = describeRoute({ view: 'clubs', team: 'FLA' }, { teams, chances, round: 30 });
  assert.match(meta.description, /Flamengo tem 62% de chance de título/);
  assert.match(meta.description, /menos de 1% de rebaixamento/);
  const html = applyMeta(
    '<head><title>x</title><meta name="description" content="a" /><meta property="og:title" content="b" />\n<meta\n property="og:description"\n content="c"\n/></head>',
    { title: 'T "1"', description: 'D <b>', url: 'https://site/clube/flamengo' },
  );
  assert.match(html, /<title>T &quot;1&quot;<\/title>/);
  assert.match(html, /content="D &lt;b&gt;"/);
  assert.match(html, /rel="canonical" href="https:\/\/site\/clube\/flamengo"/);
});
