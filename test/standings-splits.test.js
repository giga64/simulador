import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSplitTable } from '../src/model/standings-splits.js';

const teams = ['AAA', 'BBB', 'CCC'];
const results = [
  { round: 1, home: 'AAA', away: 'BBB', homeGoals: 2, awayGoals: 0 },
  { round: 1, home: 'CCC', away: 'AAA', homeGoals: 1, awayGoals: 1 }, // deliberadamente fora de ordem de listagem
  { round: 2, home: 'BBB', away: 'CCC', homeGoals: 3, awayGoals: 1 },
  { round: 3, home: 'BBB', away: 'AAA', homeGoals: 0, awayGoals: 1 },
];
const byCode = (rows) => Object.fromEntries(rows.map((row) => [row.code, row]));

test('tabela geral soma pontos, saldo e posição', () => {
  const rows = buildSplitTable(results, teams, 'all');
  const t = byCode(rows);
  assert.deepEqual(
    [t.AAA.P, t.AAA.J, t.AAA.V, t.AAA.E, t.AAA.D, t.AAA.GP, t.AAA.GC, t.AAA.SG],
    [7, 3, 2, 1, 0, 4, 1, 3],
  );
  assert.deepEqual([t.BBB.P, t.BBB.V, t.BBB.D], [3, 1, 2]);
  assert.deepEqual(
    rows.map((row) => row.code),
    ['AAA', 'BBB', 'CCC'],
  );
  assert.equal(rows[0].position, 1);
});

test('mandante conta só jogos em casa; visitante só fora', () => {
  const home = byCode(buildSplitTable(results, teams, 'home'));
  assert.equal(home.AAA.J, 1);
  assert.equal(home.AAA.P, 3);
  assert.equal(home.BBB.J, 2);
  assert.equal(home.BBB.P, 3);
  const away = byCode(buildSplitTable(results, teams, 'away'));
  assert.equal(away.AAA.J, 2);
  assert.equal(away.AAA.P, 4);
  assert.equal(away.CCC.P, 0);
});

test('últimos N jogos usam os N mais recentes por rodada', () => {
  const last1 = byCode(buildSplitTable(results, teams, 'last1'));
  assert.equal(last1.AAA.J, 1);
  assert.equal(last1.AAA.P, 3); // 1x0 sobre o BBB na rodada 3
  assert.equal(last1.BBB.P, 0);
  assert.equal(last1.CCC.J, 1); // rodada 2
  assert.equal(last1.CCC.P, 0);
  const last10 = byCode(buildSplitTable(results, teams, 'last10'));
  assert.equal(last10.AAA.J, 3); // menos jogos que N: usa todos
});

test('time sem jogos no recorte fica com aproveitamento nulo', () => {
  const rows = byCode(buildSplitTable([], teams, 'all'));
  assert.equal(rows.AAA.J, 0);
  assert.equal(rows.AAA.rate, null);
});

test('não altera a lista original de resultados', () => {
  const copy = JSON.stringify(results);
  buildSplitTable(results, teams, 'all');
  assert.equal(JSON.stringify(results), copy);
});
