// Histórico das chances de cada clube ao longo da temporada.
import { DEFAULT_SETTINGS, simulateSeasonChances } from './season-model.js';

const round1 = (value) => Math.round(value * 10) / 10;

export function compactChances(chances) {
  return Object.fromEntries(
    Object.entries(chances).map(([code, value]) => [
      code,
      {
        title: round1(value.title),
        libertadores: round1(value.libertadores),
        sudamericana: round1(value.sudamericana),
        relegation: round1(value.relegation),
        meanPoints: round1(value.meanPoints),
      },
    ]),
  );
}

// Chances "como eram" ao fim de cada rodada, usando só os resultados até ela.
export function reconstructRoundHistory(season, { settings = DEFAULT_SETTINGS, iterations = 10_000 } = {}) {
  const lastRound = Math.max(...season.results.map((result) => result.round));
  const entries = [];
  for (let round = 1; round <= lastRound; round++) {
    const results = season.results.filter((result) => result.round <= round);
    const fixtures = season.fixtures.map((fixture) =>
      fixture.round > round && fixture.status === 'played' ? { ...fixture, status: 'scheduled' } : fixture,
    );
    const { chances } = simulateSeasonChances({
      seasonData: { ...season, results, fixtures },
      currentRound: round + 1,
      settings,
      iterations,
    });
    entries.push({
      round,
      progress: round,
      source: 'reconstructed',
      matches: results.length,
      chances: compactChances(chances),
    });
  }
  return entries;
}

// Junta o histórico reconstruído com as fotos tiradas ao vivo, ordenado pelo
// avanço do campeonato (jogos disputados / jogos por rodada).
export function mergeHistory(reconstructed, observed, teamCount = 20) {
  const perRound = teamCount / 2;
  const byProgress = new Map();
  for (const entry of reconstructed) byProgress.set(entry.matches, entry);
  for (const entry of observed) byProgress.set(entry.matches, { ...entry, progress: entry.matches / perRound });
  return [...byProgress.values()].sort((a, b) => a.matches - b.matches);
}

export function isValidHistoryEntry(entry, teams) {
  return (
    entry &&
    Number.isInteger(entry.matches) &&
    entry.matches >= 0 &&
    entry.matches <= 380 &&
    entry.chances &&
    teams.every((code) => {
      const value = entry.chances[code];
      return (
        value &&
        ['title', 'libertadores', 'sudamericana', 'relegation'].every(
          (key) => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100,
        )
      );
    })
  );
}
