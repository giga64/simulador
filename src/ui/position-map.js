// Mapa de posições finais: clube x posição, com a probabilidade (%) de terminar em cada colocação.
const cellText = (percent) => (percent >= 1 ? String(Math.round(percent)) : percent >= 0.5 ? '&lt;1' : '');
const cellAlpha = (percent) => (percent < 0.5 ? 0 : Math.min(0.9, 0.12 + (percent / 100) * 1.1));

/**
 * @param {string[]} order           clubes na ordem em que as linhas aparecem
 * @param {(code: string) => number[] | null} positionsOf  % de terminar em cada posição (índice 0 = 1º)
 * @param {(index: number) => 'g'|'b'|'r'|'n'} zoneOf       faixa da posição (índice 0 = 1º)
 */
export function renderPositionMap({ order, positionsOf, zoneOf, renderTeam, highlight, positions, nameOf }) {
  const header = Array.from({ length: positions }, (_, i) => `<th class="z${zoneOf(i)}">${i + 1}º</th>`).join('');
  const body = order
    .map((code) => {
      const percents = positionsOf(code);
      if (!percents) return '';
      const cells = percents
        .map(
          (p, i) =>
            `<td class="cell z${zoneOf(i)}" style="--a:${cellAlpha(p).toFixed(2)}" title="${nameOf(code)}: ${p.toFixed(1).replace('.', ',')}% de terminar em ${i + 1}º">${cellText(p)}</td>`,
        )
        .join('');
      return `<tr class="${code === highlight ? 'hl' : ''}"><td class="club l">${renderTeam(code)}</td>${cells}</tr>`;
    })
    .join('');
  return `<div class="cd position-map"><h2>Mapa de posições finais</h2><p class="mu sm">Probabilidade (%) de cada clube terminar em cada colocação, em 1.200 simulações reproduzíveis do cenário atual. Quanto mais forte a cor, maior a chance. Verde: vaga na Libertadores · azul: Sul-Americana · vermelho: rebaixamento. Células vazias têm chance menor que 0,5%.</p><div class="sc"><table class="pmap" aria-label="Probabilidade de cada clube terminar em cada posição"><thead><tr><th class="club l">Clube</th>${header}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
