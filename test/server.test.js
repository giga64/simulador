import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeScenarioPayload } from '../src/scenario.js';
import { createRequestHandler } from '../src/server/app.js';
import { createRateLimiter } from '../src/server/http.js';
import { createSeasonService, detectLiveEvents } from '../src/server/season-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const [snapshot, backfill, logos] = await Promise.all([
  readJson('data/season-2026.json'),
  readJson('data/historical-backfill-2026.json'),
  readJson('assets/logos.json'),
]);
const memoryStore = (value) => ({ read: async () => structuredClone(value), write: async () => {} });
const silent = { error() {} };

async function startServer(overrides = {}) {
  const calls = { forced: 0, saved: [] };
  const seasonService = createSeasonService({
    snapshot,
    backfill,
    logos,
    reconstructedHistory: [],
    historyStore: memoryStore({ entries: [] }),
    logger: silent,
  });
  const handler = createRequestHandler({
    root,
    readLiveFeed: async ({ forceRefresh }) => {
      if (forceRefresh) calls.forced++;
      return { ok: true };
    },
    seasonService,
    publicConfig: { authConfigured: false },
    deleteAccount: async () => ({ status: 200, body: { deleted: true } }),
    sharedScenarios: {
      enabled: true,
      save: async (payload) => {
        calls.saved.push(payload);
        return 'AbCdEfGh12';
      },
      load: async (id) => (id === 'AbCdEfGh12' ? calls.saved[0] || null : null),
    },
    renderScenarioImage: () => Buffer.from('png'),
    oddsTracker: { comparison: async () => ({ configured: false, matches: 0 }) },
    logger: silent,
    ...overrides,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

const openFixture = snapshot.fixtures.find((fixture) => fixture.status !== 'played' && fixture.round >= 31);
const payload = {
  version: 1,
  scores: { [openFixture.id]: ['2', '0', 'u'] },
  settings: { k: 14, ha: 1, rho: -0.1, seed: 1, adjustments: {} },
  options: { full: false, odds: true, method: 'ml' },
};

test('página inicial sai com CSP, anti-iframe e nosniff', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  } finally {
    await server.close();
  }
});

test('arquivos internos não são servidos', async () => {
  const server = await startServer();
  try {
    for (const file of [
      '/.git/config',
      '/package.json',
      '/src/server/app.js',
      '/server-assets/fonts/OFL.txt',
      '/%2e%2e/x',
    ]) {
      assert.equal((await fetch(`${server.base}${file}`)).status, 404, file);
    }
    const css = await fetch(`${server.base}/styles.css`);
    assert.equal(css.status, 200);
    const etag = css.headers.get('etag');
    assert.equal((await fetch(`${server.base}/styles.css`, { headers: { 'If-None-Match': etag } })).status, 304);
  } finally {
    await server.close();
  }
});

test('métodos não permitidos respondem 405', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/`, { method: 'PUT' })).status, 405);
    assert.equal((await fetch(`${server.base}/api/config`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${server.base}/api/account`)).status, 405);
  } finally {
    await server.close();
  }
});

test('consulta forçada à fonte é limitada para não sobrecarregar o GE', async () => {
  const server = await startServer();
  try {
    for (let index = 0; index < 3; index++) await fetch(`${server.base}/api/live-season?refresh=1`);
    assert.equal(server.calls.forced, 1, 'só a primeira consulta em 20 s força a fonte');
    let last;
    for (let index = 0; index < 3; index++) last = await fetch(`${server.base}/api/live-season?refresh=1`);
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  } finally {
    await server.close();
  }
});

test('exclusão de conta exige token Bearer', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.base}/api/account`, { method: 'DELETE' })).status, 401);
    const ok = await fetch(`${server.base}/api/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${'a'.repeat(40)}` },
    });
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});

test('link curto: valida o cenário, salva e serve a página com a prévia', async () => {
  const server = await startServer();
  try {
    const invalid = await fetch(`${server.base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { ...payload, scores: { 'nao-existe': ['1', '0', 'u'] } } }),
    });
    assert.equal(invalid.status, 400);
    const wrongType = await fetch(`${server.base}/api/share`, { method: 'POST', body: 'x' });
    assert.equal(wrongType.status, 415);
    const created = await fetch(`${server.base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).id, 'AbCdEfGh12');
    const page = await (await fetch(`${server.base}/c/AbCdEfGh12`)).text();
    assert.match(page, /og:image" content="\/api\/og\/c\/AbCdEfGh12\.png"/);
    assert.match(page, /og:title" content="Meu cenário/);
    const image = await fetch(`${server.base}/api/og/c/AbCdEfGh12.png`);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal((await fetch(`${server.base}/api/share/naoexiste1`)).status, 404);
  } finally {
    await server.close();
  }
});

test('imagem de cenário inválido redireciona para a imagem padrão', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/api/og/scenario.png?s=@@@`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/assets/og-image.png');
    const valid = await fetch(`${server.base}/api/og/scenario.png?s=${encodeScenarioPayload(payload)}`);
    assert.equal(valid.status, 200);
  } finally {
    await server.close();
  }
});

test('createRateLimiter libera de novo depois da janela', () => {
  let now = 0;
  const check = createRateLimiter({ windowMs: 1000, max: 2, clock: () => now });
  assert.equal(check('a').allowed, true);
  assert.equal(check('a').allowed, true);
  assert.equal(check('a').allowed, false);
  assert.equal(check('b').allowed, true, 'chaves são independentes');
  now = 1000;
  assert.equal(check('a').allowed, true);
});

test('detectLiveEvents identifica início, gol e fim de jogo', () => {
  const match = (homeGoals, awayGoals) => ({
    fixtureId: 'f1',
    round: 30,
    home: 'FLA',
    away: 'PAL',
    homeGoals,
    awayGoals,
  });
  assert.deepEqual(detectLiveEvents(null, new Map([['f1', match(0, 0)]]), []), [], 'sem estado anterior, nada');
  assert.equal(detectLiveEvents(new Map(), new Map([['f1', match(0, 0)]]), [])[0].type, 'start');
  const goal = detectLiveEvents(new Map([['f1', match(0, 0)]]), new Map([['f1', match(0, 1)]]), []);
  assert.deepEqual([goal[0].type, goal[0].side], ['goal', 'away']);
  const end = detectLiveEvents(new Map([['f1', match(0, 1)]]), new Map(), [
    { round: 30, home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 1 },
  ]);
  assert.deepEqual([end[0].type, end[0].homeGoals, end[0].awayGoals], ['end', 1, 1]);
});
