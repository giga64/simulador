import { createHash } from 'node:crypto';

const TEAM_COUNT = 20;
const ROUND_COUNT = 38;

export function normalizeLiveCompetition(competition, fetchedAt = new Date().toISOString()) {
  const source = competition?.competition?.source;
  const table = competition?.tables?.[0];
  const round = competition?.rounds?.[0];

  if (competition?.competition?.code !== 'a' || competition.competition.season !== 2026) {
    throw new Error('A fonte retornou uma competição diferente da Série A de 2026.');
  }
  if (!source?.url || !table || table.entries?.length !== TEAM_COUNT) {
    throw new Error('A classificação ao vivo está ausente ou incompleta.');
  }
  const sourceUrl = new URL(source.url);
  if (
    sourceUrl.protocol !== 'https:' ||
    (sourceUrl.hostname !== 'ge.globo.com' && !sourceUrl.hostname.endsWith('.ge.globo.com'))
  ) {
    throw new Error('A classificação veio de uma origem diferente da fonte GE esperada.');
  }
  if (
    !Number.isInteger(round?.number) ||
    round.number < 1 ||
    round.number > ROUND_COUNT ||
    !Array.isArray(round.matches)
  ) {
    throw new Error('A rodada atual retornada pela fonte é inválida.');
  }

  const seenTeams = new Set();
  const seenPositions = new Set();
  const standings = table.entries.map((entry) => {
    const teamCode = entry.team?.shortName;
    const stats = [
      entry.position,
      entry.points,
      entry.matches,
      entry.wins,
      entry.draws,
      entry.losses,
      entry.goalsFor,
      entry.goalsAgainst,
      entry.goalDifference,
    ];

    if (
      typeof teamCode !== 'string' ||
      !teamCode ||
      seenTeams.has(teamCode) ||
      !stats.every(Number.isInteger) ||
      entry.matches < 0 ||
      entry.matches > ROUND_COUNT ||
      entry.position < 1 ||
      entry.position > TEAM_COUNT ||
      seenPositions.has(entry.position) ||
      entry.wins + entry.draws + entry.losses !== entry.matches ||
      entry.points !== entry.wins * 3 + entry.draws ||
      entry.goalsFor < 0 ||
      entry.goalsAgainst < 0 ||
      entry.goalDifference !== entry.goalsFor - entry.goalsAgainst
    ) {
      throw new Error('A classificação contém dados inválidos ou clubes duplicados.');
    }

    seenTeams.add(teamCode);
    seenPositions.add(entry.position);
    return {
      teamCode,
      name: entry.team.name,
      position: entry.position,
      points: entry.points,
      matches: entry.matches,
      wins: entry.wins,
      draws: entry.draws,
      losses: entry.losses,
      goalsFor: entry.goalsFor,
      goalsAgainst: entry.goalsAgainst,
      goalDifference: entry.goalDifference,
      efficiency: Number.isFinite(entry.efficiency) ? entry.efficiency : null,
      recentForm: Array.isArray(entry.recentForm) ? entry.recentForm : [],
    };
  });

  if (standings.length !== TEAM_COUNT) {
    throw new Error('A classificação não contém os 20 clubes da Série A.');
  }

  const seenMatches = new Set();
  const matches = round.matches.map((match) => {
    const score = match.score || {};
    if (
      !match.homeTeam?.shortName ||
      !match.awayTeam?.shortName ||
      !['finished', 'live', 'scheduled'].includes(match.status) ||
      ![score.home, score.away].every(
        (value) => value == null || (Number.isInteger(value) && value >= 0 && value <= 20),
      )
    ) {
      throw new Error('A rodada atual contém uma partida com dados inválidos.');
    }
    const key = `${match.homeTeam.shortName}:${match.awayTeam.shortName}`;
    if (seenMatches.has(key)) throw new Error('A rodada atual contém partidas duplicadas.');
    seenMatches.add(key);
    return {
      round: round.number,
      status: match.status,
      dateTime: typeof match.dateTime === 'string' ? match.dateTime : null,
      venue: match.venue,
      homeTeam: { shortName: match.homeTeam.shortName, name: match.homeTeam.name },
      awayTeam: { shortName: match.awayTeam.shortName, name: match.awayTeam.name },
      score: { home: score.home, away: score.away },
    };
  });

  if (matches.length > 10) {
    throw new Error('A rodada atual contém mais partidas do que o esperado.');
  }

  const normalizedFeed = {
    fetchedAt,
    source: { name: 'GE (Globo Esporte)', url: source.url },
    season: 2026,
    round: { number: round.number, total: round.total || ROUND_COUNT, label: round.label },
    standings,
    matches,
  };
  normalizedFeed.revision = createHash('sha256')
    .update(
      JSON.stringify({
        season: normalizedFeed.season,
        round: normalizedFeed.round,
        standings: normalizedFeed.standings,
        matches: normalizedFeed.matches,
      }),
    )
    .digest('hex');
  return normalizedFeed;
}

export function createLiveFeedCache(
  load,
  { freshForMs = 60_000, staleForMs = 6 * 60 * 60 * 1000, clock = Date.now } = {},
) {
  let cached = null;
  let pending = null;

  return async function readLiveFeed({ forceRefresh = false } = {}) {
    const now = clock();
    if (!forceRefresh && cached && now - cached.savedAt < freshForMs) {
      return { ...cached.feed, stale: false, checkedAt: cached.feed.fetchedAt };
    }
    if (pending) return pending;

    pending = Promise.resolve()
      .then(load)
      .then((feed) => {
        cached = { feed, savedAt: clock() };
        return { ...feed, stale: false, checkedAt: feed.fetchedAt };
      })
      .catch((error) => {
        const checkedAt = new Date(clock()).toISOString();
        if (cached && clock() - cached.savedAt < staleForMs) {
          return {
            ...cached.feed,
            stale: true,
            checkedAt,
            warning: `Fonte indisponível; exibindo a última consulta bem-sucedida de ${cached.feed.fetchedAt}.`,
          };
        }
        throw error;
      })
      .finally(() => {
        pending = null;
      });

    return pending;
  };
}
