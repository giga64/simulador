// Elo de clubes e modelo de gols das copas.
//
// Atualização (estilo World Football Elo): após cada jogo,
//   E = 1 / (1 + 10^(-(Rmandante + mando - Rvisitante) / 400))
//   R += K * G * (resultado - E)
// onde G aumenta com a diferença de gols (1; 1,5; (11 + N) / 8).
//
// Gols esperados a partir da diferença de força d = (Ra - Rb + mando?) / 400:
//   λa = exp(base + home + slope * d),  λb = exp(base - slope * d)
// base e home vêm do histórico das copas (openfootball, CC0); slope é ajustado
// nos jogos recentes (scripts/build-ratings.mjs).

export const DEFAULT_ELO = 1500;

export function goalFactor(goalDifference) {
  const n = Math.abs(goalDifference);
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  return (11 + n) / 8;
}

export function expectedScore(ratingA, ratingB, homeAdvantage = 0) {
  return 1 / (1 + 10 ** (-(ratingA + homeAdvantage - ratingB) / 400));
}

// Atualiza (por referência) o mapa de notas com um jogo de 90 minutos.
export function updateElo(ratings, match, { k, homeAdvantage, neutral = false }) {
  const home = ratings.get(match.home) ?? DEFAULT_ELO;
  const away = ratings.get(match.away) ?? DEFAULT_ELO;
  const expected = expectedScore(home, away, neutral ? 0 : homeAdvantage);
  const outcome = match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
  const change = k * goalFactor(match.homeGoals - match.awayGoals) * (outcome - expected);
  ratings.set(match.home, home + change);
  ratings.set(match.away, away - change);
  return expected;
}

export function expectedGoals(ratingA, ratingB, { base, home, slope }, { neutral = false } = {}) {
  const d = (ratingA - ratingB) / 400;
  return [Math.exp(base + (neutral ? 0 : home) + slope * d), Math.exp(base - slope * d)];
}

// Log-verossimilhança de Poisson (sem o termo constante log k!).
export function poissonLogLikelihood(goals, lambda) {
  return goals * Math.log(lambda) - lambda;
}
