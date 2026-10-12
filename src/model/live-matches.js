// Jogos em andamento: placar parcial, minuto estimado e a classificação "antes"
// deles, para que o simulador some o placar ao vivo uma única vez.

const FIRST_HALF_WALL_MINUTES = 47; // 45 + acréscimos
const HALF_TIME_MINUTES = 15;

// O feed não informa o minuto. Estimamos pelo horário de início:
// 1º tempo (~47 min de relógio), intervalo (~15 min) e 2º tempo.
export function estimateMatchMinute(kickoff, now = Date.now()) {
  const start = Date.parse(kickoff);
  if (!Number.isFinite(start)) return null;
  const elapsed = (now - start) / 60_000;
  if (elapsed <= 0) return 0;
  if (elapsed <= FIRST_HALF_WALL_MINUTES) return Math.min(45, Math.floor(elapsed));
  if (elapsed <= FIRST_HALF_WALL_MINUTES + HALF_TIME_MINUTES) return 45;
  return Math.min(90, Math.floor(elapsed - FIRST_HALF_WALL_MINUTES - HALF_TIME_MINUTES + 45));
}

export function isHalfTime(kickoff, now = Date.now()) {
  const elapsed = (now - Date.parse(kickoff)) / 60_000;
  return elapsed > FIRST_HALF_WALL_MINUTES && elapsed <= FIRST_HALF_WALL_MINUTES + HALF_TIME_MINUTES;
}

// Fração da partida que ainda falta (nunca zero: sempre há acréscimos).
export function remainingFraction(minute) {
  if (minute == null) return 0.5;
  return Math.max(0.03, (90 - minute) / 90);
}

// Associa as partidas "live" do feed aos jogos do calendário.
// resolveTeam converte { shortName, name } do feed para a sigla do calendário.
export function collectLiveMatches(feed, fixtures, { now = Date.now(), resolveTeam = (team) => team?.shortName } = {}) {
  if (!feed?.matches) return [];
  const live = [];
  for (const match of feed.matches) {
    if (match.status !== 'live') continue;
    const home = resolveTeam(match.homeTeam);
    const away = resolveTeam(match.awayTeam);
    const fixture = fixtures.find((item) => item.round === match.round && item.home === home && item.away === away);
    if (!fixture || fixture.status === 'played') continue;
    const kickoff = fixture.kickoff || match.dateTime;
    live.push({
      fixtureId: fixture.id,
      round: fixture.round,
      home: fixture.home,
      away: fixture.away,
      homeGoals: Number.isInteger(match.score?.home) ? match.score.home : 0,
      awayGoals: Number.isInteger(match.score?.away) ? match.score.away : 0,
      kickoff,
      minute: kickoff ? estimateMatchMinute(kickoff, now) : null,
      halfTime: kickoff ? isHalfTime(kickoff, now) : false,
      stale: Boolean(feed.stale),
    });
  }
  return live;
}

function contribution(goalsFor, goalsAgainst) {
  const win = goalsFor > goalsAgainst ? 1 : 0;
  const draw = goalsFor === goalsAgainst ? 1 : 0;
  const loss = goalsFor < goalsAgainst ? 1 : 0;
  return { points: 3 * win + draw, wins: win, draws: draw, losses: loss, goalsFor, goalsAgainst };
}

// Alguns sites atualizam a classificação durante o jogo. Se o número de jogos
// de ambos os clubes na tabela for exatamente um a mais do que os resultados
// conhecidos, a tabela já inclui o placar parcial e ele é descontado.
// knownMatches[code] = quantidade de resultados finais conhecidos do clube.
export function standingsWithoutLiveMatches(standings, liveMatches, knownMatches) {
  if (!standings || !liveMatches.length) return { standings, includedLive: [] };
  const adjusted = new Map([...standings].map(([code, entry]) => [code, { ...entry }]));
  const includedLive = [];
  for (const match of liveMatches) {
    const home = adjusted.get(match.home);
    const away = adjusted.get(match.away);
    if (!home || !away) continue;
    const homeDelta = home.matches - (knownMatches[match.home] ?? home.matches);
    const awayDelta = away.matches - (knownMatches[match.away] ?? away.matches);
    if (homeDelta !== 1 || awayDelta !== 1) continue;
    const homeChange = contribution(match.homeGoals, match.awayGoals);
    const awayChange = contribution(match.awayGoals, match.homeGoals);
    const subtract = (entry, change) => ({
      ...entry,
      matches: entry.matches - 1,
      points: entry.points - change.points,
      wins: entry.wins - change.wins,
      draws: entry.draws - change.draws,
      losses: entry.losses - change.losses,
      goalsFor: entry.goalsFor - change.goalsFor,
      goalsAgainst: entry.goalsAgainst - change.goalsAgainst,
      goalDifference: entry.goalDifference - change.goalsFor + change.goalsAgainst,
    });
    const nextHome = subtract(home, homeChange);
    const nextAway = subtract(away, awayChange);
    const valid = [nextHome, nextAway].every((entry) =>
      ['matches', 'points', 'wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst'].every((key) => entry[key] >= 0),
    );
    if (!valid) continue;
    adjusted.set(match.home, nextHome);
    adjusted.set(match.away, nextAway);
    includedLive.push(match.fixtureId);
  }
  if (includedLive.length) {
    // Reordena para obter as posições de antes dos jogos em andamento.
    const ordered = [...adjusted.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        b.goalDifference - a.goalDifference ||
        b.goalsFor - a.goalsFor ||
        a.position - b.position,
    );
    ordered.forEach((entry, index) => {
      adjusted.set(entry.code, { ...entry, position: index + 1 });
    });
  }
  return { standings: adjusted, includedLive };
}
