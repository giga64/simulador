import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectLiveMatches,
  estimateMatchMinute,
  isHalfTime,
  remainingFraction,
  standingsWithoutLiveMatches,
} from '../src/model/live-matches.js';

const kickoff = '2026-10-12T16:00:00-03:00';
const at = (minutes) => Date.parse(kickoff) + minutes * 60_000;

test('estimateMatchMinute considera acréscimos e intervalo', () => {
  assert.equal(estimateMatchMinute(kickoff, at(-5)), 0);
  assert.equal(estimateMatchMinute(kickoff, at(20)), 20);
  assert.equal(estimateMatchMinute(kickoff, at(46)), 45);
  assert.equal(estimateMatchMinute(kickoff, at(55)), 45);
  assert.ok(isHalfTime(kickoff, at(55)));
  assert.equal(estimateMatchMinute(kickoff, at(62 + 30)), 75);
  assert.equal(estimateMatchMinute(kickoff, at(200)), 90);
  assert.equal(estimateMatchMinute('data inválida', at(10)), null);
});

test('remainingFraction nunca chega a zero', () => {
  assert.equal(remainingFraction(0), 1);
  assert.equal(remainingFraction(45), 0.5);
  assert.ok(remainingFraction(90) > 0);
});

const fixtures = [
  { id: 'r30-FLA-PAL', round: 30, home: 'FLA', away: 'PAL', status: 'scheduled', kickoff },
  { id: 'r30-SAO-COR', round: 30, home: 'SAO', away: 'COR', status: 'scheduled', kickoff },
];
const team = (shortName) => ({ shortName, name: shortName });

test('collectLiveMatches associa partidas ao vivo do feed ao calendário', () => {
  const feed = {
    matches: [
      { round: 30, status: 'live', homeTeam: team('FLA'), awayTeam: team('PAL'), score: { home: 1, away: 0 } },
      { round: 30, status: 'scheduled', homeTeam: team('SAO'), awayTeam: team('COR'), score: {} },
    ],
  };
  const live = collectLiveMatches(feed, fixtures, { now: at(30) });
  assert.equal(live.length, 1);
  assert.deepEqual(
    { id: live[0].fixtureId, home: live[0].homeGoals, away: live[0].awayGoals, minute: live[0].minute },
    { id: 'r30-FLA-PAL', home: 1, away: 0, minute: 30 },
  );
});

test('collectLiveMatches trata placar ausente como 0x0', () => {
  const feed = { matches: [{ round: 30, status: 'live', homeTeam: team('FLA'), awayTeam: team('PAL'), score: {} }] };
  const [match] = collectLiveMatches(feed, fixtures, { now: at(1) });
  assert.equal(match.homeGoals, 0);
  assert.equal(match.awayGoals, 0);
});

const entry = (code, position, values) => [
  code,
  { code, position, ...values, goalDifference: values.goalsFor - values.goalsAgainst },
];

test('standingsWithoutLiveMatches desconta o placar parcial quando a tabela já o inclui', () => {
  const standings = new Map([
    entry('FLA', 1, { matches: 30, points: 60, wins: 18, draws: 6, losses: 6, goalsFor: 50, goalsAgainst: 25 }),
    entry('PAL', 2, { matches: 30, points: 58, wins: 17, draws: 7, losses: 6, goalsFor: 45, goalsAgainst: 24 }),
  ]);
  const live = [{ fixtureId: 'x', home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 0 }];
  const { standings: adjusted, includedLive } = standingsWithoutLiveMatches(standings, live, { FLA: 29, PAL: 29 });
  assert.deepEqual(includedLive, ['x']);
  assert.deepEqual(
    [adjusted.get('FLA').points, adjusted.get('FLA').matches, adjusted.get('FLA').goalsFor],
    [57, 29, 49],
  );
  assert.deepEqual([adjusted.get('PAL').losses, adjusted.get('PAL').goalsAgainst], [5, 23]);
  assert.equal(adjusted.get('FLA').goalDifference, adjusted.get('FLA').goalsFor - adjusted.get('FLA').goalsAgainst);
  assert.equal(adjusted.get('PAL').position, 1, 'sem o jogo em andamento o Palmeiras liderava');
});

test('standingsWithoutLiveMatches não mexe na tabela que ainda não conta o jogo', () => {
  const standings = new Map([
    entry('FLA', 1, { matches: 29, points: 57, wins: 17, draws: 6, losses: 6, goalsFor: 49, goalsAgainst: 25 }),
    entry('PAL', 2, { matches: 29, points: 58, wins: 17, draws: 7, losses: 5, goalsFor: 45, goalsAgainst: 23 }),
  ]);
  const live = [{ fixtureId: 'x', home: 'FLA', away: 'PAL', homeGoals: 1, awayGoals: 0 }];
  const result = standingsWithoutLiveMatches(standings, live, { FLA: 29, PAL: 29 });
  assert.deepEqual(result.includedLive, []);
  assert.equal(result.standings.get('FLA').points, 57);
});

test('collectLiveMatches aceita siglas diferentes do calendário (RBB = BRA)', async () => {
  const { createTeamCodeResolver } = await import('../src/live-season.js');
  const resolveTeam = createTeamCodeResolver({ BRA: 'Red Bull Bragantino', CRU: 'Cruzeiro' });
  const feed = {
    matches: [
      {
        round: 30,
        status: 'live',
        homeTeam: { shortName: 'RBB', name: 'Bragantino' },
        awayTeam: { shortName: 'CRU', name: 'Cruzeiro' },
        score: { home: 0, away: 1 },
      },
    ],
  };
  const calendar = [{ id: 'r30-BRA-CRU', round: 30, home: 'BRA', away: 'CRU', status: 'scheduled', kickoff }];
  const [match] = collectLiveMatches(feed, calendar, { now: at(10), resolveTeam });
  assert.equal(match?.fixtureId, 'r30-BRA-CRU');
});
