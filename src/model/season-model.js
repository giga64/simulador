// Modelo da temporada compartilhado entre o navegador e o servidor: a partir dos
// resultados, da classificação e dos palpites, monta a entrada do Monte Carlo e
// resume as chances de cada clube. O servidor usa o mesmo código para o
// histórico de chances, a imagem de compartilhamento e a comparação com o mercado.

import { expectedGoals } from './expected-goals.js';
import { cumulative, scoreGrid } from './poisson.js';
import { addHeadToHeadResult, emptyHeadToHead } from './standings.js';
import { remainingFraction } from './live-matches.js';
import { DEFAULT_ITERATIONS, histogramQuantile, runMonteCarlo } from './monte-carlo.js';
import { computeTeamSplits } from './team-ratings.js';

// k=14 teve o menor erro no backtest da temporada (scripts/backtest-model.mjs).
export const DEFAULT_SETTINGS = Object.freeze({ k: 14, ha: 1, rho: -0.1, seed: 20261010 });

// Pontos, jogos, vitórias... de cada clube: classificação da fonte quando
// existe, senão calculado dos resultados conhecidos.
export function baseStatsFrom(teams, results, standings = null) {
  const base = Object.fromEntries(teams.map((code) => [code, { P: 0, J: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0 }]));
  for (const result of results) {
    const home = base[result.home];
    const away = base[result.away];
    if (!home || !away) continue;
    home.J++;
    away.J++;
    home.GP += result.homeGoals;
    home.GC += result.awayGoals;
    away.GP += result.awayGoals;
    away.GC += result.homeGoals;
    if (result.homeGoals > result.awayGoals) {
      home.P += 3;
      home.V++;
      away.D++;
    } else if (result.homeGoals < result.awayGoals) {
      away.P += 3;
      away.V++;
      home.D++;
    } else {
      home.P++;
      away.P++;
      home.E++;
      away.E++;
    }
  }
  if (standings) {
    for (const [code, entry] of standings) {
      if (!base[code]) continue;
      base[code] = {
        P: entry.points,
        J: entry.matches,
        V: entry.wins,
        E: entry.draws,
        D: entry.losses,
        GP: entry.goalsFor,
        GC: entry.goalsAgainst,
      };
    }
  }
  return base;
}

// Jogos ainda sem resultado: da rodada atual em diante, mais os adiados.
export function openFixturesFrom(fixtures, currentRound = null) {
  return fixtures.filter(
    (fixture) =>
      fixture.status !== 'played' && (fixture.status === 'postponed' || !currentRound || fixture.round >= currentRound),
  );
}

// Gols esperados e distribuição de placares de cada confronto, com cache.
export function createMatchModel({ teams, results, standings = null, settings }) {
  const { splits, homeGoalsAverage, awayGoalsAverage } = computeTeamSplits(results, teams);
  const cache = new Map();
  const expected = (home, away) =>
    expectedGoals({ home, away, settings, standings, teamSplits: splits, homeGoalsAverage, awayGoalsAverage });
  return {
    splits,
    homeGoalsAverage,
    awayGoalsAverage,
    expected,
    grid(home, away) {
      const key = `${home}-${away}`;
      if (!cache.has(key)) {
        const [lambdaHome, lambdaAway] = expected(home, away);
        cache.set(key, scoreGrid(lambdaHome, lambdaAway, settings.rho));
      }
      return cache.get(key);
    },
    // Jogo em andamento: placar atual + gols do tempo que falta.
    remainingGrid(home, away, minute) {
      const [lambdaHome, lambdaAway] = expected(home, away);
      const fraction = remainingFraction(minute);
      return scoreGrid(lambdaHome * fraction, lambdaAway * fraction, 0);
    },
  };
}

export function cutPositionsFor(qualification, teamCount) {
  return [
    0,
    qualification.libertadoresLeaguePositions - 1,
    qualification.sudamericanaLeagueEnd - 1,
    teamCount - qualification.relegationPlaces,
  ];
}

