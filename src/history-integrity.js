const MAX_SCORE = 20;
const TEAM_STATS = ['matches', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst'];

function validResult(result, fixtures, knownKeys) {
  if (!result || !Number.isInteger(result.round) || result.round < 1 || result.round > 38
    || typeof result.home !== 'string' || typeof result.away !== 'string'
    || !Number.isInteger(result.homeGoals) || result.homeGoals < 0 || result.homeGoals > MAX_SCORE
    || !Number.isInteger(result.awayGoals) || result.awayGoals < 0 || result.awayGoals > MAX_SCORE) {
    throw new Error('O arquivo de correções contém um resultado inválido.');
  }
  const key = `${result.round}:${result.home}:${result.away}`;
  const fixture = fixtures.find((item) => item.round === result.round
    && item.home === result.home && item.away === result.away);
  if (!fixture) throw new Error(`Resultado sem partida correspondente: ${key}.`);
  if (knownKeys.has(key)) throw new Error(`Resultado duplicado ou já existente: ${key}.`);
  return { ...result, fixture, key };
}

export function mergeVerifiedResults(snapshot, backfill) {
  if (!backfill || backfill.schemaVersion !== 1 || backfill.season !== snapshot.season
    || !Array.isArray(backfill.results)) {
    throw new Error('O arquivo de resultados verificados tem formato ou temporada inválidos.');
  }
  if (!Number.isFinite(Date.parse(backfill.updatedAt))) {
    throw new Error('A data de atualização dos resultados verificados é inválida.');
  }

  const seasonData = {
    ...snapshot,
    fixtures: snapshot.fixtures.map((fixture) => ({ ...fixture })),
    results: snapshot.results.map((result) => ({ ...result })),
  };
  const knownKeys = new Set(seasonData.results.map(
    (result) => `${result.round}:${result.home}:${result.away}`,
  ));

  for (const result of backfill.results) {
    const entry = validResult(result, seasonData.fixtures, knownKeys);
    if (entry.fixture.status === 'played') {
      throw new Error(`A partida ${entry.key} está marcada como disputada, mas não tem resultado no snapshot.`);
    }
    if (!result.source || typeof result.source.name !== 'string'
      || !result.source.name.trim() || typeof result.source.url !== 'string'
      || !Number.isFinite(Date.parse(result.source.verifiedAt))) {
      throw new Error(`A partida ${entry.key} não tem procedência de verificação válida.`);
    }
    const sourceUrl = new URL(result.source.url);
    if (sourceUrl.protocol !== 'https:') {
      throw new Error(`A fonte do resultado ${entry.key} precisa usar HTTPS.`);
    }
    entry.fixture.status = 'played';
    seasonData.results.push({
      round: result.round,
      home: result.home,
      away: result.away,
      homeGoals: result.homeGoals,
      awayGoals: result.awayGoals,
      source: { ...result.source },
    });
    knownKeys.add(entry.key);
  }

  return seasonData;
}

export function assessHistoryCoverage(results, standingsByCode, teams) {
  if (!(standingsByCode instanceof Map) || standingsByCode.size !== Object.keys(teams).length) {
    return { status: 'unavailable', knownMatches: results.length, expectedMatches: null, missingMatches: null, clubs: [] };
  }

  const totals = Object.fromEntries(Object.keys(teams).map((code) => [code, {
    matches: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0,
  }]));
  for (const result of results) {
    const home = totals[result.home];
    const away = totals[result.away];
    if (!home || !away || result.home === result.away) continue;
    home.matches++;
    away.matches++;
    home.goalsFor += result.homeGoals;
    home.goalsAgainst += result.awayGoals;
    away.goalsFor += result.awayGoals;
    away.goalsAgainst += result.homeGoals;
    if (result.homeGoals > result.awayGoals) {
      home.wins++;
      away.losses++;
    } else if (result.homeGoals < result.awayGoals) {
      away.wins++;
      home.losses++;
    } else {
      home.draws++;
      away.draws++;
    }
  }

  const clubs = Object.entries(teams).map(([code, name]) => {
    const known = totals[code];
    const current = standingsByCode.get(code);
    const differences = Object.fromEntries(TEAM_STATS.map((stat) => [stat, current[stat] - known[stat]]));
    return {
      code,
      name,
      missingMatches: Math.max(0, differences.matches),
      differences,
      consistent: TEAM_STATS.every((stat) => differences[stat] === 0),
    };
  });
  const expectedMatches = [...standingsByCode.values()]
    .reduce((sum, entry) => sum + entry.matches, 0) / 2;
  const missingMatches = Math.max(0, Math.ceil(expectedMatches - results.length));
  const missingOnly = missingMatches > 0 && clubs.every((club) =>
    Object.values(club.differences).every((difference) => difference >= 0));
  const inconsistent = expectedMatches < results.length
    || [...standingsByCode.values()].some((entry) => !Number.isInteger(entry.matches))
    || (clubs.some((club) => !club.consistent) && !missingOnly);

  return {
    status: inconsistent ? 'inconsistent' : missingMatches ? 'incomplete' : 'consistent',
    knownMatches: results.length,
    expectedMatches,
    missingMatches,
    clubs: clubs.filter((club) => !club.consistent)
      .sort((a, b) => b.missingMatches - a.missingMatches || a.name.localeCompare(b.name, 'pt-BR')),
  };
}
