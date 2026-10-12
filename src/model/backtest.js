// Avaliação do modelo fora da amostra: prevê cada rodada usando só os
// resultados anteriores a ela e mede o erro das probabilidades casa/empate/fora.
import { expectedGoals } from './expected-goals.js';
import { scoreGrid } from './poisson.js';
import { computeTeamSplits } from './team-ratings.js';

export const outcomeOf = (result) =>
  result.homeGoals > result.awayGoals ? 0 : result.homeGoals === result.awayGoals ? 1 : 2;

const brier = (probabilities, outcome) =>
  probabilities.reduce((sum, p, index) => sum + (p - (index === outcome ? 1 : 0)) ** 2, 0);

// Brier e log-loss do modelo e de uma referência ingênua (frequência de
// casa/empate/fora das rodadas anteriores, sem olhar os clubes).
export function backtestModel(results, teams, { k, rho, ha = 1, halfLifeRounds = null, firstRound = 8 }) {
  const lastRound = Math.max(...results.map((result) => result.round));
  let modelBrier = 0;
  let naiveBrier = 0;
  let logLoss = 0;
  let hits = 0;
  let matches = 0;
  for (let round = firstRound; round <= lastRound; round++) {
    const known = results.filter((result) => result.round < round);
    if (!known.length) continue;
    const { splits, homeGoalsAverage, awayGoalsAverage } = computeTeamSplits(known, teams, {
      halfLifeRounds,
      currentRound: round,
    });
    const counts = [0, 0, 0];
    for (const result of known) counts[outcomeOf(result)]++;
    const naive = counts.map((count) => count / known.length);
    for (const result of results.filter((item) => item.round === round)) {
      const [lambdaHome, lambdaAway] = expectedGoals({
        home: result.home,
        away: result.away,
        settings: { k, ha, adj: {} },
        teamSplits: splits,
        homeGoalsAverage,
        awayGoalsAverage,
      });
      const grid = scoreGrid(lambdaHome, lambdaAway, rho);
      const probabilities = [grid.H, grid.D, grid.A];
      const outcome = outcomeOf(result);
      modelBrier += brier(probabilities, outcome);
      naiveBrier += brier(naive, outcome);
      logLoss -= Math.log(Math.max(probabilities[outcome], 1e-9));
      if (probabilities.indexOf(Math.max(...probabilities)) === outcome) hits++;
      matches++;
    }
  }
  return {
    matches,
    brier: matches ? modelBrier / matches : null,
    naiveBrier: matches ? naiveBrier / matches : null,
    logLoss: matches ? logLoss / matches : null,
    accuracy: matches ? hits / matches : null,
  };
}
