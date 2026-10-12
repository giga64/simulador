import assert from 'node:assert/strict';
import test from 'node:test';
import { cumulative, poissonPmf, sampleIndex, scoreGrid } from '../src/model/poisson.js';
import { expectedGoals } from '../src/model/expected-goals.js';
import { pickScore } from '../src/model/pick-score.js';
import { addHeadToHeadResult, emptyHeadToHead, rankTeams } from '../src/model/standings.js';
import { conditionalChances, histogramQuantile, runMonteCarlo } from '../src/model/monte-carlo.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} não está próximo de ${expected}`);

test('poissonPmf segue a fórmula de Poisson', () => {
  const pmf = poissonPmf(1.5, 4);
  close(pmf[0], Math.exp(-1.5));
  close(pmf[2], (Math.exp(-1.5) * 1.5 ** 2) / 2);
});

test('scoreGrid é normalizada e H + D + A = 1', () => {
  const grid = scoreGrid(1.6, 1.1, -0.1);
  close(
    grid.g.reduce((sum, value) => sum + value, 0),
    1,
  );
  close(grid.H + grid.D + grid.A, 1);
  assert.ok(grid.H > grid.A, 'quem tem mais gols esperados é favorito');
});

test('a correção de Dixon-Coles com rho negativo aumenta 0x0 e 1x1', () => {
  const plain = scoreGrid(1.3, 1.1, 0);
  const corrected = scoreGrid(1.3, 1.1, -0.15);
  assert.ok(corrected.g[0] > plain.g[0]);
  assert.ok(corrected.g[1 * corrected.n + 1] > plain.g[1 * plain.n + 1]);
});

test('sampleIndex encontra o primeiro acumulado que alcança r', () => {
  const values = cumulative([0.2, 0.3, 0.5]);
  assert.equal(sampleIndex(values, 0), 0);
  assert.equal(sampleIndex(values, 0.2), 0);
  assert.equal(sampleIndex(values, 0.2000001), 1);
  assert.equal(sampleIndex(values, 0.99), 2);
  assert.equal(sampleIndex(values, 1.5), 2);
});

test('expectedGoals respeita mando de campo e ajuste de força', () => {
  const standings = new Map([
    ['AAA', { matches: 10, goalsFor: 20, goalsAgainst: 8 }],
    ['BBB', { matches: 10, goalsFor: 8, goalsAgainst: 20 }],
  ]);
  const base = { k: 6, ha: 1, rho: -0.1, adj: {} };
  const args = { standings, homeGoalsAverage: 1.5, awayGoalsAverage: 1.1 };
  const [strongHome, weakAway] = expectedGoals({ ...args, home: 'AAA', away: 'BBB', settings: base });
  assert.ok(strongHome > weakAway);
  const [boosted] = expectedGoals({ ...args, home: 'AAA', away: 'BBB', settings: { ...base, adj: { AAA: 20 } } });
  assert.ok(boosted > strongHome);
  const [moreHome] = expectedGoals({ ...args, home: 'AAA', away: 'BBB', settings: { ...base, ha: 1.2 } });
  assert.ok(moreHome > strongHome);
});

test('pickScore: métodos fixos e resultado mais provável', () => {
  const grid = scoreGrid(2.2, 0.6, -0.1);
  assert.deepEqual(pickScore('home', grid), [1, 0]);
  assert.deepEqual(pickScore('draw', grid), [1, 1]);
  const [x, y] = pickScore('ml', grid);
  assert.ok(x > y);
  assert.deepEqual(pickScore('sample', grid, { seed: 7, key: 'a' }), pickScore('sample', grid, { seed: 7, key: 'a' }));
});

