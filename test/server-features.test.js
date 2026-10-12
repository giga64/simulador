import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cleanText, createTeamCodeResolver } from '../src/live-season.js';
import { backtestModel } from '../src/model/backtest.js';
import { isValidHistoryEntry, mergeHistory } from '../src/model/probability-history.js';
import { simulateSeasonChances } from '../src/model/season-model.js';
import { brier, compareWithMarket, impliedProbabilities, marketFromEvent } from '../src/server/odds.js';
import { isValidPushSubscription, pushMessage } from '../src/server/push.js';

const season = JSON.parse(await readFile(new URL('../data/season-2026.json', import.meta.url), 'utf8'));
const teams = Object.keys(season.teams);

test('cleanText remove marcação e caracteres de controle', () => {
  assert.equal(cleanText('<img src=x onerror=alert(1)>Arena'), 'img src=x onerror=alert(1)Arena');
  assert.equal(cleanText('Maracanã\u0000'), 'Maracanã');
  assert.equal(cleanText(42), '');
  assert.equal(cleanText('x'.repeat(200)).length, 80);
});

test('resolvedor de clubes aceita nomes usados por sites de odds', () => {
  const resolve = createTeamCodeResolver(season.teams);
  assert.equal(resolve({ name: 'Atletico Mineiro' }), 'CAM');
  assert.equal(resolve({ name: 'Botafogo RJ' }), 'BOT');
  assert.equal(resolve({ name: 'Red Bull Bragantino' }), 'BRA');
  assert.equal(resolve({ name: 'Sao Paulo' }), 'SAO');
  assert.equal(resolve({ name: 'Bragantino-SP' }), 'BRA', 'nome usado pela the-odds-api');
  assert.equal(resolve({ name: 'Atletico Paranaense' }), 'CAP');
  assert.equal(resolve({ name: 'Vitoria' }), 'VIT');
  assert.equal(resolve({ name: 'Time Inexistente-SP' }), null);
});

test('odds: probabilidades implícitas somam 1 e a margem sai', () => {
  const probabilities = impliedProbabilities([2, 3.4, 3.8]);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(probabilities[0] > probabilities[2]);
  const market = marketFromEvent({
    home_team: 'Flamengo',
    away_team: 'Palmeiras',
    bookmakers: [
      {
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'Flamengo', price: 2 },
              { name: 'Draw', price: 3.3 },
              { name: 'Palmeiras', price: 4 },
            ],
          },
        ],
      },
      { markets: [{ key: 'h2h', outcomes: [{ name: 'Flamengo', price: 2.1 }] }] },
    ],
  });
  assert.equal(market.length, 3, 'casas com dados incompletos são ignoradas');
  assert.equal(marketFromEvent({ home_team: 'A', away_team: 'B', bookmakers: [] }), null);
});

test('odds: comparação usa só jogos com resultado', () => {
  const records = [
    { fixtureId: 'a', round: 1, home: 'CAM', away: 'PAL', model: [0.5, 0.3, 0.2], market: [0.4, 0.3, 0.3] },
    { fixtureId: 'b', round: 99, home: 'X', away: 'Y', model: [0.3, 0.3, 0.4], market: [0.3, 0.3, 0.4] },
  ];
  const result = compareWithMarket(records, season.results);
  assert.equal(result.matches, 1);
  const first = season.results.find((item) => item.round === 1 && item.home === 'CAM');
  const outcome = first.homeGoals > first.awayGoals ? 0 : first.homeGoals === first.awayGoals ? 1 : 2;
  assert.equal(result.modelBrier, brier([0.5, 0.3, 0.2], outcome));
});

