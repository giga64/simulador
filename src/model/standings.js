// Classificação: pontos, vitórias, saldo, gols pró e confronto direto quando
// exatamente dois clubes continuam empatados nesses critérios.

export function emptyHeadToHead(teams) {
  return Object.fromEntries(teams.map((team) => [team, Object.fromEntries(teams.map((other) => [other, 0]))]));
}

// table[a][b] = pontos que a fez contra b.
export function addHeadToHeadResult(table, home, away, homeGoals, awayGoals) {
  if (homeGoals > awayGoals) table[home][away] += 3;
  else if (homeGoals < awayGoals) table[away][home] += 3;
  else {
    table[home][away]++;
    table[away][home]++;
  }
}

export function applyPairwiseTieBreak(order, sameGroup, comparePair) {
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && sameGroup(order[start], order[end])) end++;
    if (end - start === 2 && comparePair(order[start], order[start + 1]) > 0) {
      [order[start], order[start + 1]] = [order[start + 1], order[start]];
    }
    start = end;
  }
  return order;
}

const goalDifference = (entry) => entry.GP - entry.GC;

function primaryTie(stats, a, b) {
  return (
    stats[a].P === stats[b].P &&
    stats[a].V === stats[b].V &&
    goalDifference(stats[a]) === goalDifference(stats[b]) &&
    stats[a].GP === stats[b].GP
  );
}

// stats[code] = { P, V, GP, GC, ... }. officialStandings (Map) serve para usar a
// ordem publicada quando os números são idênticos aos da fonte, e como último
// critério estável.
export function rankTeams(stats, teams, { officialStandings = null, headToHead = null } = {}) {
  if (
    officialStandings &&
    teams.every((code) => {
      const entry = officialStandings.get(code);
      return (
        stats[code].P === entry.points &&
        stats[code].V === entry.wins &&
        stats[code].GP === entry.goalsFor &&
        stats[code].GC === entry.goalsAgainst
      );
    })
  ) {
    return teams.slice().sort((a, b) => officialStandings.get(a).position - officialStandings.get(b).position);
  }
  const officialPosition = (code) => officialStandings?.get(code)?.position ?? 99;
  const ordered = teams
    .slice()
    .sort(
      (a, b) =>
        stats[b].P - stats[a].P ||
        stats[b].V - stats[a].V ||
        goalDifference(stats[b]) - goalDifference(stats[a]) ||
        stats[b].GP - stats[a].GP ||
        officialPosition(a) - officialPosition(b),
    );
  if (!headToHead) return ordered;
  return applyPairwiseTieBreak(
    ordered,
    (a, b) => primaryTie(stats, a, b),
    (a, b) => headToHead[b][a] - headToHead[a][b],
  );
}
