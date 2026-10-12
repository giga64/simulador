// Servidor do SimulaBR: liga o feed ao vivo, o estado da temporada, as
// notificações, o histórico de chances e as rotas (src/server/app.js).
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveFeedCache } from '../src/live-feed.js';
import { createLiveHistoryStore } from '../src/live-history.js';
import { createGeLiveSource } from '../src/live-sources/ge.js';
import { createMatchModel, DEFAULT_SETTINGS, openFixturesFrom } from '../src/model/season-model.js';
import { createRequestHandler } from '../src/server/app.js';
import { createJsonStore } from '../src/server/json-store.js';
import { createOddsTracker } from '../src/server/odds.js';
import { createOgRenderer } from '../src/server/og-image.js';
import { createPushNotifier } from '../src/server/push.js';
import { createSeasonService } from '../src/server/season-service.js';
import { createAccountDeleter, createAdminClient, createSharedScenarioStore } from '../src/server/supabase-admin.js';
import { getPublicSupabaseConfig, isSupabaseServiceRoleKey } from '../src/supabase-config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const production = env.NODE_ENV === 'production';
const port = Number(env.PORT || 4173);
const host = env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
const runtimeDir = env.RUNTIME_DIR || path.join(root, '.runtime');
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));

const siteUrl = (() => {
  try {
    const url = new URL(env.SITE_URL || '');
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.origin : '';
  } catch {
    return '';
  }
})();

const supabaseConfig = getPublicSupabaseConfig(env);
const serviceRoleKey = isSupabaseServiceRoleKey(env.SUPABASE_SERVICE_ROLE_KEY) ? env.SUPABASE_SERVICE_ROLE_KEY : '';
const adminClient = supabaseConfig.authConfigured
  ? createAdminClient({ supabaseUrl: supabaseConfig.supabaseUrl, serviceRoleKey })
  : null;

const [snapshot, backfill, logos, reconstructed] = await Promise.all([
  readJson('data/season-2026.json'),
  readJson('data/historical-backfill-2026.json'),
  readJson('assets/logos.json'),
  readJson('data/probability-history-2026.json'),
]);

const seasonService = createSeasonService({
  snapshot,
  backfill,
  logos,
  reconstructedHistory: reconstructed.entries,
  historyStore: createJsonStore(env.PROBABILITY_HISTORY_PATH || path.join(runtimeDir, 'probability-history.json'), {
    fallback: { version: 1, entries: [] },
  }),
});
const pushNotifier = createPushNotifier({
  vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
  adminClient,
  teamNames: snapshot.teams,
});
const oddsTracker = createOddsTracker({
  apiKey: env.ODDS_API_KEY,
  store: createJsonStore(path.join(runtimeDir, 'odds.json'), { fallback: { version: 1, records: [] } }),
  resolveTeam: seasonService.resolveTeam,
});

const addToHistory = createLiveHistoryStore(env.LIVE_HISTORY_PATH || path.join(runtimeDir, 'live-results-2026.json'));
const loadLiveFeed = createGeLiveSource();
const readLiveFeed = createLiveFeedCache(async () => {
  const feed = await loadLiveFeed();
  const enriched = { ...feed, ...(await addToHistory(feed)) };
  // Eventos (gol, início, fim) disparam notificações sem atrasar a resposta.
  seasonService
    .update(enriched)
    .then((events) => pushNotifier.notify(events))
    .catch((error) => console.error(`Atualização do estado da temporada falhou: ${error.message}`));
  return enriched;
});

const sharedScenarios = createSharedScenarioStore(adminClient);
const handler = createRequestHandler({
  root,
  production,
  trustProxy: env.TRUST_PROXY === '1',
  siteUrl,
  readLiveFeed,
  seasonService,
  publicConfig: {
    ...supabaseConfig,
    vapidPublicKey: pushNotifier.publicKey,
    shortLinks: sharedScenarios.enabled,
    oddsComparison: oddsTracker.enabled,
  },
  deleteAccount: createAccountDeleter({
    supabaseUrl: supabaseConfig.supabaseUrl,
    publicKey: supabaseConfig.supabaseKey,
    adminClient,
  }),
  sharedScenarios,
  renderScenarioImage: createOgRenderer({ root }),
  oddsTracker,
});

const server = createServer(handler);
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  console.log(`SimulaBR em http://${host}:${port}`);
  const features = [
    ['contas', supabaseConfig.authConfigured],
    ['exclusão de conta e links curtos', Boolean(adminClient)],
    ['notificações push', pushNotifier.enabled],
    ['comparação com o mercado', oddsTracker.enabled],
    ['URL pública (SITE_URL)', Boolean(siteUrl)],
  ];
  for (const [name, enabled] of features) console.log(`  ${enabled ? '✓' : '·'} ${name}`);
});

// Com jogo em andamento a fonte é consultada a cada minuto; fora disso, a cada 2.
const LIVE_REFRESH_MS = 60_000;
const IDLE_REFRESH_MS = 120_000;
let refreshTimer;
async function refreshInBackground({ forceRefresh = true } = {}) {
  let hasLiveMatch = false;
  try {
    const feed = await readLiveFeed({ forceRefresh });
    hasLiveMatch = feed.matches.some((match) => match.status === 'live');
  } catch (error) {
    console.error(`Atualização periódica do GE falhou: ${error.message || String(error)}`);
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshInBackground, hasLiveMatch ? LIVE_REFRESH_MS : IDLE_REFRESH_MS);
  refreshTimer.unref();
}
refreshInBackground({ forceRefresh: false });

// Odds: 4 consultas por dia cabem no plano gratuito da the-odds-api.
async function refreshOdds() {
  if (!oddsTracker.enabled) return;
  try {
    const { seasonData, standings, round } = seasonService.state;
    const teams = Object.keys(seasonData.teams);
    await oddsTracker.refresh({
      openFixtures: openFixturesFrom(seasonData.fixtures, round?.number),
      matchModel: createMatchModel({ teams, results: seasonData.results, standings, settings: DEFAULT_SETTINGS }),
    });
  } catch (error) {
    console.error(`Consulta de odds falhou: ${error.message}`);
  }
}
setTimeout(refreshOdds, 30_000).unref();
setInterval(refreshOdds, 6 * 60 * 60_000).unref();