test('rankTeams aplica pontos, vitórias, saldo, gols pró e confronto direto entre dois', () => {
  const stats = {
    AAA: { P: 50, V: 15, GP: 40, GC: 20 },
    BBB: { P: 50, V: 15, GP: 40, GC: 20 },
    CCC: { P: 50, V: 16, GP: 30, GC: 30 },
    DDD: { P: 49, V: 15, GP: 60, GC: 10 },
  };
  const teams = Object.keys(stats);
  const headToHead = emptyHeadToHead(teams);
  addHeadToHeadResult(headToHead, 'BBB', 'AAA', 2, 0);
  assert.deepEqual(rankTeams(stats, teams, { headToHead }), ['CCC', 'BBB', 'AAA', 'DDD']);
});

test('rankTeams usa a ordem oficial quando os números coincidem com a fonte', () => {
  const stats = { AAA: { P: 10, V: 3, GP: 5, GC: 5 }, BBB: { P: 10, V: 3, GP: 5, GC: 5 } };
  const officialStandings = new Map([
    ['AAA', { points: 10, wins: 3, goalsFor: 5, goalsAgainst: 5, position: 2 }],
    ['BBB', { points: 10, wins: 3, goalsFor: 5, goalsAgainst: 5, position: 1 }],
  ]);
  assert.deepEqual(rankTeams(stats, ['AAA', 'BBB'], { officialStandings }), ['BBB', 'AAA']);
});

function twoTeamInput(overrides = {}) {
  const grid = scoreGrid(1.4, 1.1, -0.1);
  return {
    teamCount: 2,
    points: [10, 10],
    wins: [3, 3],
    goalDifference: [0, 0],
    goalsFor: [5, 5],
    headToHead: [
      [0, 0],
      [0, 0],
    ],
    fixtures: [{ home: 0, away: 1, size: grid.n, cumulative: cumulative(grid.g), track: 0 }],
    cutPositions: [0],
    relegationPlaces: 1,
    iterations: 2000,
    seed: 42,
    trackedCount: 1,
    ...overrides,
  };
}

test('runMonteCarlo é reproduzível com a mesma semente', () => {
  const first = runMonteCarlo(twoTeamInput());
  const second = runMonteCarlo(twoTeamInput());
  assert.deepEqual(first.PC, second.PC);
  assert.notDeepEqual(first.PC, runMonteCarlo(twoTeamInput({ seed: 43 })).PC);
});

test('runMonteCarlo: cada simulação dá exatamente uma posição a cada clube', () => {
  const result = runMonteCarlo(twoTeamInput());
  for (const counts of result.PC)
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      result.N,
    );
  assert.equal(result.PC[0][0] + result.PC[1][0], result.N);
  assert.ok(result.PC[0][0] > result.PC[1][0], 'o mandante favorito termina em 1º mais vezes');
});

test('runMonteCarlo soma o placar de um jogo ao vivo ao tempo restante', () => {
  // Restam ~0 gols: só o placar atual (2x0) importa, e o mandante termina em 1º sempre.
  const remaining = scoreGrid(0.0001, 0.0001, 0);
  const result = runMonteCarlo(
    twoTeamInput({
      fixtures: [
        {
          home: 0,
          away: 1,
          size: remaining.n,
          cumulative: cumulative(remaining.g),
          baseHome: 2,
          baseAway: 0,
          track: 0,
        },
      ],
    }),
  );
  assert.equal(result.PC[0][0], result.N);
  assert.equal(histogramQuantile(result.PH[0], result.N, 0.5), 13);
});

test('conditionalChances mede o efeito de cada resultado', () => {
  const result = runMonteCarlo(twoTeamInput());
  const [row] = conditionalChances(result, 0, 2, 0, 0);
  assert.equal(row.home, 1, 'se o mandante vence, termina em 1º');
  assert.equal(row.away, 0, 'se perde, termina em 2º');
  close(row.swing, 1);
});

test('histogramQuantile devolve a mediana do histograma', () => {
  assert.equal(histogramQuantile([0, 2, 5, 3], 10, 0.5), 2);
  assert.equal(histogramQuantile([0, 2, 5, 3], 10, 0.9), 3);
});
