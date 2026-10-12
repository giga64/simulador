const CLUBS_PER_LEAGUE = 20;
const ROUNDS = 38;
const FIXTURES_PER_ROUND = 10;
const MATCHES_PER_CLUB = 38;
const MATCHES_PER_VENUE = 19;

export function validateSeasonData(data, logoData) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  if (!data || data.schemaVersion !== 1 || data.season !== 2026) {
    return { errors: ['Versão ou temporada do arquivo de dados inválida.'], warnings };
  }

  const teams = data.teams;
  const fixtures = data.fixtures;
  const results = data.results;
  const teamCodes = teams && Object.keys(teams);

  if (!teamCodes || teamCodes.length !== CLUBS_PER_LEAGUE) {
    fail(`A temporada deve ter ${CLUBS_PER_LEAGUE} clubes.`);
  }
  if (!Array.isArray(fixtures) || fixtures.length !== (CLUBS_PER_LEAGUE * MATCHES_PER_CLUB) / 2) {
    fail('O calendário deve conter 380 partidas.');
  }
  if (!Array.isArray(results)) {
    fail('A lista de resultados precisa ser uma lista.');
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(data.source?.url);
  } catch {
    fail('A fonte dos dados precisa ter um endereço HTTPS válido.');
  }
  if (!sourceUrl || sourceUrl.protocol !== 'https:') {
    fail('A fonte dos dados precisa ter um endereço HTTPS.');
  }
  if (!Number.isFinite(Date.parse(data.updatedAt))) {
    fail('A data de atualização dos dados é inválida.');
  }
  const qualification = data.qualificationModel;
  if (
    !qualification ||
    !Number.isInteger(qualification.libertadoresLeaguePositions) ||
    qualification.libertadoresLeaguePositions < 1 ||
    !Number.isInteger(qualification.sudamericanaLeagueStart) ||
    !Number.isInteger(qualification.sudamericanaLeagueEnd) ||
    qualification.sudamericanaLeagueStart < 1 ||
    qualification.sudamericanaLeagueEnd < qualification.sudamericanaLeagueStart ||
    qualification.libertadoresLeaguePositions >= qualification.sudamericanaLeagueStart ||
    qualification.libertadoresLeaguePositions > CLUBS_PER_LEAGUE ||
    qualification.sudamericanaLeagueStart > CLUBS_PER_LEAGUE ||
    qualification.sudamericanaLeagueEnd >= CLUBS_PER_LEAGUE - qualification.relegationPlaces + 1 ||
    !Number.isInteger(qualification.relegationPlaces) ||
    qualification.relegationPlaces < 1 ||
    qualification.relegationPlaces >= CLUBS_PER_LEAGUE
  ) {
    fail('As faixas de classificação e rebaixamento são inválidas.');
  }
  if (!logoData?.logos || Object.keys(logoData.logos).length !== CLUBS_PER_LEAGUE) {
    fail('O arquivo de escudos está incompleto.');
  }

  if (errors.length) return { errors, warnings };

  const codes = new Set(teamCodes);
  for (const code of teamCodes) {
    const logo = logoData.logos[code];
    if (
      typeof logo !== 'string' ||
      !(logo.startsWith('data:image/') || /^assets\/escudos\/[A-Z]{3}\.(webp|png|svg)$/.test(logo))
    ) {
      fail(`O escudo de ${teams[code]} está ausente ou inválido.`);
    }
  }
  const fixtureIds = new Set();
  const fixtureKeys = new Set();
  const clubPairs = new Set();
  const fixturesByRound = Array(ROUNDS).fill(0);
  const clubGames = Object.fromEntries(teamCodes.map((code) => [code, { home: 0, away: 0 }]));
  const fixturesByKey = new Map();

  for (const fixture of fixtures) {
    if (!fixture || typeof fixture.id !== 'string' || fixtureIds.has(fixture.id)) {
      fail('Há identificadores de partidas ausentes ou duplicados.');
      continue;
    }
    fixtureIds.add(fixture.id);

    if (!codes.has(fixture.home) || !codes.has(fixture.away) || fixture.home === fixture.away) {
      fail(`Partida ${fixture.id}: clubes inválidos.`);
      continue;
    }
    if (!Number.isInteger(fixture.round) || fixture.round < 1 || fixture.round > ROUNDS) {
      fail(`Partida ${fixture.id}: rodada inválida.`);
      continue;
    }
    if (!['played', 'scheduled', 'postponed'].includes(fixture.status)) {
      fail(`Partida ${fixture.id}: situação inválida.`);
      continue;
    }

    const key = `${fixture.round}:${fixture.home}:${fixture.away}`;
    const pair = `${fixture.home}:${fixture.away}`;
    if (fixtureKeys.has(key)) fail(`Partida duplicada: ${key}.`);
    if (clubPairs.has(pair)) fail(`Confronto mandante/visitante duplicado: ${pair}.`);
    fixtureKeys.add(key);
    clubPairs.add(pair);
    fixturesByKey.set(key, fixture);
    fixturesByRound[fixture.round - 1]++;
    clubGames[fixture.home].home++;
    clubGames[fixture.away].away++;

    if (fixture.status === 'scheduled' && !Number.isFinite(Date.parse(fixture.kickoff))) {
      fail(`Partida ${fixture.id}: horário ausente ou inválido.`);
    }
    if (fixture.status === 'postponed' && fixture.kickoff !== null) {
      fail(`Partida ${fixture.id}: jogo adiado não pode ter horário confirmado.`);
    }
  }

  for (const [index, count] of fixturesByRound.entries()) {
    if (count !== FIXTURES_PER_ROUND) {
      fail(`A rodada ${index + 1} tem ${count} partidas; deveria ter ${FIXTURES_PER_ROUND}.`);
    }
  }
  for (const [code, count] of Object.entries(clubGames)) {
    if (count.home !== MATCHES_PER_VENUE || count.away !== MATCHES_PER_VENUE) {
      fail(`${teams[code]} não tem 19 jogos como mandante e 19 como visitante.`);
    }
  }

  const resultKeys = new Set();
  for (const result of results) {
    const key = `${result.round}:${result.home}:${result.away}`;
    if (resultKeys.has(key)) {
      fail(`Resultado duplicado: ${key}.`);
      continue;
    }
    resultKeys.add(key);
    const fixture = fixturesByKey.get(key);
    if (!fixture) {
      fail(`Resultado sem partida correspondente: ${key}.`);
      continue;
    }
    if (fixture.status !== 'played') {
      fail(`A partida ${key} tem resultado, mas não está marcada como disputada.`);
    }
    if (![result.homeGoals, result.awayGoals].every((score) => Number.isInteger(score) && score >= 0 && score <= 20)) {
      fail(`Resultado ${key}: placar inválido.`);
    }
  }

  for (const fixture of fixtures) {
    const key = `${fixture.round}:${fixture.home}:${fixture.away}`;
    if ((fixture.status === 'played') !== resultKeys.has(key)) {
      fail(`Partida ${key}: situação e resultado não correspondem.`);
    }
  }

  for (let round = 1; round <= ROUNDS; round++) {
    const games = fixtures.filter((fixture) => fixture.round === round);
    const played = games.filter((fixture) => fixture.status === 'played').length;
    const remaining = games.filter((fixture) => fixture.status !== 'played').length;
    if (played > 0 && remaining > 0 && !games.some((fixture) => fixture.status === 'postponed')) {
      warnings.push(`Rodada ${round} incompleta: ${played} de ${games.length} jogos têm resultado.`);
    }
  }

  return { errors, warnings };
}
