// "O que meu time precisa?": transforma os pontos de corte simulados (campeão, 5º, 17º colocado)
// em metas concretas para um clube, a partir da campanha atual.

export function percentileFromHistogram(histogram, total, quantile) {
  let accumulated = 0;
  for (let points = 0; points < histogram.length; points++) {
    accumulated += histogram[points];
    if (accumulated >= quantile * total) return points;
  }
  return 0;
}

/**
 * @param {object} input
 * @param {number} input.points        pontos atuais do clube (no cenário)
 * @param {number} input.played        jogos já disputados (no cenário)
 * @param {number} [input.totalGames]  jogos da temporada (38 na Série A)
 * @param {Array}  input.targets       [{ key, label, cutHistogram, simulations, extra?, chance }]
 *   cutHistogram: histograma (índice = pontos) da pontuação do clube que ocupa a posição-limite;
 *   extra: pontos somados ao corte (ex.: +1 para ficar ACIMA do primeiro rebaixado);
 *   chance: probabilidade (0–100) de o clube atingir o objetivo.
 */
export function buildClubNeeds({ points, played, totalGames = 38, targets }) {
  const remaining = Math.max(0, totalGames - played);
  const maxPoints = points + 3 * remaining;
  return targets.map(({ key, label, cutHistogram, simulations, extra = 0, chance = null }) => {
    const low = percentileFromHistogram(cutHistogram, simulations, 0.1) + extra;
    const typical = percentileFromHistogram(cutHistogram, simulations, 0.5) + extra;
    const high = percentileFromHistogram(cutHistogram, simulations, 0.9) + extra;
    const needed = Math.max(0, typical - points);
    const available = 3 * remaining;
    return {
      key,
      label,
      cut: typical,
      cutLow: low,
      cutHigh: high,
      needed,
      neededSafe: Math.max(0, high - points),
      winsEquivalent: Math.ceil(needed / 3),
      // parcela dos pontos que ainda restam disputar e que o clube precisa conquistar
      requiredShare: needed === 0 ? 0 : available === 0 ? null : (needed / available) * 100,
      reached: needed === 0,
      // fora de alcance: nem vencendo tudo chega ao corte mais baixo (percentil 10)
      outOfReach: maxPoints < low,
      reachable: maxPoints >= typical,
      chance,
      remaining,
      maxPoints,
    };
  });
}
