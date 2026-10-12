// Desempenho de cada clube como mandante e como visitante, a partir dos
// resultados jogo a jogo. Com halfLifeRounds, jogos antigos pesam menos: um jogo
// de halfLifeRounds rodadas atrás vale metade de um jogo da rodada atual.

const emptySplit = () => ({ n: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 });

export function roundWeight(round, currentRound, halfLifeRounds) {
  if (!halfLifeRounds) return 1;
  return 0.5 ** (Math.max(0, currentRound - round) / halfLifeRounds);
}

// results: [{ round, home, away, homeGoals, awayGoals }]
// Retorna { splits: { [code]: { h, a } }, homeGoalsAverage, awayGoalsAverage }.
export function computeTeamSplits(results, teams, { halfLifeRounds = null, currentRound = null } = {}) {
  const latestRound = currentRound ?? Math.max(1, ...results.map((result) => result.round));
  const splits = Object.fromEntries(teams.map((code) => [code, { h: emptySplit(), a: emptySplit() }]));
  let weightSum = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const result of results) {
    if (!splits[result.home] || !splits[result.away]) continue;
    const weight = roundWeight(result.round, latestRound, halfLifeRounds);
    const add = (split, scored, conceded) => {
      split.n += weight;
      split.gf += scored * weight;
      split.ga += conceded * weight;
      if (scored > conceded) split.w += weight;
      else if (scored < conceded) split.l += weight;
      else split.d += weight;
    };
    add(splits[result.home].h, result.homeGoals, result.awayGoals);
    add(splits[result.away].a, result.awayGoals, result.homeGoals);
    weightSum += weight;
    homeGoals += result.homeGoals * weight;
    awayGoals += result.awayGoals * weight;
  }
  return {
    splits,
    homeGoalsAverage: weightSum ? homeGoals / weightSum : 1.4,
    awayGoalsAverage: weightSum ? awayGoals / weightSum : 1.1,
  };
}
