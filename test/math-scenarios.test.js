import assert from 'node:assert/strict';
import test from 'node:test';
import { clinchSafety, clinchTopN, describeGoal } from '../src/model/math-scenarios.js';

const team = (P, J) => ({ P, J });

test('título: garante superando o máximo do rival mais perigoso', () => {
  const stats = { A: team(80, 36), B: team(76, 36), C: team(60, 36) };
  // B pode chegar a 82; A precisa de 83 => 3 pontos (1 vitória) em 2 jogos.
  const result = clinchTopN(stats, 'A', 1);
  assert.deepEqual([result.needed, result.winsNeeded, result.reachableAlone], [3, 1, true]);
  assert.match(
    describeGoal(result, { verb: 'ser campeão', noun: 'o título', teamName: 'A' }),
    /garante o título se somar 3 pontos nos 2 jogos/,
  );
});

test('título já garantido e título impossível', () => {
  const stats = { A: team(90, 37), B: team(80, 37), C: team(40, 37) };
  assert.equal(clinchTopN(stats, 'A', 1).clinched, true);
  assert.equal(clinchTopN(stats, 'C', 1).impossible, true, 'C chega no máximo a 43');
  assert.match(
    describeGoal(clinchTopN(stats, 'C', 1), { verb: 'ser campeão', noun: 'o título', teamName: 'C' }),
    /C não pode mais ser campeão/,
  );
});

test('fugir do rebaixamento: precisa ficar acima de pelo menos `places` clubes', () => {
  const stats = { A: team(40, 34), B: team(38, 34), C: team(35, 34), D: team(30, 34), E: team(20, 34) };
  // 2 rebaixados: A precisa terminar entre os 3 primeiros, ou seja, à frente de
  // 2 rivais. Os menos perigosos são D (máximo 42) e E (32): A precisa de 43
  // => 3 pontos.
  const result = clinchSafety(stats, 'A', 2);
  assert.equal(result.needed, 3);
  assert.equal(result.reachableAlone, true);
});

test('meta que não depende só do clube', () => {
  const stats = { A: team(50, 30), B: team(70, 30) };
  const result = clinchTopN(stats, 'A', 1);
  assert.equal(result.reachableAlone, false);
  assert.equal(result.impossible, false, 'A ainda pode chegar a 74');
  assert.match(describeGoal(result, { verb: 'ser campeão', noun: 'o título', teamName: 'A' }), /depende de tropeços/);
});
