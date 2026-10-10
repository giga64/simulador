import assert from 'node:assert/strict';
import test from 'node:test';
import {
  archiveCompletedPredictions,
  createModelSnapshot,
  summarizePredictionCalibration,
  summarizePredictionPerformance,
  upsertPredictionSnapshot,
  validatePredictionHistory,
} from '../src/prediction-performance.js';

const fixtures = [
  { id: 'played', round: 1, home: 'FLA', away: 'PAL', status: 'played' },
  { id: 'scheduled', round: 2, home: 'PAL', away: 'FLA', status: 'scheduled' },
];
const teams = ['FLA', 'PAL'];
const resultSource = {
  name: 'GE (Globo Esporte)',
  url: 'https://ge.globo.com/futebol/brasileirao-serie-a/',
  verifiedAt: '2026-10-10T12:00:00-03:00',
  type: 'feed-observed',
};

test('archives completed exact and automatic predictions with result provenance', () => {
  const archived = archiveCompletedPredictions([], {
    played: ['2', '1', 'u'],
    scheduled: ['1', '0', 'a'],
  }, fixtures, [{
    round: 1, home: 'FLA', away: 'PAL', homeGoals: 2, awayGoals: 1, source: resultSource,
  }], '2026-10-10T15:00:00.000Z');

  assert.equal(archived.added, 1);
  assert.deepEqual(archived.history[0].prediction, { home: 2, away: 1, type: 'u' });
  assert.deepEqual(archived.history[0].actual, { home: 2, away: 1 });
  assert.deepEqual(archived.history[0].resultSource, resultSource);
});

test('deduplicates saved predictions and updates corrected result provenance', () => {
  const existing = {
    fixtureId: 'played',
    round: 1,
    home: 'FLA',
    away: 'PAL',
    prediction: { home: 1, away: 0, type: 'u' },
    actual: { home: 0, away: 0 },
    resultSource: { name: 'Snapshot', url: null, type: 'snapshot' },
    recordedAt: '2026-10-10T12:00:00.000Z',
  };
  const archived = archiveCompletedPredictions([existing], {
    played: ['1', '0', 'u'],
  }, fixtures, [{
    round: 1, home: 'FLA', away: 'PAL', homeGoals: 0, awayGoals: 1, source: resultSource,
  }], '2026-10-10T15:00:00.000Z');

  assert.equal(archived.added, 0);
  assert.equal(archived.history.length, 1);
  assert.deepEqual(archived.history[0].actual, { home: 0, away: 1 });
  assert.deepEqual(archived.history[0].resultSource, resultSource);
});

test('summarizes exact scores, outcomes, and points for each club', () => {
  const history = [{
    fixtureId: 'played',
    round: 1,
    home: 'FLA',
    away: 'PAL',
    prediction: { home: 2, away: 1, type: 'u' },
    actual: { home: 3, away: 1 },
    resultSource,
    recordedAt: '2026-10-10T15:00:00.000Z',
  }, {
    fixtureId: 'other',
    round: 2,
    home: 'PAL',
    away: 'FLA',
    prediction: { home: 0, away: 0, type: 'a' },
    actual: { home: 1, away: 0 },
    resultSource,
    recordedAt: '2026-10-10T15:00:00.000Z',
  }];
  const summary = summarizePredictionPerformance(history, teams);

  assert.equal(summary.matches, 2);
  assert.equal(summary.exactScoreHits, 0);
  assert.equal(summary.correctOutcomeHits, 1);
  assert.equal(summary.outcomeRate, 0.5);
  assert.equal(summary.predictedGoals, 3);
  assert.equal(summary.actualGoals, 5);
  assert.deepEqual(summary.clubs.map(({ code, predictedPoints, actualPoints, pointsDifference }) =>
    ({ code, predictedPoints, actualPoints, pointsDifference })), [
    { code: 'FLA', predictedPoints: 4, actualPoints: 3, pointsDifference: 1 },
    { code: 'PAL', predictedPoints: 1, actualPoints: 3, pointsDifference: -2 },
  ]);
});

