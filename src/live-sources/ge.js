import { getCompetition } from 'campeonato-brasileiro-api';
import { normalizeLiveCompetition } from '../live-feed.js';

// Fonte ao vivo baseada no scraper do GE. Qualquer outra fonte (API-Football,
// football-data.org...) só precisa expor a mesma função: () => Promise<feed>,
// com o formato produzido por normalizeLiveCompetition.
export function createGeLiveSource({ timeoutMs = 12_000 } = {}) {
  return async function loadGeFeed() {
    const competition = await getCompetition('a', { signal: AbortSignal.timeout(timeoutMs) });
    return normalizeLiveCompetition(competition);
  };
}
