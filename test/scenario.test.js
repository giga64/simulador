import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededRandom, hashKey } from '../src/random.js';
import {
  decodeScenarioPayload,
  encodeScenarioPayload,
  makeBackup,
  pruneCompletedScenarioScores,
  validateScenarioPayload,
} from '../src/scenario.js';

const matchIds = ['30:0', 'p'];
const teamCodes = ['FLA', 'VAS'];
const validPayload = {
  version: 1,
  scores: { '30:0': ['2', '1', 'u'], p: ['3', '', 'u'] },
  settings: { k: 6, ha: 1, rho: -0.1, seed: 20261010, adjustments: { FLA: 8 } },
  options: { full: true, odds: false, method: 'sample' },
};

test('a shared scenario round-trips UTF-8 scores and model settings', () => {
  const encoded = encodeScenarioPayload(validPayload);
  assert.deepEqual(decodeScenarioPayload(encoded), validPayload);
  assert.deepEqual(validateScenarioPayload(validPayload, matchIds, teamCodes).errors, []);
});

test('invalid scores, unknown matches, and out-of-range settings are rejected', () => {
  const invalid = structuredClone(validPayload);
  invalid.scores['30:0'][0] = '21';
  invalid.scores.unknown = ['1', '0', 'u'];
  invalid.settings.seed = -1;

  const { errors } = validateScenarioPayload(invalid, matchIds, teamCodes);
  assert.ok(errors.some((error) => error.includes('placar')));
  assert.ok(errors.some((error) => error.includes('desconhecida')));
  assert.ok(errors.some((error) => error.includes('semente')));
});

test('a backup preserves its payload and format marker', () => {
  const backup = makeBackup(validPayload, '2026-10-10T00:00:00.000Z');
  assert.equal(backup.format, 'brasileirao-simulator-backup');
  assert.deepEqual(validateScenarioPayload(backup, matchIds, teamCodes).errors, []);
});

test('completed match predictions are removed while postponed and future predictions remain', () => {
  const fixtures = [
    { id: 'old-round', round: 2, status: 'scheduled' },
    { id: 'finished', round: 4, status: 'played' },
    { id: 'postponed', round: 3, status: 'postponed' },
    { id: 'future', round: 8, status: 'scheduled' },
  ];
  const result = pruneCompletedScenarioScores({
    'old-round': ['1', '0', 'u'],
    finished: ['0', '0', 'u'],
    postponed: ['2', '0', 'u'],
    future: ['1', '1', 'u'],
    unknown: ['0', '0', 'u'],
  }, fixtures, 5, ['postponed', 'future']);

  assert.equal(result.removed, 2);
  assert.deepEqual(Object.keys(result.scores), ['postponed', 'future', 'unknown']);
});

test('seeded random streams repeat for the same seed and diverge for other seeds', () => {
  const draw = (seed) => Array.from({ length: 5 }, createSeededRandom(seed));
  assert.deepEqual(draw(1234), draw(1234));
  assert.notDeepEqual(draw(1234), draw(1235));
  assert.notDeepEqual(draw(hashKey('scenario-a')), draw(hashKey('scenario-b')));
});
