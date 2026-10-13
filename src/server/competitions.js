// Copas no servidor: busca a ESPN, normaliza e guarda em cache.
// Cache de 30 s quando há jogo em andamento e de 2 min nos demais casos; se a
// fonte falhar, serve a última versão válida por até 6 h (marcada como stale).
import { espnUrls, normalizeEspnCompetition } from '../competitions/adapters/espn.js';
import { COMPETITION_IDS, COMPETITIONS } from '../competitions/formats.js';
import { validateCompetition } from '../competitions/schema.js';

const LIVE_MS = 30_000;
const IDLE_MS = 120_000;
const STALE_MS = 6 * 60 * 60 * 1000;

export const hasLiveLeg = (competition) =>
  competition.stages.some((stage) =>
    [...stage.ties.flatMap((tie) => tie.legs), ...(stage.matches || [])].some((leg) => leg.state === 'in'),
  );

export function createCompetitionService({
  fetchImpl = fetch,
  clock = Date.now,
  season = 2026,
  logger = console,
  monitor = null,
} = {}) {
  const cache = new Map();
  const pending = new Map();

  async function load(id) {
    const urls = espnUrls(id, season);
    const getJson = async (url) => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`ESPN respondeu HTTP ${response.status}`);
      return response.json();
    };
    const hasGroups = COMPETITIONS[id].stages.some((stage) => stage.type === 'groups');
    const [scoreboard, standings] = await Promise.all([
      getJson(urls.scoreboard),
      hasGroups ? getJson(urls.standings) : Promise.resolve(null),
    ]);
    const competition = normalizeEspnCompetition(
      id,
      { scoreboard, standings },
      { fetchedAt: new Date(clock()).toISOString() },
    );
    const errors = validateCompetition(competition);
    if (errors.length) throw new Error(`Dados inválidos: ${errors.slice(0, 3).join(' ')}`);
    if (!competition.stages.length) throw new Error('A fonte não trouxe jogos.');
    return competition;
  }

  return {
    ids: COMPETITION_IDS,
    async read(id) {
      if (!COMPETITION_IDS.includes(id)) throw Object.assign(new Error('Competição desconhecida.'), { status: 404 });
      const now = clock();
      const entry = cache.get(id);
      if (entry && now - entry.savedAt < (hasLiveLeg(entry.value) ? LIVE_MS : IDLE_MS))
        return { ...entry.value, stale: false };
      if (!pending.has(id)) {
        pending.set(
          id,
          load(id)
            .then((value) => {
              monitor?.success(`ESPN ${id}`);
              cache.set(id, { value, savedAt: clock() });
              return { ...value, stale: false };
            })
            .catch((error) => {
              monitor?.failure(`ESPN ${id}`, error);
              logger.error(`Copa ${id}: ${error.message}`);
              if (entry && clock() - entry.savedAt < STALE_MS) return { ...entry.value, stale: true };
              throw error;
            })
            .finally(() => pending.delete(id)),
        );
      }
      return pending.get(id);
    },
  };
}
