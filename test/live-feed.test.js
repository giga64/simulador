import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveFeedCache, normalizeLiveCompetition } from '../src/live-feed.js';

function makeCompetition() {
  return {
    competition: {
      code: 'a',
      season: 2026,
      source: { url: 'https://ge.globo.com/futebol/brasileirao-serie-a/' },
    },
    tables: [
      {
        entries: Array.from({ length: 20 }, (_, index) => ({
          position: index + 1,
          team: { shortName: `T${index}`, name: `Time ${index}` },
          points: 0,
          matches: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          goalDifference: 0,
          efficiency: 0,
          recentForm: [],
        })),
      },
    ],
    rounds: [
      {
        number: 30,
        total: 38,
        label: '30a rodada',
        matches: [
          {
            status: 'finished',
            homeTeam: { shortName: 'T0', name: 'Time 0' },
            awayTeam: { shortName: 'T1', name: 'Time 1' },
            score: { home: 2, away: 1 },
          },
        ],
      },
    ],
  };
}

test('live feed normalizes a full table and gives identical data a stable revision', () => {
  const source = makeCompetition();
  const first = normalizeLiveCompetition(source, '2026-10-10T12:00:00.000Z');
  const second = normalizeLiveCompetition(source, '2026-10-10T12:01:00.000Z');

  assert.equal(first.standings.length, 20);
  assert.equal(first.matches[0].status, 'finished');
  assert.equal(first.revision, second.revision);
});

test('live feed rejects invalid or non-GE sources', () => {
  const badStandings = makeCompetition();
  badStandings.tables[0].entries[0].points = 3;
  assert.throws(() => normalizeLiveCompetition(badStandings), /classificação contém dados inválidos/);

  const badSource = makeCompetition();
  badSource.competition.source.url = 'https://not-ge.globo.com/';
  assert.throws(() => normalizeLiveCompetition(badSource), /origem diferente/);
});

test('feed cache coalesces requests and returns an explicitly stale last-good response', async () => {
  let now = 0;
  let calls = 0;
  let unavailable = false;
  const read = createLiveFeedCache(
    async () => {
      calls++;
      if (unavailable) throw new Error('upstream offline');
      return { fetchedAt: new Date(now).toISOString(), revision: String(calls) };
    },
    { freshForMs: 100, staleForMs: 1_000, clock: () => now },
  );

  const [first, concurrent] = await Promise.all([read(), read()]);
  assert.equal(first.revision, concurrent.revision);
  assert.equal(calls, 1);

  now = 101;
  unavailable = true;
  const stale = await read();
  assert.equal(stale.stale, true);
  assert.match(stale.warning, /última consulta bem-sucedida/);
  assert.equal(calls, 2);
});
