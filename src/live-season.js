function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveTeamCode(team, teams, byName) {
  if (team?.shortName && teams[team.shortName]) return team.shortName;
  return byName.get(normalized(team?.name)) || null;
}

function validScore(score) {
  return Number.isInteger(score) && score >= 0 && score <= 20;
}

const NAME_ALIASES = [
  ['athleticoparanaense', 'CAP'],
  ['athleticopr', 'CAP'],
  ['redbullbragantino', 'BRA'],
  ['bragantino', 'BRA'],
];

// Converte um clube do feed ({ shortName, name }) para a sigla do calendário local.
// O feed pode usar outra sigla (ex.: RBB para o Bragantino); o nome resolve.
export function createTeamCodeResolver(teams) {
  const byName = new Map(Object.entries(teams).map(([code, name]) => [normalized(name), code]));
  for (const [name, code] of NAME_ALIASES) byName.set(name, code);
  return (team) => resolveTeamCode(team, teams, byName);
}

export function mergeLiveSeason(snapshot, liveFeed) {
  if (!liveFeed) {
    return {
      seasonData: snapshot,
      standingsByCode: null,
      round: null,
      warnings: [],
    };
  }

  if (
    liveFeed.season !== snapshot.season ||
    !Number.isInteger(liveFeed.round?.number) ||
    !Array.isArray(liveFeed.standings) ||
    liveFeed.standings.length !== 20 ||
    !Array.isArray(liveFeed.matches) ||
    (liveFeed.history != null && !Array.isArray(liveFeed.history))
  ) {
    throw new Error('O feed ao vivo não corresponde ao formato esperado da Série A.');
  }

  const byName = new Map(Object.entries(snapshot.teams).map(([code, name]) => [normalized(name), code]));
  for (const [name, code] of NAME_ALIASES) byName.set(name, code);
  const standingsByCode = new Map();

  for (const entry of liveFeed.standings) {
    const code = resolveTeamCode({ shortName: entry.teamCode, name: entry.name }, snapshot.teams, byName);
    if (!code || standingsByCode.has(code)) {
      throw new Error('Não foi possível associar todos os clubes do feed à temporada local.');
    }
    if (
      ![
        entry.points,
        entry.matches,
        entry.wins,
        entry.draws,
        entry.losses,
        entry.goalsFor,
        entry.goalsAgainst,
        entry.goalDifference,
      ].every(Number.isInteger) ||
      entry.matches < 0 ||
      entry.matches > 38 ||
      entry.wins + entry.draws + entry.losses !== entry.matches ||
      entry.points !== entry.wins * 3 + entry.draws ||
      entry.goalDifference !== entry.goalsFor - entry.goalsAgainst
    ) {
      throw new Error(`Estatísticas inválidas para ${snapshot.teams[code]}.`);
    }
    standingsByCode.set(code, { ...entry, code });
  }

  if (standingsByCode.size !== Object.keys(snapshot.teams).length) {
    throw new Error('A classificação ao vivo não contém os 20 clubes conhecidos.');
  }

  const seasonData = {
    ...snapshot,
    fixtures: snapshot.fixtures.map((fixture) => ({ ...fixture })),
    results: snapshot.results.map((result) => ({ ...result })),
  };
  const warnings = [];
  const observedMatches = new Map();
  for (const match of liveFeed.history || []) {
    observedMatches.set(`${match.round}:${match.homeTeam?.shortName}:${match.awayTeam?.shortName}`, match);
  }
  for (const match of liveFeed.matches) {
    const key = `${match.round}:${match.homeTeam?.shortName}:${match.awayTeam?.shortName}`;
    if (match.status === 'finished' || !observedMatches.has(key)) observedMatches.set(key, match);
  }

  for (const match of observedMatches.values()) {
    if (
      !Number.isInteger(match.round) ||
      match.round < 1 ||
      match.round > 38 ||
      !['finished', 'live', 'scheduled'].includes(match.status)
    ) {
      throw new Error('O feed contém uma partida histórica inválida.');
    }
    if (match.status !== 'finished' && match.round !== liveFeed.round.number) continue;
    const home = resolveTeamCode(match.homeTeam, seasonData.teams, byName);
    const away = resolveTeamCode(match.awayTeam, seasonData.teams, byName);
    if (!home || !away || home === away) {
      warnings.push('Uma partida da rodada atual não pôde ser associada aos clubes do calendário.');
      continue;
    }

    const fixture = seasonData.fixtures.find(
      (item) => item.round === match.round && item.home === home && item.away === away,
    );
    if (!fixture) {
      warnings.push(
        `Partida ${seasonData.teams[home]} x ${seasonData.teams[away]} não encontrada no calendário local.`,
      );
      continue;
    }

    if (fixture.status === 'played') continue;

    const kickoff =
      typeof match.dateTime === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(match.dateTime)
        ? `${match.dateTime}-03:00`
        : match.dateTime;
    if (typeof kickoff === 'string' && Number.isFinite(Date.parse(kickoff))) {
      fixture.kickoff = kickoff;
    }
    if (match.venue) fixture.stadium = match.venue;

    if (match.status !== 'finished') continue;
    if (!validScore(match.score?.home) || !validScore(match.score?.away)) {
      warnings.push(`Resultado final sem placar válido: ${seasonData.teams[home]} x ${seasonData.teams[away]}.`);
      continue;
    }

    fixture.status = 'played';
    const result = {
      round: match.round,
      home,
      away,
      homeGoals: match.score.home,
      awayGoals: match.score.away,
      source: {
        ...(match.source || liveFeed.source || { name: 'GE (Globo Esporte)', url: null }),
        observedAt: match.observedAt || match.source?.observedAt || liveFeed.fetchedAt || null,
        type: 'feed-observed',
      },
    };
    const existing = seasonData.results.find(
      (item) => item.round === result.round && item.home === home && item.away === away,
    );
    if (existing) Object.assign(existing, result);
    else seasonData.results.push(result);
  }

  return {
    seasonData,
    standingsByCode,
    round: liveFeed.round,
    warnings,
  };
}
