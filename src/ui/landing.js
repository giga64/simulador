// Prévia da classificação exibida na landing (dados reais, preenchidos pelo app.js).
export function renderLandingPreview({ rows, nextMatch, dataLabel, logo, nameOf, escape }) {
  const body = rows
    .map(
      (row) =>
        `<li><span class="lp-pos">${row.position}</span>${logo(row.code)}<span class="lp-name">${escape(nameOf(row.code))}</span><b>${row.points}</b><span class="mu">pts</span></li>`,
    )
    .join('');
  const next = nextMatch
    ? `<div class="lp-next"><span class="lp-label">Próximo jogo</span><b>${escape(nextMatch.title)}</b><span class="mu">${escape(nextMatch.when)}</span></div>`
    : '';
  return `<div class="lp-card"><div class="lp-head"><h2>Classificação agora</h2><span class="data-chip">${escape(dataLabel)}</span></div><ol class="lp-table">${body}</ol>${next}</div>`;
}
