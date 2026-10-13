// Vagas do Brasil na Libertadores 2027, combinando, simulação a simulação, a
// classificação do Brasileirão com os campeões das copas (regras em formats.js).
import { LIBERTADORES_2027_SLOTS } from './formats.js';

// leagueOrders: para cada simulação, a lista de siglas do app na ordem final.
// cups: { libertadores, sudamericana, copaDoBrasil } com champions/runnersUp
// (ids da fonte) por simulação. toAppCode: id da fonte -> sigla (ou null).
export function libertadoresSlots({ leagueOrders, cups, toAppCode, rules = LIBERTADORES_2027_SLOTS }) {
  const iterations = leagueOrders.length;
  const qualifiedCount = {};
  const lastLeaguePosition = {};
  for (let iteration = 0; iteration < iterations; iteration++) {
    const qualified = new Set();
    let required = rules.leagueSlots + (rules.cupFinalists ? 2 : 0);
    if (rules.continentalChampionsExtra) {
      for (const cup of ['libertadores', 'sudamericana']) {
        const code = toAppCode(cups[cup]?.champions[iteration]);
        if (code) {
          qualified.add(code);
          required++;
        }
      }
    }
    if (rules.cupFinalists) {
      for (const id of [cups.copaDoBrasil?.champions[iteration], cups.copaDoBrasil?.runnersUp[iteration]]) {
        const code = toAppCode(id);
        // Finalista que não é da Série A ainda ocupa a vaga, mas fora da tabela do app.
        if (id) qualified.add(code || `ext:${id}`);
      }
    }
    // Vagas restantes descem na tabela do Brasileirão.
    let position = 0;
    const order = leagueOrders[iteration];
    while (qualified.size < required && position < order.length) qualified.add(order[position++]);
    lastLeaguePosition[position] = (lastLeaguePosition[position] || 0) + 1;
    for (const code of qualified) qualifiedCount[code] = (qualifiedCount[code] || 0) + 1;
  }
  return {
    iterations,
    chance: Object.fromEntries(
      Object.entries(qualifiedCount)
        .filter(([code]) => !code.startsWith('ext:'))
        .map(([code, count]) => [code, (count / iterations) * 100]),
    ),
    // Até que posição do Brasileirão a vaga chegou (G5, G6, G7...).
    cutoff: Object.fromEntries(
      Object.entries(lastLeaguePosition).map(([position, count]) => [position, (count / iterations) * 100]),
    ),
  };
}
