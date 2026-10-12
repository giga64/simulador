// Backtest do modelo: prevê cada rodada usando só os resultados anteriores a ela
// e compara configurações pelo Brier score (menor é melhor).
// Uso: npm run backtest
import { readFile } from 'node:fs/promises';
import { backtestModel } from '../src/model/backtest.js';

const season = JSON.parse(await readFile(new URL('../data/season-2026.json', import.meta.url), 'utf8'));
const teams = Object.keys(season.teams);
const rows = [];
for (const halfLifeRounds of [null, 6, 12, 20]) {
  for (const k of [6, 10, 14, 18, 25]) {
    const result = backtestModel(season.results, teams, { k, rho: -0.1, halfLifeRounds });
    rows.push({
      meiaVidaRodadas: halfLifeRounds ?? '—',
      k,
      brier: result.brier.toFixed(4),
      logLoss: result.logLoss.toFixed(4),
      acerto: `${(result.accuracy * 100).toFixed(1)}%`,
      jogos: result.matches,
    });
  }
}
rows.sort((a, b) => a.brier - b.brier);
console.table(rows);
const reference = backtestModel(season.results, teams, { k: 14, rho: -0.1 });
console.log(`Referência ingênua (frequência de casa/empate/fora): Brier ${reference.naiveBrier.toFixed(4)}`);