test('rejects malformed and duplicate prediction-history entries', () => {
  const entry = {
    fixtureId: 'played',
    round: 1,
    home: 'FLA',
    away: 'PAL',
    prediction: { home: 1, away: 0, type: 'u' },
    actual: { home: 2, away: 1 },
    resultSource,
    recordedAt: '2026-10-10T15:00:00.000Z',
  };
  assert.deepEqual(validatePredictionHistory([entry], fixtures, teams), [entry]);
  assert.throws(() => validatePredictionHistory([entry, entry], fixtures, teams), /inválido/);
  assert.throws(() => validatePredictionHistory([{ ...entry, resultSource: { ...resultSource, url: 'javascript:alert(1)' } }], fixtures, teams), /inválido/);
  assert.throws(() => validatePredictionHistory([{ ...entry, actual: { home: -1, away: 1 } }], fixtures, teams), /inválido/);
});

test('captures immutable model settings and forecast probabilities with the chosen score', () => {
  const fixture = fixtures[1];
  const snapshot = createModelSnapshot({
    probabilities: { home: 0.5, draw: 0.25, away: 0.25 },
    settings: { seed: 1234, k: 6, ha: 1.1, rho: -0.1, adjustments: { FLA: 10, PAL: -5 } },
    teams: { home: 'PAL', away: 'FLA' },
    dataRevision: 'feed-rev-1',
    method: 'ml',
    recordedAt: '2026-10-10T15:00:00.000Z',
  });
  const history = upsertPredictionSnapshot([], fixture, ['2', '0', 'u'], snapshot);

  assert.deepEqual(history[0].modelSnapshot.settings.adjustments, { home: -5, away: 10 });
  assert.deepEqual(history[0].modelSnapshot.probabilities, { home: 0.5, draw: 0.25, away: 0.25 });
  assert.throws(() => createModelSnapshot({
    probabilities: { home: 0.5, draw: 0.5, away: 0.5 },
    settings: { seed: 1, k: 6, ha: 1, rho: 0 },
    teams: { home: 'FLA', away: 'PAL' },
  }), /somar 100/);
});

test('archives a pending snapshot when the real result arrives and computes calibration', () => {
  const snapshot = createModelSnapshot({
    probabilities: { home: 0.6, draw: 0.2, away: 0.2 },
    settings: { seed: 1, k: 6, ha: 1, rho: -0.1 },
    teams: { home: 'PAL', away: 'FLA' },
    recordedAt: '2026-10-10T15:00:00.000Z',
  });
  const pending = upsertPredictionSnapshot([], fixtures[1], ['1', '0', 'u'], snapshot);
  const archived = archiveCompletedPredictions(pending, {}, fixtures, [{
    round: 2,
    home: 'PAL',
    away: 'FLA',
    homeGoals: 0,
    awayGoals: 1,
    source: resultSource,
  }]);
  const calibration = summarizePredictionCalibration(archived.history);
  assert.equal(archived.added, 0);
  assert.deepEqual(archived.history[0].actual, { home: 0, away: 1 });
  assert.equal(calibration.matches, 1);
  assert.ok(Math.abs(calibration.brierScore - 1.04) < 1e-12);
  assert.deepEqual(calibration.bins.map((bin) => ({
    matches: bin.matches,
    meanConfidence: bin.meanConfidence,
    observedAccuracy: bin.observedAccuracy,
  })), [{ matches: 1, meanConfidence: 0.6, observedAccuracy: 0 }]);
});

test('accuracy and points summaries exclude predictions that do not have results yet', () => {
  const pending = {
    fixtureId: 'scheduled',
    round: 2,
    home: 'PAL',
    away: 'FLA',
    prediction: { home: 1, away: 0, type: 'u' },
    modelSnapshot: createModelSnapshot({
      probabilities: { home: 0.5, draw: 0.25, away: 0.25 },
      settings: { seed: 1, k: 6, ha: 1, rho: -0.1 },
      teams: { home: 'PAL', away: 'FLA' },
    }),
    recordedAt: '2026-10-10T15:00:00.000Z',
  };
  assert.equal(summarizePredictionPerformance([pending], teams).matches, 0);
  assert.equal(summarizePredictionCalibration([pending]).matches, 0);
});
