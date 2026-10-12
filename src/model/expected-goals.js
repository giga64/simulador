// Gols esperados de cada lado. Ataque e defesa de cada clube são relativos à
// média da liga e "encolhidos" para a média com k jogos fictícios (settings.k).

export function expectedGoals({
  home,
  away,
  settings,
  standings = null,
  teamSplits = null,
  homeGoalsAverage,
  awayGoalsAverage,
}) {
  const k = settings.k;
  let lambdaHome;
  let lambdaAway;
  if (standings) {
    // O feed só tem totais por clube; a divisão mandante/visitante vem do histórico.
    const entries = [...standings.values()];
    const played = entries.reduce((sum, entry) => sum + entry.matches, 0);
    const average = entries.reduce((sum, entry) => sum + entry.goalsFor, 0) / (played || 1);
    const homeShare = homeGoalsAverage / (homeGoalsAverage + awayGoalsAverage);
    const rate = (goals, matches) => (goals + k * average) / (matches + k) / average;
    const homeEntry = standings.get(home);
    const awayEntry = standings.get(away);
    const homeAttack = rate(homeEntry.goalsFor, homeEntry.matches);
    const homeDefense = rate(homeEntry.goalsAgainst, homeEntry.matches);
    const awayAttack = rate(awayEntry.goalsFor, awayEntry.matches);
    const awayDefense = rate(awayEntry.goalsAgainst, awayEntry.matches);
    lambdaHome = 2 * average * homeShare * homeAttack * awayDefense * settings.ha;
    lambdaAway = (2 * average * (1 - homeShare) * awayAttack * homeDefense) / settings.ha;
  } else {
    const homeSplit = teamSplits[home].h;
    const awaySplit = teamSplits[away].a;
    const homeAttack = (homeSplit.gf + k * homeGoalsAverage) / ((homeSplit.n + k) * homeGoalsAverage);
    const awayDefense = (awaySplit.ga + k * homeGoalsAverage) / ((awaySplit.n + k) * homeGoalsAverage);
    const awayAttack = (awaySplit.gf + k * awayGoalsAverage) / ((awaySplit.n + k) * awayGoalsAverage);
    const homeDefense = (homeSplit.ga + k * awayGoalsAverage) / ((homeSplit.n + k) * awayGoalsAverage);
    lambdaHome = homeGoalsAverage * homeAttack * awayDefense * settings.ha;
    lambdaAway = (awayGoalsAverage * awayAttack * homeDefense) / settings.ha;
  }
  // Ajuste manual de força (lesões, fase, técnico novo...).
  const homeStrength = 1 + (settings.adj?.[home] || 0) / 100;
  const awayStrength = 1 + (settings.adj?.[away] || 0) / 100;
  return [(lambdaHome * homeStrength) / Math.sqrt(awayStrength), (lambdaAway * awayStrength) / Math.sqrt(homeStrength)];
}
