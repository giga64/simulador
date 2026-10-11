// Cartão "Classificação por recorte" (geral, mandante, visitante, últimos 5/10 jogos).
export function renderSplitsCard({ rows, mode, modes, renderTeam, note, formatSigned }) {
  const options = modes
    .map(([value, label]) => `<option value="${value}" ${value === mode ? 'selected' : ''}>${label}</option>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr><td>${row.position}º</td><td class="l">${renderTeam(row.code)}</td><td class="n">${row.P}</td><td>${row.J}</td><td>${row.V}</td><td>${row.E}</td><td>${row.D}</td><td>${row.GP}</td><td>${row.GC}</td><td>${formatSigned(row.SG)}</td><td>${row.rate == null ? '–' : `${Math.round(row.rate)}%`}</td></tr>`,
    )
    .join('');
  return `<div class="cd splits-card"><h2>Classificação por recorte</h2><div class="row"><label for="splitMode">Recorte:</label> <select id="splitMode" data-change="split-mode">${options}</select></div><div class="sc"><table><thead><tr><th>#</th><th class="l">Clube</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th><th>%</th></tr></thead><tbody>${body}</tbody></table></div><p class="mu sm">${note}</p></div>`;
}
