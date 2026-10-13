// Adaptador da API pública (não oficial) da ESPN para o esquema único.
// scoreboard?dates=2026&limit=1000 traz a temporada inteira; standings traz os grupos.
import { COMPETITIONS } from '../formats.js';
import { emptyCompetition } from '../schema.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer';

export function espnUrls(competitionId, season) {
  const slug = COMPETITIONS[competitionId].espnSlug;
  return {
    scoreboard: `${SITE}/${slug}/scoreboard?dates=${season}&limit=1000`,
    standings: `${STANDINGS}/${slug}/standings?season=${season}`,
    page: `https://www.espn.com.br/futebol/liga/_/nome/${slug}`,
  };
}

const toInt = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
};
const clean = (value, max = 60) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[<>"'`&\u0000-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
// Times "a definir" da ESPN (chaveamento ainda aberto).
const isPlaceholder = (team) =>
  !team || /^TBD\b/i.test(team.displayName || '') || /a definir/i.test(team.displayName || '');

function addTeam(teams, team) {
  if (isPlaceholder(team)) return null;
  const id = String(team.id);
  if (!/^\d{1,8}$/.test(id)) return null;
  if (!teams[id]) {
    teams[id] = {
      id,
      name: clean(team.displayName),
      shortName: clean(team.shortDisplayName || team.displayName),
      abbreviation: clean(team.abbreviation, 6),
      location: clean(team.location),
      logo: typeof team.logo === 'string' && team.logo.startsWith('https://a.espncdn.com/') ? team.logo : null,
    };
  }
  return id;
}

function legFromEvent(event, teams) {
  const competition = event.competitions?.[0];
  if (!competition) return null;
  const home = competition.competitors.find((item) => item.homeAway === 'home');
  const away = competition.competitors.find((item) => item.homeAway === 'away');
  const state = ['pre', 'in', 'post'].includes(competition.status?.type?.state) ? competition.status.type.state : 'pre';
  const homeId = addTeam(teams, home?.team);
  const awayId = addTeam(teams, away?.team);
  const penalties =
    home?.shootoutScore != null && away?.shootoutScore != null
      ? { home: toInt(home.shootoutScore), away: toInt(away.shootoutScore) }
      : null;
  return {
    id: String(event.id),
    date: event.date,
    home: homeId,
    away: awayId,
    homeGoals: state === 'pre' ? null : toInt(home?.score),
    awayGoals: state === 'pre' ? null : toInt(away?.score),
    state,
    clock: state === 'in' ? clean(competition.status?.displayClock, 10) : null,
    penalties,
    venue: clean(competition.venue?.fullName),
    legNumber: competition.leg?.value || 1,
    series: competition.series || null,
    winner: home?.winner ? homeId : away?.winner ? awayId : null,
    note: clean((competition.notes || []).map((note) => note.headline).join(' · '), 160),
  };
}

// Agrupa os jogos de uma fase em confrontos (mesmo par de clubes).
function tiesFromLegs(stageId, legs, legsPerTie) {
  const ties = new Map();
  let placeholders = 0;
  for (const leg of legs) {
    const key = leg.home && leg.away ? [leg.home, leg.away].sort().join('-') : `tbd-${placeholders++}-${leg.id}`;
    if (!ties.has(key))
      ties.set(key, { id: `${stageId}:${key}`, stage: stageId, teams: [leg.home, leg.away], legs: [] });
    ties.get(key).legs.push(leg);
  }
  return [...ties.values()].map((tie) => {
    tie.legs.sort((a, b) => a.legNumber - b.legNumber || Date.parse(a.date) - Date.parse(b.date));
    // O mandante da ida é o primeiro clube do confronto.
    tie.teams = [tie.legs[0].home, tie.legs[0].away];
    const [a, b] = tie.teams;
    const finished = tie.legs.filter((leg) => leg.state === 'post');
    let goalsA = 0;
    let goalsB = 0;
    for (const leg of finished) {
      goalsA += leg.home === a ? leg.homeGoals : leg.awayGoals;
      goalsB += leg.home === a ? leg.awayGoals : leg.homeGoals;
    }
    tie.aggregate = finished.length ? [goalsA, goalsB] : null;
    const complete =
      finished.length === legsPerTie || (finished.length && tie.legs.length === finished.length && legsPerTie === 1);
    const lastLeg = tie.legs[tie.legs.length - 1];
    const seriesWinner = lastLeg.series?.competitors?.find((item) => item.winner)?.id;
    tie.winner = complete ? (seriesWinner ? String(seriesWinner) : lastLeg.winner) || null : null;
    if (tie.winner && ![a, b].includes(tie.winner)) tie.winner = null;
    tie.decidedBy = !tie.winner
      ? null
      : lastLeg.penalties
        ? 'penalties'
        : legsPerTie === 1
          ? 'single-match'
          : 'aggregate';
    for (const leg of tie.legs) {
      delete leg.series;
      delete leg.winner;
    }
    return tie;
  });
}

function groupsFromStandings(standings, teams) {
  const groups = [];
  for (const child of standings?.children || []) {
    const letter = /Group\s+([A-Z])/i.exec(child.name || '')?.[1] || clean(child.abbreviation, 3);
    const table = (child.standings?.entries || [])
      .map((entry) => {
        const stat = (name) => toInt(entry.stats?.find((item) => item.name === name)?.value) ?? 0;
        const teamId = addTeam(teams, { ...entry.team, logo: entry.team?.logos?.[0]?.href });
        if (!teamId) return null;
        return {
          teamId,
          rank: stat('rank'),
          played: stat('gamesPlayed'),
          wins: stat('wins'),
          draws: stat('ties'),
          losses: stat('losses'),
          goalsFor: stat('pointsFor'),
          goalsAgainst: stat('pointsAgainst'),
          goalDifference: stat('pointsFor') - stat('pointsAgainst'),
          points: stat('points'),
          note: clean(entry.note?.description, 80),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank || b.points - a.points);
    if (table.length) groups.push({ id: letter, name: `Grupo ${letter}`, table });
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeEspnCompetition(
  competitionId,
  { scoreboard, standings },
  { fetchedAt = new Date().toISOString() } = {},
) {
  const format = COMPETITIONS[competitionId];
  if (!format) throw new Error(`Competição desconhecida: ${competitionId}`);
  const league = scoreboard?.leagues?.[0];
  const season = Number(league?.season?.year) || new Date(fetchedAt).getFullYear();
  const competition = emptyCompetition({ id: competitionId, name: format.name, season });
  competition.fetchedAt = fetchedAt;
  competition.source = { name: 'ESPN', url: espnUrls(competitionId, season).page };
  const byStage = new Map();
  for (const event of scoreboard?.events || []) {
    const stageId = event.season?.slug;
    if (!format.stages.some((stage) => stage.id === stageId)) continue;
    const leg = legFromEvent(event, competition.teams);
    if (!leg) continue;
    if (!byStage.has(stageId)) byStage.set(stageId, []);
    byStage.get(stageId).push(leg);
  }
  competition.stages = format.stages
    .filter((stage) => byStage.has(stage.id) || stage.type === 'knockout')
    .map((stage) => ({
      id: stage.id,
      name: stage.name,
      type: stage.type,
      legs: stage.legs || null,
      ties:
        stage.type === 'knockout' && byStage.has(stage.id)
          ? tiesFromLegs(stage.id, byStage.get(stage.id), stage.legs)
          : [],
      matches: stage.type === 'groups' ? byStage.get(stage.id) || [] : undefined,
    }))
    .filter((stage) => stage.ties.length || stage.matches?.length || stage.id === 'final');
  competition.groups = groupsFromStandings(standings, competition.teams);
  const open = competition.stages.find((stage) => stage.type === 'knockout' && stage.ties.some((tie) => !tie.winner));
  competition.currentStage = open?.id || null;
  const final = competition.stages.find((stage) => stage.id === 'final');
  competition.champion = final?.ties[0]?.winner || null;
  return competition;
}
