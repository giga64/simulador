// Estado da temporada no servidor: aplica cada feed ao snapshot, detecta
// eventos ao vivo (início, gol, fim) e grava as chances a cada resultado novo.
import { mergeVerifiedResults } from '../history-integrity.js';
import { createTeamCodeResolver, mergeLiveSeason } from '../live-season.js';
import { collectLiveMatches, standingsWithoutLiveMatches } from '../model/live-matches.js';
import { compactChances, isValidHistoryEntry, mergeHistory } from '../model/probability-history.js';
import { DEFAULT_SETTINGS, simulateSeasonChances } from '../model/season-model.js';
import { validateSeasonData } from '../season-data.js';

export function detectLiveEvents(previousLive, currentLive, results) {
  if (!previousLive) return [];
  const events = [];
  for (const match of currentLive.values()) {
    const before = previousLive.get(match.fixtureId);
    if (!before) events.push({ type: 'start', ...match });
    else if (match.homeGoals > before.homeGoals || match.awayGoals > before.awayGoals) {
      events.push({ type: 'goal', side: match.homeGoals > before.homeGoals ? 'home' : 'away', ...match });
    }
  }
  for (const before of previousLive.values()) {
    if (currentLive.has(before.fixtureId)) continue;
    const result = results.find(
      (item) => item.round === before.round && item.home === before.home && item.away === before.away,
    );
    if (result) {
      events.push({ type: 'end', ...before, homeGoals: result.homeGoals, awayGoals: result.awayGoals });
    }
  }
  return events;
}

export function createSeasonService({
  snapshot,
  backfill,
  logos,
  reconstructedHistory,
  historyStore,
  logger = console,
}) {
  const reconciled = mergeVerifiedResults(snapshot, backfill);
  const teams = Object.keys(snapshot.teams);
  const resolveTeam = createTeamCodeResolver(snapshot.teams);
  let state = {
    seasonData: reconciled,
    standings: null,
    round: null,
    live: new Map(),
    fetchedAt: null,
  };
  let observedHistory = [];
  const ready = historyStore.read().then((stored) => {
    observedHistory = (stored.entries || []).filter((entry) => isValidHistoryEntry(entry, teams));
  });

  function recordChances(current) {
    const matches = current.standings
      ? [...current.standings.values()].reduce((sum, entry) => sum + entry.matches, 0) / 2
      : current.seasonData.results.length;
    const last = Math.max(
      -1,
      ...reconstructedHistory.map((entry) => entry.matches),
      ...observedHistory.map((entry) => entry.matches),
    );
    if (matches <= last) return;
    const { chances } = simulateSeasonChances({
      seasonData: current.seasonData,
      standings: current.standings,
      currentRound: current.round?.number,
      settings: DEFAULT_SETTINGS,
    });
    observedHistory.push({
      matches,
      round: current.round?.number ?? null,
      at: current.fetchedAt,
      source: 'observed',
      chances: compactChances(chances),
    });
    historyStore.write({ version: 1, entries: observedHistory });
  }

  return {
    ready,
    teams,
    resolveTeam,
    get state() {
      return state;
    },
    // Aplica um feed novo. Devolve os eventos ao vivo desde o feed anterior.
    async update(feed) {
      await ready;
      const merged = mergeLiveSeason(reconciled, feed);
      const validation = validateSeasonData(merged.seasonData, logos);
      if (validation.errors.length) throw new Error(validation.errors.join(' '));
      const liveMatches = collectLiveMatches(feed, merged.seasonData.fixtures, { resolveTeam });
      const known = Object.fromEntries(teams.map((code) => [code, 0]));
      for (const result of merged.seasonData.results) {
        known[result.home]++;
        known[result.away]++;
      }
      const next = {
        seasonData: merged.seasonData,
        standings: standingsWithoutLiveMatches(merged.standingsByCode, liveMatches, known).standings,
        round: merged.round,
        live: new Map(liveMatches.map((match) => [match.fixtureId, match])),
        fetchedAt: feed.fetchedAt,
      };
      const events = feed.stale
        ? []
        : detectLiveEvents(state.fetchedAt ? state.live : null, next.live, next.seasonData.results);
      state = next;
      try {
        recordChances(next);
      } catch (error) {
        logger.error(`Não foi possível registrar as chances: ${error.message}`);
      }
      return events;
    },
    async probabilityHistory() {
      await ready;
      return mergeHistory(reconstructedHistory, observedHistory, teams.length);
    },
  };
}
