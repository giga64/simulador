import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mergeLiveSeason } from '../src/live-season.js';

const season = JSON.parse(await readFile(
  new URL('../data/season-2026.json', import.meta.url),
  'utf8',
));

function makeLiveFeed(round) {
  return {
    season: 2026,
    round: { number: round, total: 38, label: `${round}a rodada` },
    standings: Object.entries(season.teams).map(([teamCode, name], index) => ({
      teamCode,
      name,
      position: index + 1,
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
    matches: [],
  };
}

test('finished current-round scores update the calendar, while live scores remain provisional', () => {
  const fixture = season.fixtures.find((item) => item.status === 'scheduled');
  const feed = makeLiveFeed(fixture.round);
  feed.matches = [
    {
      round: fixture.round,
      status: 'finished',
      homeTeam: { shortName: fixture.home, name: season.teams[fixture.home] },
      awayTeam: { shortName: fixture.away, name: season.teams[fixture.away] },
      score: { home: 2, away: 1 },
    },
    {
      round: fixture.round,
      status: 'live',
      homeTeam: { shortName: fixture.home, name: season.teams[fixture.home] },
      awayTeam: { shortName: 'OTHER', name: 'Outro clube' },
      score: { home: 1, away: 0 },
    },
  ];

  const merged = mergeLiveSeason(season, feed);
  assert.equal(merged.seasonData.fixtures.find((item) => item.id === fixture.id).status, 'played');
  assert.deepEqual(merged.seasonData.results.at(-1), {
    round: fixture.round,
    home: fixture.home,
    away: fixture.away,
    homeGoals: 2,
    awayGoals: 1,
  });
  assert.ok(merged.warnings.some((warning) => warning.includes('não pôde ser associada')));
});

test('live standings must map uniquely to every local club', () => {
  const feed = makeLiveFeed(30);
  feed.standings[1] = { ...feed.standings[1], teamCode: feed.standings[0].teamCode };
  assert.throws(() => mergeLiveSeason(season, feed), /associar todos os clubes/);
});

test('persisted results from earlier rounds are merged after the live round advances', () => {
  const fixture = season.fixtures.find((item) => item.round === 30 && item.status === 'scheduled');
  const feed = makeLiveFeed(31);
  feed.history = [{
    round: 30,
    status: 'finished',
    homeTeam: { shortName: fixture.home, name: season.teams[fixture.home] },
    awayTeam: { shortName: fixture.away, name: season.teams[fixture.away] },
    score: { home: 1, away: 0 },
  }];

  const merged = mergeLiveSeason(season, feed);
  assert.equal(merged.seasonData.fixtures.find((item) => item.id === fixture.id).status, 'played');
  assert.ok(merged.seasonData.results.some((item) => item.round === 30
    && item.home === fixture.home && item.homeGoals === 1));
});

test('a current feed never overwrites a result already present in the versioned snapshot', () => {
  const existing = season.results[0];
  const fixture = season.fixtures.find((item) => item.round === existing.round
    && item.home === existing.home && item.away === existing.away);
  const feed = makeLiveFeed(30);
  feed.history = [{
    round: existing.round,
    status: 'finished',
    homeTeam: { shortName: fixture.home, name: season.teams[fixture.home] },
    awayTeam: { shortName: fixture.away, name: season.teams[fixture.away] },
    score: { home: existing.homeGoals + 1, away: existing.awayGoals },
  }];

  const merged = mergeLiveSeason(season, feed);
  assert.deepEqual(
    merged.seasonData.results.find((item) => item.round === existing.round
      && item.home === existing.home && item.away === existing.away),
    existing,
  );
});

test('naive Brazilian kickoff times are interpreted as Brasília time', () => {
  const fixture = season.fixtures.find((item) => item.status === 'scheduled');
  const feed = makeLiveFeed(fixture.round);
  feed.matches = [{
    round: fixture.round,
    status: 'scheduled',
    dateTime: '2026-10-10T18:00',
    homeTeam: { shortName: fixture.home, name: season.teams[fixture.home] },
    awayTeam: { shortName: fixture.away, name: season.teams[fixture.away] },
    score: { home: null, away: null },
  }];

  const merged = mergeLiveSeason(season, feed);
  assert.equal(
    merged.seasonData.fixtures.find((item) => item.id === fixture.id).kickoff,
    '2026-10-10T18:00-03:00',
  );
});
