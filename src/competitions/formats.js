// Formato de cada copa em 2026. Cada regra traz a fonte; o que não foi
// confirmado num texto oficial está marcado com `confirmed: false` e pode ser
// trocado aqui sem mexer no código da simulação.
//
// Fontes consultadas (imprensa; o PDF oficial não estava acessível):
// - CONMEBOL 2026: El Gráfico, "Guía rápida: las claves del Reglamento de la
//   CONMEBOL Libertadores 2026"; 24horas.cl (fim do gol fora de casa).
// - Copa do Brasil 2026: O Imparcial e Band (CBF divulga datas e formato).
// - Vagas na Libertadores 2027: CBF, via NetVasco e Soccerway.

export const COMPETITIONS = {
  libertadores: {
    id: 'libertadores',
    name: 'Libertadores',
    fullName: 'CONMEBOL Libertadores 2026',
    espnSlug: 'conmebol.libertadores',
    oddsKey: 'soccer_conmebol_copa_libertadores',
    theme: 'libertadores',
    stages: [
      { id: 'first-stage', name: 'Primeira fase', type: 'knockout', legs: 2 },
      { id: 'second-stage', name: 'Segunda fase', type: 'knockout', legs: 2 },
      { id: 'third-stage', name: 'Terceira fase', type: 'knockout', legs: 2 },
      { id: 'group-stage', name: 'Fase de grupos', type: 'groups', advance: 2 },
      { id: 'round-of-16', name: 'Oitavas de final', type: 'knockout', legs: 2 },
      { id: 'quarterfinals', name: 'Quartas de final', type: 'knockout', legs: 2 },
      { id: 'semifinals', name: 'Semifinal', type: 'knockout', legs: 2 },
      { id: 'final', name: 'Final', type: 'knockout', legs: 1, neutral: true, extraTime: true },
    ],
    rules: {
      awayGoals: { value: false, confirmed: true, note: 'Gol fora de casa abolido pela CONMEBOL desde 2021.' },
      extraTimeBeforePenalties: {
        value: 'final-only',
        confirmed: true,
        note: 'Empate no agregado vai direto aos pênaltis; prorrogação só na final.',
      },
      groupTiebreak: {
        value: ['points', 'headToHead', 'goalDifference', 'goalsFor'],
        confirmed: true,
        note: 'Desde 2026 o confronto direto vem antes do saldo geral.',
      },
      thirdPlace: {
        value: 'sudamericana-playoffs',
        confirmed: true,
        note: '3º do grupo vai aos playoffs da Sul-Americana.',
      },
      finalVenue: { value: 'Estadio Centenario, Montevidéu (28/11)', confirmed: true },
    },
  },
  sudamericana: {
    id: 'sudamericana',
    name: 'Sul-Americana',
    fullName: 'CONMEBOL Sul-Americana 2026',
    espnSlug: 'conmebol.sudamericana',
    oddsKey: 'soccer_conmebol_copa_sudamericana',
    theme: 'sudamericana',
    stages: [
      { id: 'first-stage', name: 'Primeira fase', type: 'knockout', legs: 1 },
      { id: 'group-stage', name: 'Fase de grupos', type: 'groups', advance: 1 },
      { id: 'knockout-round-playoffs', name: 'Playoffs', type: 'knockout', legs: 2 },
      { id: 'round-of-16', name: 'Oitavas de final', type: 'knockout', legs: 2 },
      { id: 'quarterfinals', name: 'Quartas de final', type: 'knockout', legs: 2 },
      { id: 'semifinals', name: 'Semifinal', type: 'knockout', legs: 2 },
      { id: 'final', name: 'Final', type: 'knockout', legs: 1, neutral: true, extraTime: true },
    ],
    rules: {
      awayGoals: { value: false, confirmed: true, note: 'Gol fora de casa abolido pela CONMEBOL desde 2021.' },
      extraTimeBeforePenalties: { value: 'final-only', confirmed: true },
      groupTiebreak: {
        value: ['points', 'headToHead', 'goalDifference', 'goalsFor'],
        confirmed: false,
        note: 'Assumido igual ao da Libertadores 2026; não conferido no texto da Sul-Americana.',
      },
    },
  },
  copaDoBrasil: {
    id: 'copaDoBrasil',
    name: 'Copa do Brasil',
    fullName: 'Copa do Brasil 2026',
    espnSlug: 'bra.copa_do_brazil',
    oddsKey: null,
    theme: 'copa-do-brasil',
    stages: [
      { id: 'first-round', name: '1ª fase', type: 'knockout', legs: 1 },
      { id: 'second-round', name: '2ª fase', type: 'knockout', legs: 1 },
      { id: 'third-round', name: '3ª fase', type: 'knockout', legs: 1 },
      { id: 'fourth-round', name: '4ª fase', type: 'knockout', legs: 1 },
      { id: 'fifth-round', name: '5ª fase', type: 'knockout', legs: 2 },
      { id: 'round-of-16', name: 'Oitavas de final', type: 'knockout', legs: 2 },
      { id: 'quarterfinals', name: 'Quartas de final', type: 'knockout', legs: 2 },
      { id: 'semifinals', name: 'Semifinal', type: 'knockout', legs: 2 },
      { id: 'final', name: 'Final', type: 'knockout', legs: 1, neutral: true, extraTime: false },
    ],
    rules: {
      awayGoals: { value: false, confirmed: true, note: 'Abolido na Copa do Brasil desde 2018.' },
      extraTimeBeforePenalties: {
        value: 'never',
        confirmed: false,
        note: 'Final em jogo único pela primeira vez (6/12, Mané Garrincha). As fontes não dizem se há prorrogação antes dos pênaltis; o padrão aqui é direto aos pênaltis. Troque a etapa "final" para extraTime: true se o regulamento disser o contrário.',
      },
      finalVenue: { value: 'Mané Garrincha, Brasília (6/12)', confirmed: true },
    },
  },
};

// Vagas do Brasil na Libertadores 2027 (CBF): 5 pelo Brasileirão (1º–4º grupos,
// 5º fase preliminar) e 2 pela Copa do Brasil (campeão grupos, vice
// preliminar). Vaga de quem já está classificado desce na tabela do
// Brasileirão. Campeões da Libertadores e da Sul-Americana ganham vaga extra.
export const LIBERTADORES_2027_SLOTS = {
  leagueSlots: 5,
  cupFinalists: true,
  continentalChampionsExtra: true,
  confirmed: true,
  note: 'Fonte: CBF, divulgado em 2026 (NetVasco, Soccerway). A exigência de estar na Série A no ano da competição não é simulada.',
};

export const COMPETITION_IDS = Object.keys(COMPETITIONS);

export function stageOf(competition, stageId) {
  return COMPETITIONS[competition]?.stages.find((stage) => stage.id === stageId) || null;
}

export function nextStage(competition, stageId) {
  const stages = COMPETITIONS[competition].stages;
  const index = stages.findIndex((stage) => stage.id === stageId);
  return index >= 0 ? stages[index + 1] || null : null;
}
