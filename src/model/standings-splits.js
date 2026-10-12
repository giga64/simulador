// Classificações por recorte, calculadas só com os placares conhecidos.

export const SPLIT_MODES = [
  ['all', 'Geral'],
  ['home', 'Somente como mandante'],
  ['away', 'Somente como visitante'],
  ['last5', 'Últimos 5 jogos'],
  ['last10', 'Últimos 10 jogos'],
];

export function buildSplitTable(results, teamCodes, mode = 'all') {
  const games = Object.fromEntries(teamCodes.map((code) => [code, []]));
  const ordered = [...results].sort((a, b) => a.round - b.round);
  for (const { round, home, away, homeGoals, awayGoals } of ordered) {
    if (games[home]) games[home].push({ round, gf: homeGoals, ga: awayGoals, venue: 'home' });
    if (games[away]) games[away].push({ round, gf: awayGoals, ga: homeGoals, venue: 'away' });
  }
  const lastCount = /^last(\d+)$/.exec(mode)?.[1];
  const rows = teamCodes.map((code, index) => {
    let list = games[code];
    if (mode === 'home' || mode === 'away') list = list.filter((game) => game.venue === mode);
    if (lastCount) list = list.slice(-Number(lastCount));
    const row = { code, order: index, P: 0, J: list.length, V: 0, E: 0, D: 0, GP: 0, GC: 0 };
    for (const { gf, ga } of list) {
      row.GP += gf;
      row.GC += ga;
      if (gf > ga) {
        row.V++;
        row.P += 3;
      } else if (gf === ga) {
        row.E++;
        row.P++;
      } else row.D++;
    }
    row.SG = row.GP - row.GC;
    row.rate = row.J ? (row.P / (3 * row.J)) * 100 : null;
    return row;
  });
  // Pontos, vitórias, saldo, gols pró; empate residual mantém a ordem original (não é critério oficial).
  rows.sort((a, b) => b.P - a.P || b.V - a.V || b.SG - a.SG || b.GP - a.GP || a.order - b.order);
  return rows.map((row, index) => ({ ...row, position: index + 1 }));
}