// scores: Map fixtureId -> [mandante, visitante] (palpites e placares definidos).
// live: Map fixtureId -> { homeGoals, awayGoals, minute }. Com liveFromStart, os
// jogos ao vivo são simulados do zero (chance "antes do jogo").
export function buildSimulationInput({
  teams,
  base,
  results,
  openFixtures,
  scores = new Map(),
  live = new Map(),
  matchModel,
  settings,
  qualification,
  iterations = DEFAULT_ITERATIONS,
  isTracked = () => false,
  liveFromStart = false,
}) {
  const index = Object.fromEntries(teams.map((code, position) => [code, position]));
  const stats = Object.fromEntries(teams.map((code) => [code, { ...base[code] }]));
  const headToHead = emptyHeadToHead(teams);
  for (const result of results)
    addHeadToHeadResult(headToHead, result.home, result.away, result.homeGoals, result.awayGoals);
  const fixtures = [];
  const tracked = [];
  for (const fixture of openFixtures) {
    const score = live.has(fixture.id) ? null : scores.get(fixture.id);
    if (score) {
      const [x, y] = score;
      const home = stats[fixture.home];
      const away = stats[fixture.away];
      home.GP += x;
      home.GC += y;
      away.GP += y;
      away.GC += x;
      if (x > y) {
        home.P += 3;
        home.V++;
      } else if (x < y) {
        away.P += 3;
        away.V++;
      } else {
        home.P++;
        away.P++;
      }
      addHeadToHeadResult(headToHead, fixture.home, fixture.away, x, y);
      continue;
    }
    const liveMatch = liveFromStart ? null : live.get(fixture.id);
    const grid = liveMatch
      ? matchModel.remainingGrid(fixture.home, fixture.away, liveMatch.minute)
      : matchModel.grid(fixture.home, fixture.away);
    let track = -1;
    if (isTracked(fixture)) {
      track = tracked.length;
      tracked.push(fixture.id);
    }
    fixtures.push({
      home: index[fixture.home],
      away: index[fixture.away],
      size: grid.n,
      cumulative: cumulative(grid.g),
      baseHome: liveMatch?.homeGoals || 0,
      baseAway: liveMatch?.awayGoals || 0,
      track,
    });
  }
  return {
    index,
    tracked,
    input: {
      teamCount: teams.length,
      points: teams.map((code) => stats[code].P),
      wins: teams.map((code) => stats[code].V),
      goalDifference: teams.map((code) => stats[code].GP - stats[code].GC),
      goalsFor: teams.map((code) => stats[code].GP),
      headToHead: teams.map((code) => teams.map((other) => headToHead[code][other])),
      fixtures,
      cutPositions: cutPositionsFor(qualification, teams.length),
      relegationPlaces: qualification.relegationPlaces,
      iterations,
      seed: settings.seed,
      trackedCount: tracked.length,
    },
  };
}

// Chances em % por clube: título, faixa Libertadores, Sul-Americana, Z4,
// pontuação média e faixa de 10–90%.
export function summarizeChances(result, teams, qualification) {
  const { N, PC, PH } = result;
  const sum = (counts, first, last) => {
    let total = 0;
    for (let position = first; position <= last; position++) total += counts[position];
    return (total / N) * 100;
  };
  return Object.fromEntries(
    teams.map((code, team) => {
      const counts = PC[team];
      let mean = 0;
      PH[team].forEach((count, points) => (mean += count * points));
      return [
        code,
        {
          title: sum(counts, 0, 0),
          libertadores: sum(counts, 0, qualification.libertadoresLeaguePositions - 1),
          sudamericana: sum(counts, qualification.sudamericanaLeagueStart - 1, qualification.sudamericanaLeagueEnd - 1),
          relegation: sum(counts, teams.length - qualification.relegationPlaces, teams.length - 1),
          meanPoints: mean / N,
          low: histogramQuantile(PH[team], N, 0.1),
          high: histogramQuantile(PH[team], N, 0.9),
          positions: counts.map((count) => (count / N) * 100),
        },
      ];
    }),
  );
}

// Atalho para o servidor: simula a temporada sem palpites e devolve as chances.
export function simulateSeasonChances({
  seasonData,
  standings = null,
  currentRound = null,
  scores,
  live,
  settings = DEFAULT_SETTINGS,
  iterations = DEFAULT_ITERATIONS,
}) {
  const teams = Object.keys(seasonData.teams);
  const matchModel = createMatchModel({ teams, results: seasonData.results, standings, settings });
  const openFixtures = openFixturesFrom(seasonData.fixtures, currentRound);
  const { input } = buildSimulationInput({
    teams,
    base: baseStatsFrom(teams, seasonData.results, standings),
    results: seasonData.results,
    openFixtures,
    scores,
    live,
    matchModel,
    settings,
    qualification: seasonData.qualificationModel,
    iterations,
  });
  return {
    matchModel,
    openFixtures,
    chances: summarizeChances(runMonteCarlo(input), teams, seasonData.qualificationModel),
  };
}
