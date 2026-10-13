// Esquema único das copas, independente da fonte.
//
// Competition {
//   id, name, season, source: { name, url }, fetchedAt,
//   currentStage: id da fase em andamento (ou null se acabou),
//   champion: id do clube campeão ou null,
//   teams: { [teamId]: { id, name, shortName, abbreviation, location, logo } },
//   groups: [{ id, name, table: [GroupRow] }],
//   stages: [{ id, name, type: 'groups'|'knockout', legs, ties: [Tie] }],
// }
// GroupRow { teamId, rank, played, wins, draws, losses, goalsFor, goalsAgainst, goalDifference, points, note }
// Tie {
//   id, stage, teams: [idA|null, idB|null],   // null = vaga ainda indefinida
//   legs: [Leg], aggregate: [golsA, golsB] | null,
//   winner: teamId|null, decidedBy: 'aggregate'|'penalties'|'single-match'|null,
// }
// Leg { id, date, home, away, homeGoals, awayGoals, state: 'pre'|'in'|'post',
//       clock, penalties: { home, away } | null, venue }

export const PLACEHOLDER = null;

export function emptyCompetition({ id, name, season }) {
  return {
    id,
    name,
    season,
    source: null,
    fetchedAt: null,
    currentStage: null,
    champion: null,
    teams: {},
    groups: [],
    stages: [],
  };
}

const isInteger = (value) => Number.isInteger(value) && value >= 0 && value <= 30;

// Validação defensiva: o dado vem de uma API externa.
export function validateCompetition(competition) {
  const errors = [];
  if (!competition || typeof competition.id !== 'string') return ['Competição sem identificador.'];
  const teamIds = new Set(Object.keys(competition.teams || {}));
  for (const stage of competition.stages || []) {
    for (const tie of stage.ties || []) {
      for (const team of tie.teams) if (team !== null && !teamIds.has(team)) errors.push(`Clube desconhecido ${team}.`);
      for (const leg of tie.legs) {
        if (leg.state !== 'pre' && (!isInteger(leg.homeGoals) || !isInteger(leg.awayGoals))) {
          errors.push(`Placar inválido no jogo ${leg.id}.`);
        }
      }
    }
  }
  for (const group of competition.groups || []) {
    for (const row of group.table)
      if (!teamIds.has(row.teamId)) errors.push(`Clube desconhecido ${row.teamId} no ${group.name}.`);
  }
  return errors;
}