test('push: só aceita inscrições https com chaves válidas', () => {
  const valid = { endpoint: 'https://push.example/abc', keys: { p256dh: 'A'.repeat(80), auth: 'B'.repeat(20) } };
  assert.equal(isValidPushSubscription(valid), true);
  assert.equal(isValidPushSubscription({ ...valid, endpoint: 'http://push.example/abc' }), false);
  assert.equal(isValidPushSubscription({ ...valid, keys: { ...valid.keys, auth: '<script>' } }), false);
  const names = { FLA: 'Flamengo', PAL: 'Palmeiras' };
  assert.equal(
    pushMessage({ type: 'goal', side: 'home', home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 0 }, names).title,
    'Gol do Flamengo!',
  );
  assert.equal(
    pushMessage({ type: 'end', home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 0 }, names).body,
    'Flamengo 1 x 0 Palmeiras',
  );
});

test('histórico: fotos observadas substituem as reconstruídas no mesmo ponto', () => {
  const chances = Object.fromEntries(
    teams.map((code) => [code, { title: 5, libertadores: 25, sudamericana: 30, relegation: 20 }]),
  );
  const merged = mergeHistory(
    [
      { matches: 10, chances, source: 'reconstructed' },
      { matches: 20, chances, source: 'reconstructed' },
    ],
    [
      { matches: 20, chances, source: 'observed' },
      { matches: 25, chances, source: 'observed' },
    ],
  );
  assert.deepEqual(
    merged.map((entry) => [entry.matches, entry.source]),
    [
      [10, 'reconstructed'],
      [20, 'observed'],
      [25, 'observed'],
    ],
  );
  assert.equal(isValidHistoryEntry({ matches: 10, chances }, teams), true);
  assert.equal(isValidHistoryEntry({ matches: 10, chances: { ...chances, FLA: { title: 120 } } }, teams), false);
});

test('chances da temporada somam 100% por posição e 1 campeão', () => {
  const { chances } = simulateSeasonChances({ seasonData: season, iterations: 2000 });
  const titleTotal = teams.reduce((sum, code) => sum + chances[code].title, 0);
  assert.ok(Math.abs(titleTotal - 100) < 1e-6);
  const relegationTotal = teams.reduce((sum, code) => sum + chances[code].relegation, 0);
  assert.ok(Math.abs(relegationTotal - season.qualificationModel.relegationPlaces * 100) < 1e-6);
});

test('backtest: o modelo erra menos que a referência ingênua nesta temporada', () => {
  const result = backtestModel(season.results, teams, { k: 14, rho: -0.1 });
  assert.ok(result.matches > 100);
  assert.ok(result.brier < result.naiveBrier, `${result.brier} deveria ser menor que ${result.naiveBrier}`);
});

test('push: envia aos torcedores dos dois clubes, não repete e limpa inscrições expiradas', async () => {
  const { createPushNotifier } = await import('../src/server/push.js');
  const deleted = [];
  const sent = [];
  const rows = [
    { endpoint: 'https://push.example/ok', p256dh: 'p', auth: 'a' },
    { endpoint: 'https://push.example/gone', p256dh: 'p', auth: 'a' },
  ];
  const query = (table) => ({
    select: () => ({
      overlaps: async (column, teamsFilter) => {
        assert.deepEqual(teamsFilter, ['FLA', 'PAL']);
        return { data: [{ user_id: 'u1' }], error: null };
      },
      in: async () => ({ data: rows, error: null }),
    }),
    delete: () => ({
      eq: async (column, value) => {
        deleted.push([table, value]);
        return { error: null };
      },
    }),
  });
  const notifier = createPushNotifier({
    vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' },
    adminClient: { from: query },
    teamNames: { FLA: 'Flamengo', PAL: 'Palmeiras' },
    logger: { error() {} },
    sender: {
      setVapidDetails() {},
      async sendNotification(subscription, payload) {
        if (subscription.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
        sent.push(JSON.parse(payload));
      },
    },
  });
  const event = { type: 'goal', side: 'home', fixtureId: 'f1', home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 0 };
  assert.equal(await notifier.notify([event]), 1);
  assert.equal(await notifier.notify([event]), 0, 'o mesmo evento não é enviado duas vezes');
  assert.equal(sent[0].title, 'Gol do Flamengo!');
  assert.deepEqual(deleted, [['push_subscriptions', 'https://push.example/gone']]);
});
