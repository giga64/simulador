import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assessHistoryCoverage, mergeVerifiedResults } from '../src/history-integrity.js';

const season = JSON.parse(await readFile(new URL('../data/season-2026.json', import.meta.url), 'utf8'));
const backfill = {
  schemaVersion: 1,
  season: 2026,
  updatedAt: '2026-10-10T12:00:00-03:00',
  results: [],
};

function standingsFrom(results) {
  const standings = new Map(
    Object.keys(season.teams).map((code) => [
      code,
      {
        matches: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
      },
    ]),
  );
  for (const result of results) {
    const home = standings.get(result.home);
    const away = standings.get(result.away);
    home.matches++;
    away.matches++;
    home.goalsFor += result.homeGoals;
    home.goalsAgainst += result.awayGoals;
    away.goalsFor += result.awayGoals;
    away.goalsAgainst += result.homeGoals;
    if (result.homeGoals > result.awayGoals) {
      home.wins++;
      away.losses++;
    } else if (result.homeGoals < result.awayGoals) {
      away.wins++;
      home.losses++;
    } else {
      home.draws++;
      away.draws++;
    }
  }
  return standings;
}

test('verified backfill marks a scheduled fixture played and preserves its source', () => {
  const fixture = season.fixtures.find((match) => match.status === 'scheduled');
  const reconciled = mergeVerifiedResults(season, {
    ...backfill,
    results: [
      {
        round: fixture.round,
        home: fixture.home,
        away: fixture.away,
        homeGoals: 2,
        awayGoals: 1,
        source: {
          name: 'Fonte conferida',
          url: 'https://example.org/resultado',
          verifiedAt: '2026-10-10T12:00:00-03:00',
        },
      },
    ],
  });

  assert.equal(reconciled.fixtures.find((match) => match.id === fixture.id).status, 'played');
  assert.equal(reconciled.results.at(-1).source.name, 'Fonte conferida');
});

test('verified backfill rejects unlinked fixtures and insecure or missing provenance', () => {
  const fixture = season.fixtures.find((match) => match.status === 'scheduled');
  const result = {
    round: fixture.round,
    home: fixture.home,
    away: fixture.away,
    homeGoals: 1,
    awayGoals: 0,
    source: { name: 'Fonte', url: 'http://example.org', verifiedAt: '2026-10-10T12:00:00Z' },
  };
  assert.throws(() => mergeVerifiedResults(season, { ...backfill, results: [result] }), /HTTPS/);
  assert.throws(
    () =>
      mergeVerifiedResults(season, {
        ...backfill,
        results: [{ ...result, source: undefined }],
      }),
    /procedência/,
  );
  assert.throws(
    () =>
      mergeVerifiedResults(season, {
        ...backfill,
        results: [{ ...result, round: 39 }],
      }),
    /inválido/,
  );
});

test('history coverage identifies missing placers by club against the live totals', () => {
  const knownResults = season.results.slice(0, -1);
  const report = assessHistoryCoverage(knownResults, standingsFrom(season.results), season.teams);
  const missing = season.results.at(-1);

  assert.equal(report.status, 'incomplete');
  assert.equal(report.knownMatches, season.results.length - 1);
  assert.equal(report.expectedMatches, season.results.length);
  assert.equal(report.missingMatches, 1);
  assert.ok(report.clubs.some((club) => club.code === missing.home && club.missingMatches === 1));
  assert.ok(report.clubs.some((club) => club.code === missing.away && club.missingMatches === 1));
});

test('history coverage distinguishes conflicting totals from a simple missing match', () => {
  const changedResults = structuredClone(season.results);
  changedResults[0].homeGoals++;
  const report = assessHistoryCoverage(changedResults, standingsFrom(season.results), season.teams);

  assert.equal(report.status, 'inconsistent');
  assert.equal(report.missingMatches, 0);
  assert.ok(report.clubs.length > 0);
});
