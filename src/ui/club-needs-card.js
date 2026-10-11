// Cartão "O que o clube precisa?". Recebe as linhas de buildClubNeeds e devolve HTML.
const tag = (kind, text) => `<span class="tag ${kind}">${text}</span>`;

function missingCell(row) {
  if (row.reached) return tag('g', 'Já atingiu o corte');
  if (row.outOfReach) return tag('r', 'Fora de alcance');
  const wins = `<span class="mu">(≈ ${row.winsEquivalent} ${row.winsEquivalent === 1 ? 'vitória' : 'vitórias'})</span>`;
  const hard = row.reachable ? '' : ' <span class="mu">só no cenário mais favorável</span>';
  return `<b>${row.needed} ${row.needed === 1 ? 'pt' : 'pts'}</b> ${wins}${hard}`;
}

function shareCell(row) {
  if (row.reached) return '–';
  if (row.requiredShare == null) return '–';
  return row.requiredShare > 100 ? '&gt;100%' : `${Math.round(row.requiredShare)}%`;
}

export function renderClubNeedsCard({ clubName, rows, simulations, formatPercent }) {
  if (!rows.length) return '';
  const { remaining, maxPoints } = rows[0];
  const body = rows
    .map(
      (row) =>
        `<tr><td class="l">${row.label}</td><td>${row.cut} <span class="mu">(${row.cutLow}–${row.cutHigh})</span></td><td class="l">${missingCell(row)}</td><td>${shareCell(row)}</td><td>${row.chance == null ? '–' : formatPercent(row.chance)}</td></tr>`,
    )
    .join('');
  return `<div class="cd club-needs"><h2>O que o ${clubName} precisa?</h2><p class="mu sm">Restam ${remaining} ${remaining === 1 ? 'jogo' : 'jogos'} (até ${maxPoints} pontos possíveis). Os cortes vêm de ${simulations.toLocaleString('pt-BR')} simulações reproduzíveis dos jogos em branco, a partir do cenário atual.</p><div class="sc"><table><thead><tr><th class="l">Objetivo</th><th>Pontos de corte típicos <span class="mu">(10–90%)</span></th><th class="l">Faltam</th><th>% dos pontos restantes</th><th>Chance</th></tr></thead><tbody>${body}</tbody></table></div><p class="mu sm">Corte típico = mediana dos pontos de quem ocupa a posição-limite do objetivo nas simulações; para escapar do rebaixamento, soma-se 1 ponto ao primeiro rebaixado. Empates em pontos dependem dos critérios de desempate. Estimativa do modelo, não previsão oficial.</p></div>`;
}
