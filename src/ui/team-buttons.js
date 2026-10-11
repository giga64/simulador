// Botões de clube que se repetiam copiados em vários pontos do app.js.
// lg(code) devolve o escudo; NM é o mapa sigla -> nome; escapeHtml protege o nome.
export function createTeamButtons({ lg, NM, escapeHtml }) {
  return {
    // Abre o clube e leva ao simulador (abas Corrida etc.).
    teamSimButton: (code) =>
      `<button class="tn team-link" data-act="team-and-sim" data-team="${code}" aria-label="Ver detalhes de ${NM[code]}">${lg(code)}${NM[code]}</button>`,
    // Abre a página do clube.
    clubButton: (code) =>
      `<button class="tn" data-act="open-club" data-team="${code}">${lg(code)}${escapeHtml(NM[code])}</button>`,
  };
}
