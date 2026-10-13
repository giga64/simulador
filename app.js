import { validateSeasonData } from './src/season-data.js';
import { pickScore } from './src/model/pick-score.js';
import { addHeadToHeadResult, emptyHeadToHead, rankTeams as rankByCriteria } from './src/model/standings.js';
import { DEFAULT_ITERATIONS, conditionalChances, histogramQuantile } from './src/model/monte-carlo.js';
import { buildSimulationInput, createMatchModel, DEFAULT_SETTINGS } from './src/model/season-model.js';
import { collectLiveMatches, standingsWithoutLiveMatches } from './src/model/live-matches.js';
import { createSimulationRunner } from './src/client/simulation-runner.js';
import { lineChart, meter, positionMap, safeUrl, segmented, signed } from './src/client/ui.js';
import { pathFor, routeFromPath } from './src/client/routes.js';
import {
  bracket as cupBracket,
  chanceTable as cupChanceTable,
  crest as cupCrest,
  groupTables as cupGroupTables,
  rulesList as cupRules,
} from './src/client/cups.js';
import { COMPETITION_IDS, COMPETITIONS } from './src/competitions/formats.js';
import { libertadoresSlots } from './src/competitions/qualification.js';
import { createStrength, simulateKnockout } from './src/competitions/simulate.js';
import { backtestModel } from './src/model/backtest.js';
import { buildSplitTable, SPLIT_MODES } from './src/model/standings-splits.js';
import { clinchSafety, clinchTopN, describeGoal } from './src/model/math-scenarios.js';
import {
  decodeScenarioPayload,
  encodeScenarioPayload,
  makeBackup,
  pruneCompletedScenarioScores,
  validateScenarioPayload,
} from './src/scenario.js';
import { createTeamCodeResolver, mergeLiveSeason } from './src/live-season.js';
import { assessHistoryCoverage, mergeVerifiedResults } from './src/history-integrity.js';
import {
  archiveCompletedPredictions,
  createModelSnapshot,
  summarizeCalibrationByRound,
  summarizePredictionCalibration,
  summarizePredictionPerformance,
  upsertPredictionSnapshot,
  validatePredictionHistory,
} from './src/prediction-performance.js';

// Erros de JavaScript dos visitantes vão para o servidor (sem dados pessoais,
// no máximo 5 por visita, sem repetir a mesma mensagem).
(() => {
  const sent = new Set();
  const report = (details) => {
    const message = String(details.message || '').slice(0, 300);
    if (!message || sent.has(message) || sent.size >= 5) return;
    sent.add(message);
    const body = JSON.stringify({
      ...details,
      message,
      url: location.href,
      view: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.view || '',
    });
    fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  };
  addEventListener('error', (event) =>
    report({
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack,
    }),
  );
  addEventListener('unhandledrejection', (event) =>
    report({ message: `Promessa rejeitada: ${event.reason?.message || event.reason}`, stack: event.reason?.stack }),
  );
})();

(async () => {
  let validationWarnings = [];
  const LIVE_FEED_CACHE_KEY = 'br26-last-good-live-feed';
  const showLoadError = (error) => {
    const main = document.querySelector('main'),
      message = String(error.message || error).replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
      );
    main.innerHTML = `<div class="cd warn" role="alert"><h1>N\u00e3o foi poss\u00edvel carregar os dados do simulador</h1><p>Confira se os arquivos <code>data/season-2026.json</code> e <code>assets/logos.json</code> foram publicados junto com esta p\u00e1gina. Detalhes: ${message}</p></div>`;
  };
  try {
    const [seasonResponse, logoResponse, backfillResponse] = await Promise.all([
      fetch('data/season-2026.json', { cache: 'no-cache' }),
      fetch('assets/logos.json', { cache: 'no-cache' }),
      fetch('data/historical-backfill-2026.json', { cache: 'no-cache' }),
    ]);
    if (!seasonResponse.ok || !logoResponse.ok || !backfillResponse.ok)
      throw new Error(
        'Falha HTTP ao carregar os arquivos de dados da temporada, dos escudos ou da reconciliação histórica.',
      );
    const [snapshot, logoData, backfill] = await Promise.all([
      seasonResponse.json(),
      logoResponse.json(),
      backfillResponse.json(),
    ]);
    const snapshotValidation = validateSeasonData(snapshot, logoData);
    if (snapshotValidation.errors.length) throw new Error(snapshotValidation.errors.join(' '));
    const reconciledSnapshot = mergeVerifiedResults(snapshot, backfill);
    const reconciliationValidation = validateSeasonData(reconciledSnapshot, logoData);
    if (reconciliationValidation.errors.length) throw new Error(reconciliationValidation.errors.join(' '));
    let liveFeed = null,
      liveFeedError = '',
      liveFeedCacheWarning = '';
    try {
      const response = await fetch('/api/live-season', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      liveFeed = await response.json();
    } catch (error) {
      liveFeedError = error.message || String(error);
    }
    if (!liveFeed) {
      try {
        const cachedValue = localStorage.getItem(LIVE_FEED_CACHE_KEY);
        if (cachedValue) {
          const cachedFeed = JSON.parse(cachedValue);
          if (
            !cachedFeed ||
            typeof cachedFeed.fetchedAt !== 'string' ||
            !Number.isFinite(Date.parse(cachedFeed.fetchedAt)) ||
            typeof cachedFeed.source?.name !== 'string'
          )
            throw new Error('A cópia local não tem data ou fonte válidas.');
          const cachedSeason = mergeLiveSeason(reconciledSnapshot, cachedFeed);
          const cachedValidation = validateSeasonData(cachedSeason.seasonData, logoData);
          if (cachedValidation.errors.length) throw new Error(cachedValidation.errors.join(' '));
          liveFeed = {
            ...cachedFeed,
            stale: true,
            checkedAt: new Date().toISOString(),
            warning: `Fonte indisponível; mostrando a última consulta bem-sucedida de ${cachedFeed.fetchedAt}.`,
          };
        }
      } catch (error) {
        liveFeedCacheWarning = `Não foi possível usar o último feed salvo neste navegador: ${error.message || String(error)}`;
        liveFeedError += `${liveFeedError ? '; ' : ''}${liveFeedCacheWarning}`;
        console.error(liveFeedCacheWarning, error);
      }
    }
    let merged;
    try {
      merged = mergeLiveSeason(reconciledSnapshot, liveFeed);
      const liveValidation = validateSeasonData(merged.seasonData, logoData);
      if (liveValidation.errors.length) throw new Error(liveValidation.errors.join(' '));
      validationWarnings = [...snapshotValidation.warnings, ...liveValidation.warnings, ...merged.warnings];
      if (liveFeed && !liveFeed.stale) {
        try {
          localStorage.setItem(LIVE_FEED_CACHE_KEY, JSON.stringify(liveFeed));
        } catch (error) {
          liveFeedCacheWarning = `Feed atualizado, mas não foi possível guardar a última consulta neste navegador: ${error.message || String(error)}`;
          console.error(liveFeedCacheWarning, error);
        }
      }
    } catch (error) {
      liveFeed = null;
      liveFeedError = `Feed ignorado por validação: ${error.message || String(error)}`;
      merged = mergeLiveSeason(reconciledSnapshot, null);
      validationWarnings = snapshotValidation.warnings;
    }
    if (!liveFeed && !liveFeedError) liveFeedError = 'A consulta ao vivo não retornou dados.';

    // Dados que não mudam durante a sessão.
    const {
      teams: NM,
      stadiums: STD,
      champions: CH,
      relegationByPoints: UF,
      source: dataSource,
      qualificationModel: Q,
    } = merged.seasonData;
    const LOGO = logoData.logos;
    const T = Object.keys(NM),
      AB = { BRA: 'RBB' },
      ab = (c) => AB[c] || c,
      teamCode = createTeamCodeResolver(NM);
    const SIMULATIONS = DEFAULT_ITERATIONS,
      SIMULATIONS_LABEL = SIMULATIONS.toLocaleString('pt-BR');
    const ROUND_OPTIONS = [...new Set(merged.seasonData.fixtures.map((fixture) => fixture.round))].sort(
      (a, b) => a - b,
    );
    const VERIFIED_BACKFILL_COUNT = backfill.results.length;
    const LEGACY_MATCHES = snapshot.fixtures.filter((f) => f.status !== 'played');
    function matchDateParts(date) {
      const parts = new Intl.DateTimeFormat('pt-BR', {
          weekday: 'short',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone: 'America/Sao_Paulo',
        }).formatToParts(date),
        part = (type) => parts.find((item) => item.type === type)?.value || '';
      return {
        weekday: part('weekday').replace('.', '').slice(0, 3).toLocaleUpperCase('pt-BR'),
        day: part('day'),
        month: part('month'),
        hour: part('hour'),
        minute: part('minute'),
      };
    }

    // Dados derivados do feed: recalculados a cada atualização em segundo plano,
    // sem recarregar a página.
    let seasonData,
      ALL_FIXTURES,
      rawResults,
      dataUpdatedAt,
      FEED_STANDINGS,
      LIVE_STANDINGS,
      LIVE_ROUND,
      LIVE_MATCHES = [],
      LIVE_BY_ID = new Map(),
      HISTORY_COVERAGE,
      M,
      DEFAULT_ROUND,
      RES,
      RM,
      TS,
      base,
      gH,
      gA,
      LG,
      realPos;
    function applySeasonState(next) {
      seasonData = next.seasonData;
      ({ fixtures: ALL_FIXTURES, results: rawResults, updatedAt: dataUpdatedAt } = seasonData);
      FEED_STANDINGS = next.standingsByCode;
      LIVE_ROUND = next.round;
      LIVE_MATCHES = liveFeed ? collectLiveMatches(liveFeed, ALL_FIXTURES, { resolveTeam: teamCode }) : [];
      LIVE_BY_ID = new Map(LIVE_MATCHES.map((match) => [match.fixtureId, match]));
      const knownMatches = Object.fromEntries(T.map((code) => [code, 0]));
      rawResults.forEach((result) => {
        knownMatches[result.home]++;
        knownMatches[result.away]++;
      });
      // Classificação sem os jogos em andamento: o placar parcial entra uma única vez, pelo simulador.
      LIVE_STANDINGS = standingsWithoutLiveMatches(FEED_STANDINGS, LIVE_MATCHES, knownMatches).standings;
      HISTORY_COVERAGE = assessHistoryCoverage(rawResults, LIVE_STANDINGS, NM);
      M = ALL_FIXTURES.filter(
        (f) => f.status !== 'played' && (f.status === 'postponed' || !LIVE_ROUND || f.round >= LIVE_ROUND.number),
      ).map((f) => ({
        k: f.id,
        r: f.round,
        round: f.round,
        h: f.home,
        a: f.away,
        dt: f.kickoff ? new Date(f.kickoff) : null,
        st: f.stadium,
        late: f.status === 'postponed',
      }));
      DEFAULT_ROUND = ROUND_OPTIONS.includes(LIVE_ROUND?.number)
        ? LIVE_ROUND.number
        : (ROUND_OPTIONS.find((round) => M.some((m) => m.r === round && !m.late)) ?? ROUND_OPTIONS[0] ?? 1);
      RES = rawResults.map((m) => ({ r: m.round - 1, h: m.home, a: m.away, x: m.homeGoals, y: m.awayGoals }));
      RM = {};
      RES.forEach((m) => (RM[m.h + '-' + m.a] = m));
      const mk = () => ({ n: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 });
      TS = {};
      T.forEach((c) => (TS[c] = { h: mk(), a: mk(), f: [], cs: 0 }));
      RES.forEach((m) => {
        const H = TS[m.h],
          A = TS[m.a];
        [
          [H.h, m.x, m.y],
          [A.a, m.y, m.x],
        ].forEach(([o, f, g]) => {
          o.n++;
          o.gf += f;
          o.ga += g;
          f > g ? o.w++ : f < g ? o.l++ : o.d++;
        });
        H.f.push(m.x > m.y ? 'V' : m.x < m.y ? 'D' : 'E');
        A.f.push(m.y > m.x ? 'V' : m.y < m.x ? 'D' : 'E');
        if (!m.y) H.cs++;
        if (!m.x) A.cs++;
      });
      base = {};
      T.forEach((c) => {
        const h = TS[c].h,
          a = TS[c].a;
        base[c] = {
          P: 3 * (h.w + a.w) + h.d + a.d,
          J: h.n + a.n,
          V: h.w + a.w,
          E: h.d + a.d,
          D: h.l + a.l,
          GP: h.gf + a.gf,
          GC: h.ga + a.ga,
        };
      });
      if (LIVE_STANDINGS)
        for (const [code, entry] of LIVE_STANDINGS)
          base[code] = {
            ...base[code],
            P: entry.points,
            J: entry.matches,
            V: entry.wins,
            E: entry.draws,
            D: entry.losses,
            GP: entry.goalsFor,
            GC: entry.goalsAgainst,
          };
      gH = RES.reduce((s, m) => s + m.x, 0) / RES.length;
      gA = RES.reduce((s, m) => s + m.y, 0) / RES.length;
      LG = (() => {
        const n = RES.length,
          o = { n, gols: 0, H: 0, D: 0, A: 0, btts: 0, o25: 0, z: 0, sc: {}, dr: [], gr: [] };
        RES.forEach((m) => {
          o.gols += m.x + m.y;
          m.x > m.y ? o.H++ : m.x < m.y ? o.A++ : o.D++;
          if (m.x && m.y) o.btts++;
          if (m.x + m.y > 2) o.o25++;
          if (!m.x && !m.y) o.z++;
          const k = m.x + '-' + m.y;
          o.sc[k] = (o.sc[k] || 0) + 1;
        });
        for (let r = 0; r < 38; r++) {
          const L = RES.filter((m) => m.r == r);
          o.dr.push(L.filter((m) => m.x == m.y).length);
          o.gr.push(L.length ? L.reduce((s, m) => s + m.x + m.y, 0) / L.length : 0);
        }
        return o;
      })();
      // Posição atual (sem palpites nem jogos em andamento), base das setas ▲▼ da tabela.
      realPos = {};
      if (LIVE_STANDINGS) LIVE_STANDINGS.forEach((entry, code) => (realPos[code] = entry.position - 1));
      else {
        const headToHead = emptyHeadToHead(T);
        RES.forEach((m) => addHeadToHeadResult(headToHead, m.h, m.a, m.x, m.y));
        rankByCriteria(base, T, { headToHead }).forEach((c, i) => (realPos[c] = i));
      }
    }
    applySeasonState(merged);
    let statsTeam = LIVE_STANDINGS?.keys().next().value || T[0];
    let snapshotStatsTeam = 'all',
      snapshotStatsRound = 'all',
      modelPanelOpen = false,
      tourStep = 0;
    const METH = {
      ml: [
        'Resultado mais provável (modelo)',
        'Para cada jogo, escolhe o resultado (vitória, empate ou derrota) com maior probabilidade no modelo e o placar mais provável dentro dele.',
      ],
      sample: [
        'Sorteio ponderado (modelo)',
        'Sorteia o placar conforme as probabilidades do modelo: reproduz a incerteza e as zebras reais do futebol.',
      ],
      fav: [
        'Favoritos sempre vencem',
        'Nunca empata: o time com maior chance de vencer (segundo o modelo) leva o jogo.',
      ],
      home: ['Mandante sempre vence', 'Todos os jogos terminam 1x0 para o mandante.'],
      draw: ['Tudo empata', 'Todos os jogos terminam 1x1.'],
    };
    const $ = (s) => document.querySelector(s),
      escapeHtml = (value) =>
        String(value ?? '').replace(
          /[&<>"']/g,
          (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
        ),
      formatLiveTime = (value) =>
        value
          ? new Intl.DateTimeFormat('pt-BR', {
              dateStyle: 'short',
              timeStyle: 'short',
              timeZone: 'America/Sao_Paulo',
            }).format(new Date(value))
          : 'indisponível';
    let SC = {},
      tab = DEFAULT_ROUND,
      team = '',
      MCR = null,
      tmr,
      view = 'home',
      MCR_PRE_LIVE = null,
      sortK = 'pts',
      sortD = -1,
      open = {};
    let opt = { full: false, odds: true, meth: 'ml' },
      SET = { ...DEFAULT_SETTINGS, adj: {} };
    let storageWarningShown = false;
    // Configuração pública do servidor (/api/config): links curtos, push, odds.
    let PUBLIC_CONFIG = {};
    let predictionHistory = [];
    let anonymousPredictionHistory = [];
    let signedInUser = null;
    let supabaseClient = null;
    let supabaseConfigError = '';
    let accountDialog = null;
    let authMode = 'login';
    let authBusy = false;
    let authStatus = '';
    let accountPrompt = '';
    let savedScenarios = [];
    let favoriteTeams = [];
    let accountPreferences = { inSiteReminders: false, reminderMinutes: 30 };
    let selectedHistoryRound = Math.max(1, (LIVE_ROUND?.number || 1) - 1);
    let siteSearch = '';
    let reminderStorageWarningShown = false;
    const remindedFixtures = new Set();
    const notify = (message) => {
      const toast = $('#toast');
      if (!toast) return;
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(notify.timer);
      notify.timer = setTimeout(() => {
        toast.hidden = true;
      }, 5000);
    };
    const predictionStorageKey = () =>
      signedInUser ? `br26predictionHistory:${signedInUser.id}` : 'br26predictionHistory';
    let accountSaveTimer;
    let accountSaveQueue = Promise.resolve();
    const savePredictionHistory = () => {
      try {
        localStorage.setItem(predictionStorageKey(), JSON.stringify(predictionHistory));
      } catch (error) {
        if (!storageWarningShown) {
          storageWarningShown = true;
          notify(`Não foi possível salvar o histórico de palpites neste navegador: ${error.message}`);
        }
      }
      if (!signedInUser) anonymousPredictionHistory = predictionHistory;
      if (signedInUser && supabaseClient) scheduleAccountPredictionSave();
    };
    try {
      const storedHistory = JSON.parse(localStorage.getItem('br26predictionHistory') || '[]');
      predictionHistory = validatePredictionHistory(storedHistory, ALL_FIXTURES, T);
      anonymousPredictionHistory = predictionHistory;
    } catch (error) {
      storageWarningShown = true;
      queueMicrotask(() => notify(`O histórico de desempenho não pôde ser restaurado: ${error.message}`));
    }
    const payloadFromState = () => ({
      version: 1,
      scores: SC,
      settings: { k: SET.k, ha: SET.ha, rho: SET.rho, seed: SET.seed, adjustments: SET.adj },
      options: { full: opt.full, odds: opt.odds, method: opt.meth },
    });
    try {
      const saved = JSON.parse(localStorage.getItem('br26c') || 'null');
      if (saved) {
        const captured = archiveCompletedPredictions(
          predictionHistory,
          saved.SC || {},
          ALL_FIXTURES,
          rawResults,
          new Date().toISOString(),
          dataSource,
        );
        if (captured.added || captured.updated) {
          predictionHistory = captured.history;
          savePredictionHistory();
        }
        const savedSettings = { ...SET, ...saved.SET, adj: saved.SET?.adj || {} };
        // k=6 era o padrão antigo; quem não mexeu no ajuste passa ao padrão atual (k=14).
        if (!saved.settingsVersion && savedSettings.k === 6) savedSettings.k = DEFAULT_SETTINGS.k;
        if (saved.SET && !Number.isInteger(saved.SET.seed)) savedSettings.seed = SET.seed;
        const savedScores = pruneCompletedScenarioScores(
          saved.SC || {},
          ALL_FIXTURES,
          LIVE_ROUND?.number,
          M.map((m) => m.k),
        );
        const check = validateScenarioPayload(
          {
            version: 1,
            scores: savedScores.scores,
            settings: {
              k: savedSettings.k,
              ha: savedSettings.ha,
              rho: savedSettings.rho,
              seed: savedSettings.seed,
              adjustments: savedSettings.adj,
            },
            options: { full: saved.opt?.full ?? true, odds: saved.opt?.odds ?? true, method: saved.opt?.meth || 'ml' },
          },
          M.map((m) => m.k),
          T,
        );
        if (check.errors.length) throw new Error(check.errors.join(' '));
        SC = savedScores.scores;
        SET = savedSettings;
        opt = { ...opt, ...saved.opt };
        if (savedScores.removed) {
          save();
          queueMicrotask(() =>
            notify(
              `${savedScores.removed} palpite(s) de partidas já concluídas foram removidos; os demais foram mantidos.`,
            ),
          );
        }
      }
    } catch (error) {
      SC = {};
      storageWarningShown = true;
      queueMicrotask(() => notify(`N\u00e3o foi poss\u00edvel restaurar o cen\u00e1rio salvo: ${error.message}`));
    }
    const save = () => {
      try {
        localStorage.setItem('br26c', JSON.stringify({ SC, SET, opt, settingsVersion: 2 }));
      } catch (error) {
        if (!storageWarningShown) {
          storageWarningShown = true;
          notify(`N\u00e3o foi poss\u00edvel salvar neste navegador: ${error.message}`);
        }
      }
    };
    function predictionToRow(entry, userId) {
      return {
        user_id: userId,
        fixture_id: entry.fixtureId,
        round: entry.round,
        home_team: entry.home,
        away_team: entry.away,
        prediction: entry.prediction,
        model_snapshot: entry.modelSnapshot || null,
        actual: entry.actual || null,
        result_source: entry.resultSource || null,
        recorded_at: entry.recordedAt,
      };
    }
    function predictionFromRow(row) {
      const fixture = ALL_FIXTURES.find((match) => match.id === row.fixture_id);
      if (!fixture) throw new Error(`A conta contém um palpite para uma partida desconhecida (${row.fixture_id}).`);
      return {
        fixtureId: fixture.id,
        round: fixture.round,
        home: fixture.home,
        away: fixture.away,
        prediction: row.prediction,
        modelSnapshot: row.model_snapshot || undefined,
        actual: row.actual || undefined,
        resultSource: row.result_source || undefined,
        recordedAt: row.recorded_at,
      };
    }
    function scheduleAccountPredictionSave() {
      if (!signedInUser || !supabaseClient) return;
      clearTimeout(accountSaveTimer);
      const userId = signedInUser.id,
        client = supabaseClient,
        rows = predictionHistory.map((entry) => predictionToRow(entry, userId));
      accountSaveTimer = setTimeout(() => {
        accountSaveQueue = accountSaveQueue
          .then(async () => {
            if (signedInUser?.id !== userId) return;
            if (!rows.length) return;
            const { error } = await client
              .from('prediction_snapshots')
              .upsert(rows, { onConflict: 'user_id,fixture_id' });
            if (error) throw new Error(error.message);
          })
          .catch((error) => notify(`Não foi possível sincronizar seus palpites com a conta: ${error.message}`));
      }, 350);
    }
    function deleteAccountPrediction(fixtureId) {
      if (!signedInUser || !supabaseClient) return;
      clearTimeout(accountSaveTimer);
      const userId = signedInUser.id,
        client = supabaseClient;
      accountSaveQueue = accountSaveQueue
        .then(async () => {
          const { error } = await client
            .from('prediction_snapshots')
            .delete()
            .eq('user_id', userId)
            .eq('fixture_id', fixtureId);
          if (error) throw new Error(error.message);
        })
        .catch((error) => notify(`O palpite foi removido deste navegador, mas não da conta: ${error.message}`));
    }
    async function loadAccountPredictionHistory(user) {
      let local = [];
      try {
        local = validatePredictionHistory(
          JSON.parse(localStorage.getItem(`br26predictionHistory:${user.id}`) || '[]'),
          ALL_FIXTURES,
          T,
        );
      } catch (error) {
        throw new Error(`O cache local da conta não pôde ser lido: ${error.message}`);
      }
      predictionHistory = local;
      if (view === 'perf') renderPerformance();
      const { data, error } = await supabaseClient.from('prediction_snapshots').select('*').eq('user_id', user.id);
      if (error) throw new Error(`Não foi possível carregar os palpites da conta: ${error.message}`);
      const remote = validatePredictionHistory((data || []).map(predictionFromRow), ALL_FIXTURES, T);
      const merged = new Map(remote.map((entry) => [entry.fixtureId, entry]));
      for (const entry of local) {
        const previous = merged.get(entry.fixtureId);
        if (!previous || Date.parse(entry.recordedAt) > Date.parse(previous.recordedAt))
          merged.set(entry.fixtureId, entry);
      }
      if (signedInUser?.id !== user.id) return;
      const completed = archiveCompletedPredictions(
        [...merged.values()],
        {},
        ALL_FIXTURES,
        rawResults,
        new Date().toISOString(),
        dataSource,
      );
      predictionHistory = validatePredictionHistory(completed.history, ALL_FIXTURES, T);
      savePredictionHistory();
      if (view === 'perf') renderPerformance();
    }
    async function loadAccountWorkspace(user) {
      const [scenarioResult, preferenceResult] = await Promise.all([
        supabaseClient
          .from('saved_scenarios')
          .select('*')
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false }),
        supabaseClient.from('user_preferences').select('*').eq('user_id', user.id).maybeSingle(),
      ]);
      if (scenarioResult.error)
        throw new Error(`Não foi possível carregar seus cenários: ${scenarioResult.error.message}`);
      if (preferenceResult.error)
        throw new Error(`Não foi possível carregar suas preferências: ${preferenceResult.error.message}`);
      savedScenarios = (scenarioResult.data || []).map((row) => {
        const checked = validatedPayload(row.scenario);
        if (
          typeof row.id !== 'string' ||
          typeof row.name !== 'string' ||
          row.name.trim().length < 1 ||
          row.name.length > 60 ||
          !Number.isFinite(Date.parse(row.updated_at))
        )
          throw new Error('A conta contém um cenário salvo inválido.');
        return { id: row.id, name: row.name, scenario: checked, updatedAt: row.updated_at };
      });
      const preferences = preferenceResult.data;
      if (
        preferences &&
        (!Array.isArray(preferences.favorite_teams) ||
          preferences.favorite_teams.some((code) => !T.includes(code)) ||
          typeof preferences.in_site_reminders !== 'boolean' ||
          ![5, 15, 30, 60, 120].includes(preferences.reminder_minutes))
      )
        throw new Error('As preferências da conta contêm valores inválidos.');
      favoriteTeams = preferences?.favorite_teams || [];
      accountPreferences = {
        inSiteReminders: preferences?.in_site_reminders === true,
        reminderMinutes: Number.isInteger(preferences?.reminder_minutes) ? preferences.reminder_minutes : 30,
      };
      if (view === 'account') renderAccountWorkspace();
      if (view === 'clubs') renderClubPage();
      if (view === 'home') renderHome();
    }
    async function saveAccountPreferences() {
      if (!signedInUser || !supabaseClient) throw new Error('Entre na conta para sincronizar suas preferências.');
      const { error } = await supabaseClient.from('user_preferences').upsert(
        {
          user_id: signedInUser.id,
          favorite_teams: favoriteTeams,
          in_site_reminders: accountPreferences.inSiteReminders,
          reminder_minutes: accountPreferences.reminderMinutes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw new Error(`Não foi possível salvar suas preferências: ${error.message}`);
    }
    async function updateReminderPreference(key, value) {
      const previous = { ...accountPreferences };
      accountPreferences = { ...accountPreferences, [key]: value };
      try {
        await saveAccountPreferences();
      } catch (error) {
        accountPreferences = previous;
        renderAccountWorkspace();
        throw error;
      }
    }
    async function saveNamedScenario(name) {
      if (!signedInUser || !supabaseClient) {
        notify('Entre na conta para salvar cenários entre dispositivos.');
        openAccountDialog();
        return;
      }
      if (view !== 'account') {
        show('account');
        $('#scenarioName')?.focus();
        notify('Dê um nome ao cenário na aba Minha conta para salvá-lo.');
        return;
      }
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName.length > 60) {
        notify('O nome precisa ter entre 1 e 60 caracteres.');
        return;
      }
      const { data, error } = await supabaseClient
        .from('saved_scenarios')
        .insert({
          user_id: signedInUser.id,
          name: cleanName,
          scenario: payloadFromState(),
        })
        .select('*')
        .single();
      if (error) throw new Error(`Não foi possível salvar o cenário: ${error.message}`);
      savedScenarios = [
        {
          id: data.id,
          name: data.name,
          scenario: validatedPayload(data.scenario),
          updatedAt: data.updated_at,
        },
        ...savedScenarios,
      ];
      renderAccountWorkspace();
      notify('Cenário salvo na sua conta.');
    }
    async function removeSavedScenario(id) {
      if (!signedInUser || !supabaseClient) return;
      if (!window.confirm('Excluir este cenário salvo da sua conta?')) return;
      const { error } = await supabaseClient
        .from('saved_scenarios')
        .delete()
        .eq('id', id)
        .eq('user_id', signedInUser.id);
      if (error) throw new Error(`Não foi possível excluir o cenário: ${error.message}`);
      savedScenarios = savedScenarios.filter((scenario) => scenario.id !== id);
      renderAccountWorkspace();
    }
    async function toggleFavorite(code) {
      if (!T.includes(code)) throw new Error('Clube inválido.');
      if (!signedInUser) {
        openAccountDialog(
          'register',
          'Entre ou crie uma conta para acompanhar clubes favoritos e sincronizá-los com seus lembretes.',
        );
        return;
      }
      const previous = favoriteTeams;
      favoriteTeams = favoriteTeams.includes(code)
        ? favoriteTeams.filter((item) => item !== code)
        : [...favoriteTeams, code];
      try {
        await saveAccountPreferences();
      } catch (error) {
        favoriteTeams = previous;
        throw error;
      }
      if (view === 'clubs' || view === 'account') renderAccountWorkspace();
      if (view === 'clubs') renderClubPage();
      if (view === 'home') renderHome();
    }
    async function updateProfileName(event) {
      event.preventDefault();
      const name = $('#profileName').value.trim();
      if (!name || name.length > 80) throw new Error('O nome precisa ter entre 1 e 80 caracteres.');
      const { data, error } = await supabaseClient.auth.updateUser({
        data: { ...signedInUser.user_metadata, display_name: name },
      });
      if (error) throw new Error(`Não foi possível atualizar o nome: ${error.message}`);
      signedInUser = data.user;
      renderAccountWorkspace();
      notify('Nome atualizado.');
    }
    async function updateAccountPassword(event) {
      event.preventDefault();
      const currentPassword = $('#currentPassword').value,
        newPassword = $('#newPassword').value;
      if (newPassword.length < 8) throw new Error('A nova senha precisa ter pelo menos 8 caracteres.');
      const { error: reauthError } = await supabaseClient.auth.signInWithPassword({
        email: signedInUser.email,
        password: currentPassword,
      });
      if (reauthError) throw new Error(`Não foi possível confirmar sua senha atual: ${reauthError.message}`);
      const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
      if (error) throw new Error(`Não foi possível atualizar a senha: ${error.message}`);
      renderAccountWorkspace();
      notify('Senha atualizada.');
    }
    async function deleteSignedInAccount(event) {
      event.preventDefault();
      const password = $('#deletePassword').value,
        confirmation = $('#deleteConfirm').value;
      if (confirmation !== 'EXCLUIR') throw new Error('Digite EXCLUIR para confirmar.');
      if (
        !window.confirm(
          'Excluir permanentemente sua conta, palpites e cenários salvos? Esta ação não pode ser desfeita.',
        )
      )
        return;
      const { data, error: reauthError } = await supabaseClient.auth.signInWithPassword({
        email: signedInUser.email,
        password,
      });
      if (reauthError) throw new Error(`Não foi possível confirmar sua senha: ${reauthError.message}`);
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const { error: signOutError } = await supabaseClient.auth.signOut({ scope: 'local' });
      if (signOutError) console.error('Conta excluída, mas a sessão local não foi limpa:', signOutError.message);
      signedInUser = null;
      savedScenarios = [];
      predictionHistory = anonymousPredictionHistory;
      renderAccountButton();
      renderAccountWorkspace();
      notify('Conta e dados associados foram excluídos.');
    }
    function ensureAccountDialog() {
      if (accountDialog) return;
      accountDialog = document.createElement('div');
      accountDialog.id = 'accountDialog';
      accountDialog.className = 'auth-overlay';
      accountDialog.hidden = true;
      accountDialog.setAttribute('role', 'dialog');
      accountDialog.setAttribute('aria-modal', 'true');
      accountDialog.setAttribute('aria-labelledby', 'account-title');
      accountDialog.innerHTML = '<div class="auth-box"></div>';
      accountDialog.addEventListener('click', (event) => {
        if (event.target === accountDialog) closeAccountDialog();
      });
      document.body.append(accountDialog);
    }
    function renderAccountDialog() {
      ensureAccountDialog();
      const titles = {
        login: 'Entrar na sua conta',
        register: 'Criar conta',
        forgot: 'Recuperar senha',
        reset: 'Definir nova senha',
      };
      const description = {
        login: 'Acesse seus palpites e snapshots do modelo em qualquer sessão.',
        register:
          'Crie uma conta grátis para salvar palpites e cenários, escolher clubes favoritos e configurar lembretes.',
        forgot: 'Enviaremos um link de recuperação para o e-mail informado.',
        reset: 'Escolha uma nova senha para sua conta.',
      };
      const hasPassword = authMode === 'login' || authMode === 'register' || authMode === 'reset';
      const hasName = authMode === 'register';
      const box = accountDialog.querySelector('.auth-box');
      box.innerHTML = `<button type="button" class="auth-close" data-auth-action="close" aria-label="Fechar">×</button><h2 id="account-title">${titles[authMode]}</h2><p>${description[authMode]}</p>${supabaseConfigError ? `<p class="warn auth-message" role="alert">${escapeHtml(supabaseConfigError)}</p>` : ''}<form id="accountForm"><label for="account-email">E-mail</label><input id="account-email" type="email" autocomplete="email" required ${authBusy || supabaseConfigError ? 'disabled' : ''}>${hasName ? '<label for="account-name">Nome</label><input id="account-name" type="text" autocomplete="name" maxlength="80" required>' : ''}${hasPassword ? `<label for="account-password">${authMode === 'reset' ? 'Nova senha' : 'Senha'}</label><input id="account-password" type="password" autocomplete="${authMode === 'register' || authMode === 'reset' ? 'new-password' : 'current-password'}" minlength="8" required ${authBusy || supabaseConfigError ? 'disabled' : ''}>` : ''}${authMode === 'register' || authMode === 'reset' ? '<label for="account-confirm">Confirmar senha</label><input id="account-confirm" type="password" autocomplete="new-password" minlength="8" required>' : ''}<button type="submit" class="p" ${authBusy || supabaseConfigError ? 'disabled' : ''}>${authBusy ? 'Aguarde…' : authMode === 'login' ? 'Entrar' : authMode === 'register' ? 'Criar conta' : authMode === 'forgot' ? 'Enviar link' : 'Salvar nova senha'}</button></form><p class="auth-message" role="status" aria-live="polite">${escapeHtml(authStatus)}</p><div class="auth-links">${authMode !== 'login' ? '<button type="button" data-auth-action="login">Voltar ao login</button>' : ''}${authMode === 'login' ? '<button type="button" data-auth-action="register">Criar conta</button><button type="button" data-auth-action="forgot">Esqueci minha senha</button>' : ''}</div>`;
      if (accountPrompt) {
        const prompt = document.createElement('p');
        prompt.className = 'auth-message account-prompt';
        prompt.setAttribute('role', 'status');
        prompt.textContent = accountPrompt;
        box.querySelector('#accountForm').before(prompt);
      }
      box.querySelector('#accountForm').addEventListener('submit', submitAccountForm);
      box.querySelectorAll('[data-auth-action]').forEach((button) =>
        button.addEventListener('click', () => {
          if (button.dataset.authAction === 'close') {
            accountPrompt = '';
            closeAccountDialog();
            return;
          }
          const email = box.querySelector('#account-email')?.value || '';
          authMode = button.dataset.authAction;
          authStatus = '';
          accountPrompt = '';
          renderAccountDialog();
          const emailInput = accountDialog.querySelector('#account-email');
          if (emailInput) emailInput.value = email;
          box.querySelector('input:not([disabled])')?.focus();
        }),
      );
    }
    function openAccountDialog(mode = 'login', prompt = '') {
      authMode = mode;
      authStatus = '';
      accountPrompt = prompt;
      renderAccountDialog();
      accountDialog.hidden = false;
      accountDialog.querySelector('input:not([disabled])')?.focus();
    }
    function closeAccountDialog() {
      if (!accountDialog) return;
      accountDialog.hidden = true;
      document.querySelector('#accountButton')?.focus();
    }
    function updateThemeButton() {
      const button = $('#themeButton');
      if (!button) return;
      const theme = document.documentElement.dataset.theme || 'auto';
      button.innerHTML = ic({ auto: 'theme', light: 'sun', dark: 'moon' }[theme]);
      const label = `Tema: ${{ auto: 'automático', light: 'claro', dark: 'escuro' }[theme]}. Clique para trocar.`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    function renderAccountButton() {
      const button = $('#accountButton');
      if (!button) return;
      const name = signedInUser?.user_metadata?.display_name || signedInUser?.email || '';
      button.innerHTML = signedInUser ? escapeHtml(name.trim().charAt(0).toUpperCase() || '?') : ic('user');
      button.classList.toggle('signed', Boolean(signedInUser));
      button.setAttribute('aria-label', signedInUser ? `Minha conta (${signedInUser.email})` : 'Entrar ou criar conta');
      button.title = signedInUser ? `Minha conta · ${signedInUser.email}` : 'Entrar ou criar conta';
      button.disabled = !supabaseClient && !supabaseConfigError;
    }
    async function submitAccountForm(event) {
      event.preventDefault();
      if (!supabaseClient || authBusy) return;
      const email = $('#account-email').value.trim(),
        password = $('#account-password')?.value || '';
      const name = $('#account-name')?.value.trim() || '';
      const confirmation = $('#account-confirm')?.value;
      if (confirmation != null && password !== confirmation) {
        authStatus = 'As senhas não coincidem.';
        renderAccountDialog();
        $('#account-email').value = email;
        if ($('#account-name')) $('#account-name').value = name;
        return;
      }
      authBusy = true;
      authStatus = '';
      renderAccountDialog();
      try {
        if (authMode === 'login') {
          const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
          if (error) throw error;
          closeAccountDialog();
        } else if (authMode === 'register') {
          if (!name) throw new Error('Informe seu nome.');
          const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { display_name: name } },
          });
          if (error) throw error;
          authStatus = data.session
            ? 'Conta criada e conectada.'
            : 'Conta criada. Confira seu e-mail para confirmar o cadastro.';
          if (data.session) closeAccountDialog();
        } else if (authMode === 'forgot') {
          const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: location.origin + location.pathname,
          });
          if (error) throw error;
          authStatus = 'Se o endereço estiver cadastrado, o link de redefinição será enviado.';
        } else {
          const { error } = await supabaseClient.auth.updateUser({ password });
          if (error) throw error;
          closeAccountDialog();
          notify('Senha atualizada.');
        }
      } catch (error) {
        authStatus = `Não foi possível concluir: ${error.message || String(error)}`;
      } finally {
        authBusy = false;
        if (!accountDialog.hidden) {
          renderAccountDialog();
          if ($('#account-email')) $('#account-email').value = email;
          if ($('#account-name')) $('#account-name').value = name;
        }
      }
    }
    async function activateAccountSession(user) {
      const nextId = user?.id || null;
      if ((signedInUser?.id || null) === nextId) {
        signedInUser = user;
        renderAccountButton();
        return;
      }
      clearTimeout(accountSaveTimer);
      signedInUser = user;
      if (user) {
        predictionHistory = [];
        renderAccountButton();
        await loadAccountPredictionHistory(user);
        await loadAccountWorkspace(user);
        notify(`Conectado como ${user.email}. Seus palpites serão sincronizados com a conta.`);
      } else {
        predictionHistory = anonymousPredictionHistory;
        savedScenarios = [];
        favoriteTeams = [];
        accountPreferences = { inSiteReminders: false, reminderMinutes: 30 };
        renderAccountButton();
        if (view === 'perf') renderPerformance();
        if (view === 'account') renderAccountWorkspace();
        if (view === 'clubs') renderClubPage();
        if (view === 'home') renderHome();
      }
    }
    async function initializeAccount() {
      renderAccountButton();
      try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();
        PUBLIC_CONFIG = config;
        if (!config.authConfigured) {
          supabaseConfigError =
            'Login ainda não configurado no servidor. Defina SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY após configurar o projeto e a tabela.';
          renderAccountButton();
          return;
        }
        if (!window.supabase?.createClient) throw new Error('O cliente Supabase não foi carregado.');
        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
          auth: {
            storage: window.sessionStorage,
            storageKey: 'br26-supabase-auth',
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        try {
          await activateAccountSession(data.session?.user || null);
        } catch (error) {
          notify(`Não foi possível sincronizar os palpites da conta: ${error.message}`);
          console.error(error);
        }
        supabaseClient.auth.onAuthStateChange((event, session) => {
          if (event === 'PASSWORD_RECOVERY') openAccountDialog('reset');
          void activateAccountSession(session?.user || null).catch((error) => {
            notify(`Falha ao preparar os dados da conta: ${error.message}`);
            console.error(error);
          });
        });
      } catch (error) {
        supabaseConfigError = `Autenticação indisponível: ${error.message || String(error)}`;
        renderAccountButton();
        notify(supabaseConfigError);
        console.error('Falha ao configurar Supabase Auth:', error);
      }
    }
    const IC = {
      theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 000-16z" fill="currentColor"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
      bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0"/>',
      dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>',
      wand: '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.2 5.8L21 11l-5.8 2.2L13 19l-2.2-5.8L5 11l5.8-2.2z"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
      share:
        '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>',
      cl: '<path d="M15 18l-6-6 6-6"/>',
      cr: '<path d="M9 18l6-6-6-6"/>',
      x: '<path d="M18 6L6 18M6 6l12 12"/>',
      cols: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
      chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
      img: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 8h.01M21 15l-5-5L5 21"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      down: '<path d="M12 3v12m0 0l-5-5m5 5l5-5M4 21h16"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
      alert: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
    };
    const ic = (n) => `<svg class="i" viewBox="0 0 24 24">${IC[n]}</svg>`;
    const stl = document.createElement('style');
    stl.textContent = Object.keys(LOGO)
      .map((c) => `.lg.${c}{background-image:url(${LOGO[c]})}`)
      .join('');
    document.head.appendChild(stl);
    const lg = (c) => `<i class="lg ${c}"></i>`,
      f1 = (n) => n.toFixed(1).replace('.', ','),
      pc = (v) => (v < 1 ? '<1%' : Math.round(v) + '%');
    // Modelo de partidas (gols esperados e placares), recriado quando os dados
    // ou os ajustes mudam. É o mesmo código usado pelo servidor.
    let MATCH_MODEL = null;
    const matchModel = () =>
      MATCH_MODEL ||
      (MATCH_MODEL = createMatchModel({ teams: T, results: rawResults, standings: LIVE_STANDINGS, settings: SET }));
    const resetModel = () => {
      MATCH_MODEL = null;
    };
    const grid = (h, a) => matchModel().grid(h, a);
    // Jogo ao vivo: placar atual + distribuição dos gols do tempo que falta.
    function liveGrid(m) {
      const live = LIVE_BY_ID.get(m.k),
        rest = matchModel().remainingGrid(m.h, m.a, live.minute);
      let H = 0,
        D = 0,
        A = 0;
      rest.g.forEach((p, i) => {
        const x = live.homeGoals + ((i / rest.n) | 0),
          y = live.awayGoals + (i % rest.n);
        x > y ? (H += p) : x < y ? (A += p) : (D += p);
      });
      return { ...rest, H, D, A };
    }
    function pick(meth, h, a, key = '') {
      return pickScore(meth, grid(h, a), { seed: SET.seed, key });
    }
    const isLive = (k) => LIVE_BY_ID.has(k);
    // Placar definido pelo usuário (jogos ao vivo não aceitam palpite).
    const val = (k) => {
      if (isLive(k)) return null;
      const s = SC[k];
      return s && s[0] !== '' && s[1] !== '' && s[0] != null && s[1] != null ? [+s[0], +s[1]] : null;
    };
    const editableMatches = (list) => list.filter((m) => !isLive(m.k));
    function h2hTable({ includeLive = true, includeScenario = true } = {}) {
      const table = emptyHeadToHead(T);
      RES.forEach((m) => addHeadToHeadResult(table, m.h, m.a, m.x, m.y));
      M.forEach((m) => {
        const live = LIVE_BY_ID.get(m.k);
        if (live) {
          if (includeLive) addHeadToHeadResult(table, m.h, m.a, live.homeGoals, live.awayGoals);
          return;
        }
        const score = includeScenario && val(m.k);
        if (score) addHeadToHeadResult(table, m.h, m.a, score[0], score[1]);
      });
      return table;
    }
    function rankTeams(s, options = {}) {
      return rankByCriteria(s, T, { officialStandings: LIVE_STANDINGS, headToHead: h2hTable(options) });
    }
    // Classificação = tabela atual + placares ao vivo (como se o jogo acabasse agora) + palpites do cenário.
    function project({ includeLive = true, includeScenario = true } = {}) {
      const s = {};
      T.forEach((c) => (s[c] = { ...base[c], gain: 0, sim: [], live: null }));
      M.forEach((m) => {
        const live = LIVE_BY_ID.get(m.k);
        let v = null;
        if (live) {
          if (!includeLive) return;
          v = [live.homeGoals, live.awayGoals];
          s[m.h].live = { match: m.k, opponent: m.a, home: true, gf: v[0], ga: v[1] };
          s[m.a].live = { match: m.k, opponent: m.h, home: false, gf: v[1], ga: v[0] };
        } else if (includeScenario) v = val(m.k);
        if (!v) return;
        const H = s[m.h],
          A = s[m.a],
          [x, y] = v;
        H.J++;
        A.J++;
        H.GP += x;
        H.GC += y;
        A.GP += y;
        A.GC += x;
        if (!live) {
          H.sim.push(x > y ? 'V' : x < y ? 'D' : 'E');
          A.sim.push(y > x ? 'V' : y < x ? 'D' : 'E');
        }
        const scenarioGain = !live;
        if (x > y) {
          H.P += 3;
          H.V++;
          if (scenarioGain) H.gain += 3;
          A.D++;
        } else if (x < y) {
          A.P += 3;
          A.V++;
          if (scenarioGain) A.gain += 3;
          H.D++;
        } else {
          H.P++;
          A.P++;
          if (scenarioGain) {
            H.gain++;
            A.gain++;
          }
          H.E++;
          A.E++;
        }
      });
      return s;
    }
    // Jogos acompanhados para medir "quais resultados mais mexem nas chances": os
    // ao vivo e os das duas próximas rodadas.
    function leverageRounds() {
      const upcoming = [...new Set(M.filter((m) => !m.late).map((m) => m.r))].sort((a, b) => a - b);
      return new Set(upcoming.slice(0, 2));
    }
    // liveFromStart: simula os jogos ao vivo desde o início, para comparar a
    // chance "antes do jogo" com a chance com o placar atual.
    function monteCarloInput({ liveFromStart = false, scoresOverride = null } = {}) {
      const rounds = leverageRounds(),
        scores = scoresOverride || new Map();
      if (!scoresOverride)
        M.forEach((m) => {
          const score = val(m.k);
          if (score) scores.set(m.k, score);
        });
      const { index, tracked, input } = buildSimulationInput({
        teams: T,
        base,
        results: rawResults,
        openFixtures: M.map((m) => ({ id: m.k, home: m.h, away: m.a, round: m.r })),
        scores,
        live: LIVE_BY_ID,
        matchModel: matchModel(),
        settings: SET,
        qualification: Q,
        iterations: SIMULATIONS,
        isTracked: (fixture) => !liveFromStart && (LIVE_BY_ID.has(fixture.id) || rounds.has(fixture.round)),
        liveFromStart,
      });
      return { idx: index, tracked, input };
    }
    const runSimulation = createSimulationRunner(new URL('./src/model/monte-carlo.worker.js', import.meta.url));
    const pct = histogramQuantile;
    function od(c) {
      if (!MCR) return null;
      const i = MCR.idx[c],
        P = MCR.PC[i],
        N = MCR.N,
        sm = (a, b) => {
          let t = 0;
          for (let k = a; k <= b; k++) t += P[k];
          return (t / N) * 100;
        };
      let mean = 0;
      MCR.PH[i].forEach((n, p) => (mean += n * p));
      return {
        t: sm(0, 0),
        g: sm(0, Q.libertadoresLeaguePositions - 1),
        s: sm(Q.sudamericanaLeagueStart - 1, Q.sudamericanaLeagueEnd - 1),
        z: sm(T.length - Q.relegationPlaces, T.length - 1),
        mean: mean / N,
        lo: pct(MCR.PH[i], N, 0.1),
        hi: pct(MCR.PH[i], N, 0.9),
        pos: P.map((v) => (v / N) * 100),
      };
    }
    function sched() {
      clearTimeout(tmr);
      tmr = setTimeout(async () => {
        const { idx, tracked, input } = monteCarloInput();
        try {
          const result = await runSimulation(input);
          if (!result) return;
          MCR = { ...result, idx, tracked };
          // Com jogos ao vivo, calcula também as chances "antes do jogo" para mostrar a variação.
          if (LIVE_MATCHES.length) {
            const before = monteCarloInput({ liveFromStart: true });
            const preLive = await runSimulation(before.input);
            if (!preLive) return;
            MCR_PRE_LIVE = { ...preLive, idx: before.idx };
          } else MCR_PRE_LIVE = null;
          paint();
        } catch (error) {
          console.error('Falha na simulação:', error);
          notify(`Não foi possível calcular as chances: ${error.message}`);
        }
      }, 150);
    }
    function paint() {
      if (view == 'sim') {
        const active = document.activeElement,
          match = active?.dataset.match,
          side = active?.dataset.side;
        renderTab();
        renderSide();
        if (match && side !== undefined) {
          const input = $(`#side [data-input="score"][data-match="${match}"][data-side="${side}"]`);
          input?.focus();
          input?.select();
        }
      }
      if (view == 'cor') renderChances();
      if (view == 'clubs') renderClubPage();
      if (view == 'home') renderHome();
    }
    function form(c, s) {
      const a = TS[c].f.concat(s[c].sim).slice(-5),
        ns = s[c].sim.length;
      return `<span class="fm">${a.map((x, i) => `<i class="${x}${i >= a.length - ns ? ' s' : ''}"></i>`).join('')}</span>`;
    }
    function oc(v, col) {
      return `<td class="${MCR ? '' : 'dim'}"><b>${pc(v)}</b><div class="bar"><i style="width:${v}%;background:var(--${col})"></i></div></td>`;
    }
    function liveChip(t) {
      if (!t.live) return '';
      const live = LIVE_BY_ID.get(t.live.match),
        outcome = t.live.gf > t.live.ga ? 'V' : t.live.gf < t.live.ga ? 'D' : 'E',
        title = `${live?.stale ? 'Última consulta válida' : 'Ao vivo'} · ${t.live.home ? 'em casa' : 'fora'} contra ${NM[t.live.opponent]}: ${t.live.gf} x ${t.live.ga}`;
      return `<span class="live-chip ${outcome}${live?.stale ? ' is-stale' : ''}" title="${escapeHtml(title)}"><i aria-hidden="true"></i>${t.live.gf}x${t.live.ga} ${ab(t.live.opponent)}<span class="sr-only">: ${escapeHtml(title)}</span></span>`;
    }
    function renderTab() {
      const s = project(),
        o = rankTeams(s),
        editable = editableMatches(M),
        done = editable.filter((m) => val(m.k)).length,
        au = editable.filter((m) => val(m.k) && SC[m.k][2] == 'a').length,
        f = opt.full,
        odn = opt.odds;
      $('#st').textContent =
        done +
        ' de ' +
        editable.length +
        ' jogos definidos (' +
        (done - au) +
        ' por você, ' +
        au +
        ' automáticos)' +
        (LIVE_MATCHES.length ? ` · ${LIVE_MATCHES.length} ao vivo` : '');
      let h = `<table><thead><tr><th class="c1">#</th><th class="c2">Classificação</th><th>P</th><th>J</th><th>V</th>${f ? '<th>E</th><th>D</th><th>GP</th><th>GC</th>' : ''}<th>SG</th>${f ? '<th>%</th><th>Máx</th><th>Forma</th>' : ''}${odn ? `<th>Proj.</th><th>Tít.</th><th>G${Q.libertadoresLeaguePositions}</th><th>Z${Q.relegationPlaces}</th>` : ''}</tr></thead><tbody>`;
      o.forEach((c, i) => {
        const t = s[c],
          mv = realPos[c] - i,
          z =
            i < Q.libertadoresLeaguePositions
              ? 'g'
              : i >= Q.sudamericanaLeagueStart - 1 && i < Q.sudamericanaLeagueEnd
                ? 'b'
                : i >= T.length - Q.relegationPlaces
                  ? 'r'
                  : 'n',
          sg = t.GP - t.GC,
          x = od(c) || { t: 0, g: 0, z: 0, mean: 0, lo: 0, hi: 0 };
        h += `<tr class="r${z} ${c == team ? 'hl' : ''}"><td class="c1"><span class="ps z${z}">${i + 1}</span>${mv > 0 ? `<span class="up">▲${mv}</span>` : mv < 0 ? `<span class="dn">▼${-mv}</span>` : ''}</td><td class="c2"><button class="tn team-link" data-act="select-team" data-team="${c}" aria-label="Ver detalhes de ${NM[c]}">${lg(c)}<span class="fn">${NM[c]}</span><span class="ab">${ab(c)}</span></button>${liveChip(t)}</td><td class="n">${t.P}${t.gain ? `<span class="gain">+${t.gain}</span>` : ''}</td><td>${t.J}</td><td>${t.V}</td>${f ? `<td>${t.E}</td><td>${t.D}</td><td>${t.GP}</td><td>${t.GC}</td>` : ''}<td>${sg > 0 ? '+' + sg : sg}</td>${f ? `<td>${Math.round((t.P / (t.J * 3)) * 100)}%</td><td class="mu">${t.P + 3 * (38 - t.J)}</td><td>${form(c, s)}</td>` : ''}${odn ? `<td class="${MCR ? '' : 'dim'}" title="faixa 10–90%: ${x.lo}–${x.hi}">${MCR ? Math.round(x.mean) : '–'}</td>` + oc(x.t, 'ac') + oc(x.g, 'g') + oc(x.z, 'r') : ''}</tr>`;
      });
      $('#tab').innerHTML = h + '</tbody></table>';
      $('#bF').innerHTML = ic('cols') + (f ? 'Colunas: completa' : 'Colunas: básica');
      $('#bO').innerHTML = ic('chart') + (odn ? 'Chances: ligadas' : 'Chances: ocultas');
      $('#bF').className = f ? 'on' : '';
      $('#bO').className = odn ? 'on' : '';
      $('#bF').setAttribute('aria-pressed', String(f));
      $('#bO').setAttribute('aria-pressed', String(odn));
    }
    function renderAviso() {
      const A = $('#aviso');
      const range = (setting, label, value, hint, min, max, step) =>
        `<label>${label}: <b id="l-${setting}">${value}</b><span class="mu xs"> · ${hint}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${SET[setting]}" data-input="model-setting" data-setting="${setting}"></label>`;
      A.innerHTML = `<details class="cd sim-info"${modelPanelOpen ? ' open' : ''}><summary><b>Ajustes</b><span class="mu sm">Preenchimento automático: ${METH[opt.meth][0]} · k ${SET.k} · mando ×${SET.ha.toFixed(2)}</span></summary><div class="sim-info-body">
      <div class="row"><label for="method">Preencher jogos com</label><select id="method" data-change="method">${Object.keys(
        METH,
      )
        .map((k) => `<option value="${k}" ${opt.meth == k ? 'selected' : ''}>${METH[k][0]}</option>`)
        .join('')}</select></div><p class="mu sm">${METH[opt.meth][1]}</p>
      <div class="ctl">${range('k', 'Peso da média da liga (k)', SET.k, 'menor = confia mais na campanha atual', 1, 30, 1)}${range('ha', 'Força do mando', `×${SET.ha.toFixed(2)}`, '1,00 = como na temporada', 0.8, 1.25, 0.01)}${range('rho', 'Correção de empates (ρ)', SET.rho.toFixed(2), 'mais negativo = mais 0x0 e 1x1', -0.25, 0, 0.01)}<label>Semente: <b id="l-seed">${SET.seed}</b><span class="mu xs"> · mesma semente = mesmas chances</span><input type="number" min="0" max="4294967295" step="1" value="${SET.seed}" inputmode="numeric" data-input="model-seed"></label></div>
      <div class="row"><button data-act="reset-model">Restaurar padrão</button><span class="mu xs">Os placares são hipóteses suas. O modelo não sabe de lesões, suspensões nem escalações.</span></div></div></details>`;
      const details = A.querySelector('details');
      details.addEventListener('toggle', () => {
        modelPanelOpen = details.open;
      });
    }
    let advOpen = false;
    function setS(k, v) {
      SET[k] = v;
      resetModel();
      save();
      const e = $('#l-' + k);
      if (e) e.textContent = k == 'ha' ? '×' + v.toFixed(2) : k == 'rho' ? v.toFixed(2) : v;
    }
    function setSE() {
      renderSide();
      renderTab();
      sched();
    }
    function adjL(v) {
      SET.adj[team] = +v;
      resetModel();
      save();
      $('#l-adj').textContent = (v > 0 ? '+' : '') + v + '%';
    }
    function liveClock(live) {
      return live.stale
        ? 'sem atualização recente'
        : live.halfTime
          ? 'Intervalo'
          : live.minute != null
            ? `~${live.minute}'`
            : 'Em andamento';
    }
    function liveCard(m) {
      const live = LIVE_BY_ID.get(m.k),
        G = liveGrid(m),
        before = SC[m.k] && SC[m.k][0] !== '' && SC[m.k][1] !== '' ? SC[m.k] : null;
      return `<div class="mc is-live live-sim-card${live.stale ? ' is-stale' : ''}" aria-label="${escapeHtml(`${NM[m.h]} ${live.homeGoals} x ${live.awayGoals} ${NM[m.a]}, partida em andamento`)}"><div class="meta"><span class="live-indicator"><i aria-hidden="true"></i>AO VIVO</span><span class="sd">${escapeHtml(m.st || '')}</span><b title="Minuto estimado pelo horário de início">${liveClock(live)}</b></div><div class="tt"><span class="t h">${ab(m.h)}</span>${lg(m.h)}<b class="result-score">${live.homeGoals}</b><span class="x">x</span><b class="result-score">${live.awayGoals}</b>${lg(m.a)}<span class="t">${ab(m.a)}</span></div>
 <div class="pr"><i style="width:${G.H * 100}%;background:var(--g)"></i><i style="width:${G.D * 100}%;background:var(--mu)"></i><i style="width:${G.A * 100}%;background:var(--b)"></i></div><div class="pl"><span>Casa ${Math.round(G.H * 100)}%</span><span>Empate ${Math.round(G.D * 100)}%</span><span>Fora ${Math.round(G.A * 100)}%</span></div>
 <div class="dt">Jogo em andamento: o placar não pode ser editado. A tabela usa o placar atual e as chances simulam só o tempo que falta.${live.stale ? ' Os dados podem estar desatualizados.' : ''}${before ? ` Seu palpite antes do jogo: ${escapeHtml(before[0])} x ${escapeHtml(before[1])}.` : ''}</div></div>`;
    }
    function card(m) {
      if (isLive(m.k)) return liveCard(m);
      const v = SC[m.k] || ['', ''],
        d = m.dt,
        hl = team && (m.h == team || m.a == team),
        G = grid(m.h, m.a),
        au = v[2] == 'a',
        when = d ? matchDateParts(d) : null;
      const meta = d
        ? `<span><b>${when.weekday}</b> ${when.day}/${when.month}/2026</span><span class="sd">${escapeHtml(m.st || '')}</span><b>${when.hour}:${when.minute} BRT</b>`
        : `<span><b>Jogo atrasado</b></span><span class="sd">${escapeHtml(m.st || '')}</span><b>A definir</b>`;
      const inp = (i) =>
          `<input type="number" min="0" max="20" step="1" inputmode="numeric" value="${v[i]}" aria-label="Gols de ${NM[i ? m.a : m.h]} na partida contra ${NM[i ? m.h : m.a]}" data-input="score" data-match="${m.k}" data-side="${i}">`,
        ida = RM[m.a + '-' + m.h],
        H = TS[m.h].h,
        A = TS[m.a].a,
        modelDetails = LIVE_STANDINGS
          ? `Dados atuais GE: ${NM[m.h]} ${LIVE_STANDINGS.get(m.h).points} pontos, ${LIVE_STANDINGS.get(m.h).goalsFor} GP/${LIVE_STANDINGS.get(m.h).goalsAgainst} GC em ${LIVE_STANDINGS.get(m.h).matches} jogos; ${NM[m.a]} ${LIVE_STANDINGS.get(m.a).points} pontos, ${LIVE_STANDINGS.get(m.a).goalsFor} GP/${LIVE_STANDINGS.get(m.a).goalsAgainst} GC em ${LIVE_STANDINGS.get(m.a).matches} jogos. O feed não separa os números por mando.`
          : `${NM[m.h]} em casa: ${H.w}V ${H.d}E ${H.l}D, ${f1(H.gf / H.n)} GP e ${f1(H.ga / H.n)} GC por jogo. ${NM[m.a]} fora: ${A.w}V ${A.d}E ${A.l}D, ${f1(A.gf / A.n)} GP e ${f1(A.ga / A.n)} GC por jogo.`;
      return `<div class="mc ${hl ? 'hl' : ''} ${au ? 'au' : ''}"><div class="meta">${meta}</div><div class="tt"><span class="t h">${ab(m.h)}</span>${lg(m.h)}${inp(0)}<span class="x">x</span>${inp(1)}${lg(m.a)}<span class="t">${ab(m.a)}</span></div>
 <div class="pr"><i style="width:${G.H * 100}%;background:var(--g)"></i><i style="width:${G.D * 100}%;background:var(--mu)"></i><i style="width:${G.A * 100}%;background:var(--b)"></i></div><div class="pl"><span>Casa ${Math.round(G.H * 100)}%</span><span>Empate ${Math.round(G.D * 100)}%</span><span>Fora ${Math.round(G.A * 100)}%</span></div>
 <div class="qk"><button data-act="quick-score" data-match="${m.k}" data-result="1" aria-label="Definir vitória do mandante, ${NM[m.h]} contra ${NM[m.a]}">Casa</button><button data-act="quick-score" data-match="${m.k}" data-result="0" aria-label="Definir empate, ${NM[m.h]} contra ${NM[m.a]}">Empate</button><button data-act="quick-score" data-match="${m.k}" data-result="2" aria-label="Definir vitória do visitante, ${NM[m.a]} contra ${NM[m.h]}">Fora</button><button data-act="auto-match" data-match="${m.k}" title="Preencher pelo método escolhido" aria-label="Preencher ${NM[m.h]} contra ${NM[m.a]} pelo modelo">${ic('wand')}</button><button data-act="clear-match" data-match="${m.k}" title="Limpar" aria-label="Limpar palpite de ${NM[m.h]} contra ${NM[m.a]}">${ic('x')}</button><button data-act="toggle-match-info" data-match="${m.k}" title="Dados do modelo" aria-label="Mostrar dados do modelo para ${NM[m.h]} contra ${NM[m.a]}" aria-expanded="${Boolean(open[m.k])}">${ic('info')}</button>${au ? '<span class="tag u">automático</span>' : v[0] !== '' ? '<span class="tag u">seu palpite</span>' : ''}</div>
 ${open[m.k] ? `<div class="dt">Gols esperados: <b>${f1(G.lh)}</b> x <b>${f1(G.la)}</b>. ${modelDetails}${ida ? ` Jogo de ida (${NM[m.a]} x ${NM[m.h]}): ${ida.x} x ${ida.y}.` : ''}</div>` : ''}</div>`;
    }
    function resultCard(fixture, result) {
      const sourceInfo = result.source,
        source = sourceInfo?.name || dataSource.name,
        stamp =
          sourceInfo?.type === 'verified-backfill' && sourceInfo.verifiedAt
            ? ` · fonte declarada, conferida em ${formatLiveTime(sourceInfo.verifiedAt)}`
            : sourceInfo?.type === 'feed-observed' && sourceInfo.observedAt
              ? ` · observado no GE em ${formatLiveTime(sourceInfo.observedAt)}`
              : '';
      return `<div class="mc result-card"><div class="meta"><span>Resultado registrado</span><span class="sd">${escapeHtml(fixture.stadium || STD[fixture.home] || '')}</span><span>${escapeHtml(source)}</span></div><div class="tt"><span class="t h">${ab(fixture.home)}</span>${lg(fixture.home)}<b class="result-score">${result.homeGoals}</b><span class="x">x</span><b class="result-score">${result.awayGoals}</b>${lg(fixture.away)}<span class="t">${ab(fixture.away)}</span></div><div class="dt">${NM[fixture.home]} ${result.homeGoals} x ${result.awayGoals} ${NM[fixture.away]}${stamp}</div></div>`;
    }
    function missingResultCard(fixture) {
      return `<div class="mc result-card"><div class="meta"><span>Resultado não disponível</span><span class="sd">${escapeHtml(fixture.stadium || STD[fixture.home] || '')}</span><span>${fixture.status === 'postponed' ? 'Partida adiada' : 'Sem placar confirmado'}</span></div><div class="tt"><span class="t h">${ab(fixture.home)}</span>${lg(fixture.home)}<span class="x">x</span>${lg(fixture.away)}<span class="t">${ab(fixture.away)}</span></div><div class="dt">${NM[fixture.home]} x ${NM[fixture.away]} · ${fixture.status === 'postponed' ? 'Data a definir.' : 'Este jogo não tem resultado disponível no snapshot.'}</div></div>`;
    }
    let leverageGoal = 'auto';
    function leverageGoals() {
      return [
        ['title', 'Título', 0, 0],
        ['lib', `G${Q.libertadoresLeaguePositions}`, 0, Q.libertadoresLeaguePositions - 1],
        ['sud', 'Sul-Americana', Q.sudamericanaLeagueStart - 1, Q.sudamericanaLeagueEnd - 1],
        ['safe', `Fugir do Z${Q.relegationPlaces}`, 0, T.length - Q.relegationPlaces - 1],
      ];
    }
    // "O que meu time precisa": chance da meta condicionada a cada resultado dos
    // jogos acompanhados nas simulações, ordenada pelo tamanho da diferença.
    function leverageSection(code) {
      if (!MCR?.trackedCount) return '';
      const x = od(code),
        goals = leverageGoals(),
        chance = { title: x.t, lib: x.g, sud: x.s, safe: 100 - x.z };
      const goal =
        goals.find((item) => item[0] === leverageGoal) ||
        goals.slice().sort((a, b) => Math.abs(chance[a[0]] - 50) - Math.abs(chance[b[0]] - 50))[0];
      const rows = conditionalChances(MCR, MCR.idx[code], T.length, goal[2], goal[3])
        .map((row) => ({ ...row, match: M.find((m) => m.k === MCR.tracked[row.track]) }))
        .filter((row) => row.match && row.swing >= 0.005)
        .sort((a, b) => b.swing - a.swing)
        .slice(0, 6);
      const cell = (value) => (value == null ? '–' : pc(value * 100));
      const cheer = (row) => {
        const options = [
          [row.home, `${NM[row.match.h]} vencer`],
          [row.draw, 'empate'],
          [row.away, `${NM[row.match.a]} vencer`],
        ]
          .filter((item) => item[0] != null)
          .sort((a, b) => b[0] - a[0]);
        return options[0]?.[1] || '–';
      };
      const select = `<label for="leverageGoal">Meta:</label> <select id="leverageGoal" data-change="leverage-goal"><option value="auto" ${leverageGoal === 'auto' ? 'selected' : ''}>Automática (${goal[1]})</option>${goals.map((item) => `<option value="${item[0]}" ${leverageGoal === item[0] ? 'selected' : ''}>${item[1]} · ${pc(chance[item[0]])}</option>`).join('')}</select>`;
      return `<section class="leverage"><h2 style="margin-top:12px">Jogos que mais mexem nas chances</h2><div class="row">${select}</div>${rows.length ? `<div class="sc"><table><thead><tr><th class="l">Jogo</th><th>Mandante vence</th><th>Empate</th><th>Visitante vence</th><th class="l">Torça por</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="l">${isLive(row.match.k) ? '<span class="live-indicator"><i aria-hidden="true"></i>AO VIVO</span> ' : `${row.match.r}ª · `}${ab(row.match.h)} x ${ab(row.match.a)}</td><td>${cell(row.home)}</td><td>${cell(row.draw)}</td><td>${cell(row.away)}</td><td class="l"><b>${escapeHtml(cheer(row))}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="mu sm">Nenhum jogo próximo muda essa chance de forma relevante.</p>'}<p class="mu sm">Chance de ${escapeHtml(goal[1].toLowerCase())} em cada resultado, nas ${SIMULATIONS_LABEL} simulações. Considera os jogos ao vivo e os das duas próximas rodadas ainda sem placar definido.</p></section>`;
    }
    function tools(sc, lab) {
      return `<div class="row" style="margin-bottom:10px"><button data-act="fill-scope" data-scope="${sc}">${ic('wand')}Preencher ${lab}</button><button data-act="clear-scope" data-scope="${sc}" data-automatic="true">${ic('trash')}Limpar automáticos</button><button data-act="clear-scope" data-scope="${sc}">${ic('trash')}Limpar tudo</button></div>`;
    }
    function renderSide() {
      const s = project(),
        o = rankTeams(s),
        baselineOrder = T.slice().sort(
          (a, b) =>
            base[b].P - base[a].P ||
            base[b].V - base[a].V ||
            base[b].GP - base[b].GC - (base[a].GP - base[a].GC) ||
            base[b].GP - base[a].GP ||
            (LIVE_STANDINGS?.get(a)?.position ?? 99) - (LIVE_STANDINGS?.get(b)?.position ?? 99),
        ),
        edited = M.filter((m) => val(m.k));
      let h = '';
      const movers = o
        .map((code, index) => ({ code, from: baselineOrder.indexOf(code), to: index }))
        .filter((item) => item.from !== item.to)
        .sort((a, b) => b.from - b.to - (a.from - a.to))
        .slice(0, 4);
      const impact = edited.length
        ? `<section class="scenario-impact" aria-live="polite"><b>Efeito dos ${edited.length} ${edited.length === 1 ? 'jogo definido' : 'jogos definidos'}</b><span class="mu sm">Posição comparada com a classificação atual; chances calculadas para este cenário.</span>${
            movers.length
              ? `<div class="impact-list">${movers
                  .map(({ code, from, to }) => {
                    const chances = od(code);
                    return `<span>${lg(code)}<b>${escapeHtml(NM[code])}</b><span>${from > to ? `▲ ${from - to}` : `▼ ${to - from}`} posição</span>${chances ? `<span>Título ${pc(chances.t)} · G${Q.libertadoresLeaguePositions} ${pc(chances.g)} · Z${Q.relegationPlaces} ${pc(chances.z)}</span>` : ''}</span>`;
                  })
                  .join('')}</div>`
              : '<span class="mu sm">Nenhuma mudança de posição em relação à tabela atual.</span>'
          }</section>`
        : '';
      h += impact;
      if (team) {
        const i = o.indexOf(team),
          t = s[team],
          x = od(team),
          list = M.filter((m) => m.h == team || m.a == team).sort((a, b) => (a.dt || 0) - (b.dt || 0)),
          mx = t.P + 3 * (38 - t.J),
          adj = SET.adj[team] || 0;
        const need = (k, nm) => {
          if (!MCR) return '';
          const cut = pct(MCR.CP[k], MCR.N, 0.5),
            lo = pct(MCR.CP[k], MCR.N, 0.1),
            hi = pct(MCR.CP[k], MCR.N, 0.9),
            falta = cut - t.P,
            disp = 3 * (38 - t.J);
          return `<tr><td class="l">${nm}</td><td>${cut} (${lo}–${hi})</td><td>${falta <= 0 ? 'já tem' : falta > disp ? 'impossível' : falta + ' de ' + disp}</td><td>${falta > 0 && falta <= disp ? Math.round((falta / disp) * 100) + '%' : '–'}</td></tr>`;
        };
        h = `<div class="cd"><div class="row" style="justify-content:space-between"><div class="row"><span class="lg ${team}" style="width:46px;height:46px"></span><div><b style="font-size:1.1rem">${NM[team]}</b><br><span class="mu sm">${list.filter((m) => val(m.k)).length} de ${list.length} palpites definidos · ${list.length} jogos restantes</span></div></div><button data-act="show-rounds">${ic('list')}Ver rodadas</button></div>
  <div class="tile"><div><b>${i + 1}º</b><span>Posição</span></div><div><b>${t.P}</b><span>Pontos</span></div><div><b>${mx}</b><span>Máximo</span></div><div><b>${x ? Math.round(x.mean) : '–'}</b><span>Projeção</span></div></div>
  <div class="tile"><div><b>${x ? pc(x.t) : '–'}</b><span>Título</span></div><div><b>${x ? pc(x.g) : '–'}</b><span>G${Q.libertadoresLeaguePositions}</span></div><div><b>${x ? pc(x.s) : '–'}</b><span>Sul-Am.</span></div><div><b>${x ? pc(x.z) : '–'}</b><span>Z${Q.relegationPlaces}</span></div></div>
  ${
    x
      ? `<h2>Posição final provável</h2>${bars(
          x.pos,
          Array.from({ length: 20 }, (_, k) => k + 1),
          {
            h: 70,
            col: (k) =>
              k < Q.libertadoresLeaguePositions
                ? 'var(--g)'
                : k >= Q.sudamericanaLeagueStart - 1 && k < Q.sudamericanaLeagueEnd
                  ? 'var(--b)'
                  : k >= T.length - Q.relegationPlaces
                    ? 'var(--r)'
                    : 'var(--mu2)',
            fmt: (v) => pc(v),
          },
        )}`
      : ''
  }
  <h2 style="margin-top:10px">Quanto precisa somar (mediana das simulações)</h2><div class="sc"><table><tr><th class="l">Meta</th><th>Corte (10–90%)</th><th>Faltam</th><th>Aproveit.</th></tr>${need(0, 'Título')}${need(1, `G${Q.libertadoresLeaguePositions}`)}${need(2, 'Sul-Americana')}${need(3, `Fugir do Z${Q.relegationPlaces}`)}</table></div>${leverageSection(team)}
  <div class="ctl"><label>Ajuste de força (você decide): <b id="l-adj">${adj > 0 ? '+' : ''}${adj}%</b> · lesões, fase, treinador novo...<br><input type="range" min="-30" max="30" value="${adj}" data-input="club-adjustment"></label></div>
  <div class="row" style="margin:10px 0"><button data-act="all-team" data-result="w">Vence todos</button><button data-act="all-team" data-result="d">Empata todos</button><button data-act="all-team" data-result="l">Perde todos</button></div>${tools('t', 'jogos do time')}<div class="grid">${list.map((m) => `<div>${m.late ? '' : `<div class="mu" style="font-size:.66rem;margin:0 0 3px 2px">${m.round}ª rodada</div>`}${card(m)}</div>`).join('')}</div></div>`;
      } else {
        const list = M.filter((m) => m.r == tab).sort((a, b) => (a.dt || 9e15) - (b.dt || 9e15)),
          fixtures = ALL_FIXTURES.filter((fixture) => fixture.round === tab),
          roundResults = fixtures.map((fixture) => ({
            fixture,
            result: rawResults.find(
              (result) =>
                result.round === fixture.round && result.home === fixture.home && result.away === fixture.away,
            ),
          })),
          completed = roundResults.filter((item) => item.result),
          missing = roundResults.filter((item) => !item.result),
          ex = list.reduce(
            (q, m) => {
              const G = grid(m.h, m.a);
              q.d += G.D;
              q.g += G.lh + G.la;
              return q;
            },
            { d: 0, g: 0 },
          ),
          roundLabel = completed.length
            ? `${completed.length} de ${fixtures.length} placares registrados`
            : 'Nenhum placar registrado nesta rodada',
          pastRound = Boolean(completed.length && tab < (LIVE_ROUND?.number || DEFAULT_ROUND));
        h = `<div class="cd"><div class="rh"><button class="ic" data-act="round-step" data-step="-1" aria-label="Rodada anterior">${ic('cl')}</button><b>${tab}ª RODADA</b><button class="ic" data-act="round-step" data-step="1" aria-label="Próxima rodada">${ic('cr')}</button></div>
  <div class="pills" role="group" aria-label="Selecionar rodada">${ROUND_OPTIONS.map((round) => {
    const played = ALL_FIXTURES.filter((fixture) => fixture.round === round && fixture.status === 'played').length,
      available = editableMatches(M.filter((m) => m.r === round));
    return `<button class="${tab === round ? 'on' : ''} ${played ? 'has-results' : ''} ${available.length && available.every((match) => val(match.k)) ? 'ok' : ''}" data-act="select-round" data-round="${round}" aria-label="Rodada ${round}: ${played} resultados registrados" title="${played} resultados registrados" aria-pressed="${tab === round}">${round}</button>`;
  }).join('')}</div>
  ${pastRound ? `<p class="mu sm" style="margin-bottom:8px">Resultados anteriores · ${roundLabel}. Os placares registrados são somente leitura; partidas sem resultado confirmado são identificadas abaixo.</p>` : completed.length ? `<h2>Resultados já registrados · ${roundLabel}</h2><div class="grid">${completed.map((item) => resultCard(item.fixture, item.result)).join('')}</div>` : ''}
  ${
    pastRound
      ? `<div class="grid">${completed.map(({ fixture, result }) => resultCard(fixture, result)).join('')}</div>${
          missing.length
            ? `<h2>Jogos sem placar registrado (${missing.length})</h2><div class="grid">${missing
                .map(({ fixture }) => {
                  const postponed = M.find((match) => match.k === fixture.id);
                  return postponed
                    ? `<div><div class="mu sm" style="font-size:.66rem;margin:0 0 3px 2px">${fixture.round}ª rodada</div>${card(postponed)}</div>`
                    : missingResultCard(fixture);
                })
                .join('')}</div>`
            : ''
        }`
      : ''
  }
  ${list.length ? `<h2>${pastRound ? 'Partidas ainda simuláveis' : 'Jogos para simular'}</h2>` : ''}
  <div class="mu sm" style="margin-bottom:8px">Pelo modelo: ${f1(ex.d)} empates e ${f1(ex.g)} gols esperados nesta rodada (média 2026 até aqui: ${f1((LG.D / LG.n) * 10)} empates e ${f1((LG.gols / LG.n) * 10)} gols a cada 10 jogos).</div>
  ${list.length ? `<section class="round-progress" aria-label="Progresso dos palpites"><div><b>${editableMatches(list).filter((m) => val(m.k)).length} de ${editableMatches(list).length} jogos definidos</b><span class="mu sm">na rodada ${tab}${list.some((m) => isLive(m.k)) ? ` · ${list.filter((m) => isLive(m.k)).length} ao vivo` : ''}</span></div><progress value="${editableMatches(list).filter((m) => val(m.k)).length}" max="${editableMatches(list).length || 1}" aria-label="Progresso dos palpites da rodada ${tab}"></progress><div class="row"><button data-act="fill-missing-scope" data-scope="${tab}" ${editableMatches(list).every((m) => val(m.k)) ? 'disabled' : ''}>Preencher faltantes</button><button data-act="clear-scope" data-scope="${tab}">Limpar palpites da rodada</button></div></section><div class="row" style="margin-bottom:10px"><label for="team-filter">Ver jogos por time:</label><select id="team-filter" data-change="team"><option value="">Selecione um time...</option>${T.map((c) => `<option value="${c}">${NM[c]}</option>`).join('')}</select></div>${tools(tab, 'rodada')}<div class="grid">${list.map(card).join('')}</div>` : ''}
  ${!pastRound ? `<div class="row" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--ln)"><span class="mu sm">Campeonato todo:</span><button data-act="fill-scope" data-scope="all">${ic('wand')}Preencher tudo</button><button data-act="clear-scope" data-scope="all" data-automatic="true">${ic('trash')}Limpar automáticos</button><button data-act="clear-scope" data-scope="all">${ic('trash')}Limpar tudo</button></div>` : ''}</div>`;
      }
      $('#side').innerHTML = h;
      const roundSelector = $('#side .pills'),
        selectedRound = roundSelector?.querySelector('.on');
      if (roundSelector && selectedRound)
        roundSelector.scrollLeft +=
          selectedRound.getBoundingClientRect().left -
          roundSelector.getBoundingClientRect().left -
          (roundSelector.clientWidth - selectedRound.clientWidth) / 2;
    }
    function bars(v, lab, o) {
      const W = 300,
        H = o.h || 80,
        n = v.length,
        bw = W / n,
        mx = Math.max(...v, o.max || 0) || 1;
      return `<svg class="ch" viewBox="0 0 ${W} ${H + 14}">${v
        .map((x, i) => {
          const hh = (x / mx) * H;
          return `<rect x="${i * bw + 1}" y="${H - hh}" width="${bw - 2}" height="${hh}" rx="1.5" style="fill:${o.col ? o.col(i) : 'var(--ac)'};opacity:${(o.op && o.op(i)) || 1}"><title>${lab[i]}: ${o.fmt ? o.fmt(x) : x}</title></rect>`;
        })
        .join(
          '',
        )}${lab.map((l, i) => (n <= 40 && i % (o.step || 1) == 0 ? `<text x="${i * bw + bw / 2}" y="${H + 10}" text-anchor="middle">${l}</text>` : '')).join('')}${o.ref != null ? `<line x1="0" x2="${W}" y1="${H - (o.ref / mx) * H}" y2="${H - (o.ref / mx) * H}" style="stroke:var(--ac)" stroke-dasharray="3 3"/>` : ''}</svg>`;
    }
    function renderAll() {
      renderAviso();
      renderTab();
      renderSide();
      sched();
    }
    const go = (d) => {
      const index = ROUND_OPTIONS.indexOf(tab);
      if (index < 0 || !ROUND_OPTIONS.length) return;
      tab = ROUND_OPTIONS[(index + d + ROUND_OPTIONS.length) % ROUND_OPTIONS.length];
      renderSide();
    };
    function removePendingPrediction(fixtureId) {
      const entry = predictionHistory.find((item) => item.fixtureId === fixtureId);
      if (entry && !entry.actual) {
        predictionHistory = predictionHistory.filter((item) => item.fixtureId !== fixtureId);
        savePredictionHistory();
        deleteAccountPrediction(fixtureId);
      }
    }
    function recordPredictionSnapshot(fixtureId) {
      const match = M.find((item) => item.k === fixtureId),
        score = SC[fixtureId];
      if (!match || !val(fixtureId)) return;
      const forecast = grid(match.h, match.a),
        recordedAt = new Date().toISOString();
      try {
        const modelSnapshot = createModelSnapshot({
          probabilities: { home: forecast.H, draw: forecast.D, away: forecast.A },
          settings: SET,
          teams: { home: match.h, away: match.a },
          dataRevision: liveFeed?.revision || dataUpdatedAt,
          method: opt.meth,
          recordedAt,
        });
        predictionHistory = upsertPredictionSnapshot(
          predictionHistory,
          ALL_FIXTURES.find((fixture) => fixture.id === fixtureId),
          score,
          modelSnapshot,
        );
        savePredictionHistory();
      } catch (error) {
        notify(`Não foi possível registrar o snapshot deste palpite: ${error.message}`);
        console.error(error);
      }
    }
    function sv(k, i, v) {
      if (isLive(k)) {
        notify('Este jogo está ao vivo; o placar não pode ser editado.');
        return;
      }
      const s = SC[k] || (SC[k] = ['', '', 'u']);
      s[i] = v === '' ? '' : String(Math.max(0, Math.min(20, Math.floor(+v) || 0)));
      s[2] = 'u';
      if (s[0] === '' && s[1] === '') {
        delete SC[k];
        removePendingPrediction(k);
      } else if (val(k)) recordPredictionSnapshot(k);
      save();
      renderTab();
      sched();
      document.querySelectorAll('.pills button').forEach((b) => {
        const round = Number(b.dataset.round);
        b.classList.toggle(
          'ok',
          editableMatches(M)
            .filter((m) => m.r === round)
            .every((m) => val(m.k)),
        );
      });
    }
    function qk(k, w) {
      if (isLive(k)) return;
      SC[k] = w == 1 ? ['1', '0', 'u'] : w == 0 ? ['1', '1', 'u'] : ['0', '1', 'u'];
      recordPredictionSnapshot(k);
      save();
      renderAll();
    }
    function auto(k) {
      if (isLive(k)) return;
      const m = M.find((m) => m.k == k),
        [x, y] = pick(opt.meth, m.h, m.a, m.k);
      SC[k] = [String(x), String(y), 'a'];
      recordPredictionSnapshot(k);
      save();
      renderAll();
    }
    function targets(w) {
      const list = editableMatches(M);
      return w === null || w === 'all'
        ? list
        : w === 't'
          ? list.filter((m) => m.h == team || m.a == team)
          : /^\d+$/.test(w)
            ? list.filter((m) => m.r == +w)
            : list.filter((m) => m.k == w);
    }
    function fill(w) {
      targets(w).forEach((m) => {
        if (SC[m.k] && SC[m.k][2] == 'u' && val(m.k)) return;
        const [x, y] = pick(opt.meth, m.h, m.a, m.k);
        SC[m.k] = [String(x), String(y), 'a'];
        recordPredictionSnapshot(m.k);
      });
      save();
      renderAll();
    }
    function fillMissing(w) {
      targets(w)
        .filter((m) => !val(m.k))
        .forEach((m) => {
          const [x, y] = pick(opt.meth, m.h, m.a, m.k);
          SC[m.k] = [String(x), String(y), 'a'];
          recordPredictionSnapshot(m.k);
        });
      save();
      renderAll();
    }
    function clr(w, only) {
      targets(w).forEach((m) => {
        if (!only || (SC[m.k] && SC[m.k][2] == 'a')) {
          delete SC[m.k];
          removePendingPrediction(m.k);
        }
      });
      save();
      renderAll();
    }
    function allT(r) {
      editableMatches(M)
        .filter((m) => m.h == team || m.a == team)
        .forEach((m) => {
          const home = m.h == team,
            w = r == 'w' ? (home ? ['2', '0'] : ['0', '2']) : r == 'l' ? (home ? ['0', '2'] : ['2', '0']) : ['1', '1'];
          SC[m.k] = [...w, 'u'];
          recordPredictionSnapshot(m.k);
        });
      save();
      renderAll();
    }
    function setTeam(c) {
      team = c;
      renderSide();
      renderTab();
      sched();
      if (c) scrollTo({ top: 0, behavior: 'smooth' });
    }
    /* ---- abas ---- */
    // Abas do menu. Busca, conta, ajuda e fontes ficam no cabeçalho e no rodapé.
    const TABS = [
      ['home', 'Início'],
      ['live', 'Ao vivo'],
      ['sim', 'Simular'],
      ['cor', 'Chances'],
      ['copas', 'Copas'],
      ['clubs', 'Clubes'],
      ['est', 'Estatísticas'],
      ['perf', 'Palpites'],
    ];
    const VIEWS = [...TABS.map(([key]) => key), 'search', 'guide', 'account', 'src'];
    // Sub-abas de Chances e Estatísticas.
    const subView = { cor: 'race', est: 'season' };
    // Chances (%) de um clube num resultado de simulação.
    function chancesIn(result, code) {
      if (!result) return null;
      const counts = result.PC[result.idx[code]],
        sum = (first, last) => {
          let total = 0;
          for (let position = first; position <= last; position++) total += counts[position];
          return (total / result.N) * 100;
        };
      return {
        title: sum(0, 0),
        lib: sum(0, Q.libertadoresLeaguePositions - 1),
        sud: sum(Q.sudamericanaLeagueStart - 1, Q.sudamericanaLeagueEnd - 1),
        safe: 100 - sum(T.length - Q.relegationPlaces, T.length - 1),
      };
    }
    const GOAL_LABELS = () => ({
      title: 'título',
      lib: `G${Q.libertadoresLeaguePositions}`,
      sud: 'Sul-Americana',
      safe: `escapar do Z${Q.relegationPlaces}`,
    });
    // Para cada time de um jogo ao vivo: a meta cuja chance mais mudou com o placar atual.
    function liveDeltas(fixtureId) {
      const live = LIVE_BY_ID.get(fixtureId);
      if (!live || !MCR || !MCR_PRE_LIVE) return '';
      const labels = GOAL_LABELS();
      const rows = [live.home, live.away]
        .map((code) => {
          const now = chancesIn(MCR, code),
            before = chancesIn(MCR_PRE_LIVE, code);
          const [key] = Object.keys(labels)
            .filter((goal) => before[goal] > 0.5 && before[goal] < 99.5)
            .sort((a, b) => Math.abs(now[b] - before[b]) - Math.abs(now[a] - before[a]));
          if (!key) return '';
          const change = now[key] - before[key];
          return `<span class="who">${lg(code)}<b>${escapeHtml(NM[code])}</b></span><span class="what">${labels[key]} ${pc(before[key])} → <b>${pc(now[key])}</b> <span class="delta ${change >= 0.5 ? 'up' : change <= -0.5 ? 'dn' : ''}">${signed(change, ' p.p.')}</span></span>`;
        })
        .filter(Boolean);
      return rows.length
        ? `<div class="live-deltas" aria-label="Como o placar atual muda as chances">${rows.join('')}</div>`
        : '';
    }
    function renderFixtureCard(fixture, result, feed, favorite = false) {
      const isStaleLive = liveFeed?.stale && feed?.status === 'live' && !result;
      const liveNow = !liveFeed?.stale && feed?.status === 'live' && !result;
      const finished = result || feed?.status === 'finished';
      const liveInfo = LIVE_BY_ID.get(fixture.id);
      const kickoff = fixture.kickoff || feed?.dateTime;
      const when = kickoff ? matchDateParts(new Date(kickoff)) : null;
      const status = finished
        ? 'Encerrado'
        : liveNow
          ? `<span class="live-indicator"><i aria-hidden="true"></i>AO VIVO</span>${liveInfo ? ` · ${liveClock(liveInfo)}` : ''}`
          : isStaleLive
            ? 'Sem atualização recente'
            : fixture.status === 'postponed'
              ? 'Adiado'
              : when
                ? `${when.weekday} ${when.day}/${when.month} · <b>${when.hour}:${when.minute}</b>`
                : 'A definir';
      const scoreValues = result
        ? [result.homeGoals, result.awayGoals]
        : feed?.score?.home != null && feed?.score?.away != null && (liveNow || isStaleLive || finished)
          ? [feed.score.home, feed.score.away]
          : null;
      const score = scoreValues
        ? `<b class="result-score">${scoreValues[0]}</b><span class="x">x</span><b class="result-score">${scoreValues[1]}</b>`
        : '<span class="x">x</span>';
      const stadium = fixture.stadium || feed?.venue || STD[fixture.home] || '';
      return `<article class="mc${liveNow ? ' is-live' : ''}${isStaleLive ? ' is-stale' : ''}${favorite ? ' hl' : ''}" aria-label="${escapeHtml(`${NM[fixture.home]} x ${NM[fixture.away]}`)}"><div class="meta"><span>${status}</span><span class="sd">${escapeHtml(stadium)}</span></div><div class="tt"><span class="t h">${ab(fixture.home)}</span>${lg(fixture.home)}${score}${lg(fixture.away)}<span class="t">${ab(fixture.away)}</span></div>${liveNow ? liveDeltas(fixture.id) : ''}</article>`;
    }
    function feedMatchFor(fixture) {
      return (liveFeed?.matches || []).find(
        (match) =>
          match.round === fixture.round &&
          teamCode(match.homeTeam) === fixture.home &&
          teamCode(match.awayTeam) === fixture.away,
      );
    }
    function upcomingFixtures() {
      const now = Date.now();
      return ALL_FIXTURES.filter(
        (fixture) =>
          fixture.status !== 'played' &&
          fixture.status !== 'postponed' &&
          !LIVE_BY_ID.has(fixture.id) &&
          (fixture.kickoff ? Date.parse(fixture.kickoff) >= now - 3 * 3600_000 : fixture.round >= DEFAULT_ROUND),
      ).sort(
        (a, b) =>
          (a.kickoff ? Date.parse(a.kickoff) : Infinity) - (b.kickoff ? Date.parse(b.kickoff) : Infinity) ||
          a.round - b.round,
      );
    }
    function fixtureRow(fixture) {
      const when = fixture.kickoff ? matchDateParts(new Date(fixture.kickoff)) : null;
      return `<div class="fixture-row"><span class="home">${escapeHtml(NM[fixture.home])}${lg(fixture.home)}</span><span class="when">${when ? `<b>${when.hour}:${when.minute}</b>${when.weekday} ${when.day}/${when.month}` : '<b>—</b>a definir'}</span><span class="away">${lg(fixture.away)}${escapeHtml(NM[fixture.away])}</span></div>`;
    }
    // Chances "oficiais" do site (sem palpites): última foto do servidor. Sem
    // servidor, usa a simulação local quando o usuário não tem palpites.
    function baselineChances() {
      const entries = PROB_HISTORY || [];
      const last = entries[entries.length - 1];
      if (last) {
        const previous = [...entries].reverse().find((entry) => entry.matches <= last.matches - T.length / 2) || null;
        return { now: last.chances, previous: previous?.chances || null, label: 'variação desde a rodada anterior' };
      }
      if (MCR && !M.some((m) => val(m.k))) {
        const chances = Object.fromEntries(
          T.map((code) => {
            const value = chancesIn(MCR, code);
            return [code, { title: value.title, libertadores: value.lib, relegation: 100 - value.safe }];
          }),
        );
        return { now: chances, previous: null, label: '' };
      }
      return null;
    }
    function chanceList(chances, key, tone, limit = 5) {
      const rows = T.map((code) => ({
        code,
        value: chances.now[code]?.[key] ?? 0,
        before: chances.previous?.[code]?.[key],
      }))
        .filter((row) => row.value >= 0.5)
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
      if (!rows.length) return '<p class="mu sm">Nenhum clube com chance relevante.</p>';
      return `<div class="chance-list">${rows
        .map((row) => {
          const change = row.before == null ? null : row.value - row.before;
          const good = key === 'relegation' ? -change : change;
          return `<div class="chance-row">${lg(row.code)}<span class="name">${escapeHtml(NM[row.code])}</span><span class="value">${pc(row.value)}${change != null && Math.abs(change) >= 0.5 ? ` <span class="delta ${good > 0 ? 'up' : 'dn'}">${signed(change)}</span>` : ''}</span>${meter(row.value, tone)}</div>`;
        })
        .join('')}</div>`;
    }
    function renderHome() {
      const liveFixtures = ALL_FIXTURES.filter((fixture) => LIVE_BY_ID.has(fixture.id));
      const upcoming = upcomingFixtures();
      const current = project({ includeScenario: false });
      const order = rankTeams(current, { includeScenario: false });
      const chances = baselineChances();
      const zone = (index) =>
        index < Q.libertadoresLeaguePositions
          ? 'g'
          : index >= Q.sudamericanaLeagueStart - 1 && index < Q.sudamericanaLeagueEnd
            ? 'b'
            : index >= T.length - Q.relegationPlaces
              ? 'r'
              : 'n';
      const roundNumber = LIVE_ROUND?.number || DEFAULT_ROUND;
      const table = `<table class="mini-table"><thead><tr><th class="l">#</th><th class="l">Clube</th><th>P</th><th>J</th><th>SG</th>${chances ? '<th>Tít.</th>' : ''}</tr></thead><tbody>${order
        .map((code, index) => {
          const team = current[code],
            goalDifference = team.GP - team.GC;
          return `<tr class="r${zone(index)}"><td class="l"><span class="ps z${zone(index)}">${index + 1}</span></td><td class="l"><button class="tn" data-act="open-club" data-team="${code}">${lg(code)}<span class="fn">${escapeHtml(NM[code])}</span><span class="ab">${ab(code)}</span></button>${liveChip(team)}</td><td class="n">${team.P}</td><td>${team.J}</td><td>${goalDifference > 0 ? '+' : ''}${goalDifference}</td>${chances ? `<td class="mu">${(chances.now[code]?.title ?? 0) >= 0.5 ? pc(chances.now[code].title) : ''}</td>` : ''}</tr>`;
        })
        .join('')}</tbody></table>`;
      const favorites = signedInUser
        ? favoriteTeams.length
          ? `<div class="favorite-list">${favoriteTeams
              .map((code) => {
                const position = order.indexOf(code) + 1,
                  next = upcoming.find((fixture) => fixture.home === code || fixture.away === code);
                return `<article class="favorite-row"><button class="favorite-name" data-act="open-club" data-team="${code}">${lg(code)}<b>${escapeHtml(NM[code])}</b><span class="mu">${position}º · ${current[code].P} pts</span></button>${next ? `<p class="mu sm">Próximo: ${escapeHtml(NM[next.home])} x ${escapeHtml(NM[next.away])} · ${next.kickoff ? formatLiveTime(next.kickoff) : 'a definir'}</p>` : ''}</article>`;
              })
              .join('')}</div>`
          : '<p class="mu sm">Escolha seus clubes na aba Clubes para vê-los aqui.</p><button data-act="show-view" data-view="clubs">Escolher clubes</button>'
        : '<p class="mu sm">Crie uma conta grátis para acompanhar seus clubes e receber aviso de gol no celular.</p><button data-act="open-account" data-mode="register">Criar conta</button>';
      const liveCount = liveFixtures.length;
      $('#v-home').innerHTML =
        `<div class="welcome"><div><span class="kicker">Brasileirão 2026 · ${roundNumber}ª rodada</span><h1>${liveCount ? `${liveCount === 1 ? 'Um jogo' : `${liveCount} jogos`} ao vivo agora` : 'A tabela, as chances e o seu cenário'}</h1><p class="mu">${liveCount ? 'A classificação abaixo já considera os placares parciais.' : 'Acompanhe a rodada e simule o que falta do campeonato.'}</p></div><div class="row"><button class="p" data-act="show-view" data-view="sim">Simular a rodada</button><button data-act="show-view" data-view="cor">Ver as chances</button></div></div>
      ${liveCount ? `<section class="home-live" aria-label="Jogos ao vivo"><div class="grid">${liveFixtures.map((fixture) => renderFixtureCard(fixture, null, feedMatchFor(fixture), favoriteTeams.includes(fixture.home) || favoriteTeams.includes(fixture.away))).join('')}</div></section>` : ''}
      <div class="home-grid"><section class="cd"><div class="card-head"><h2>Classificação</h2><button class="link-btn" data-act="show-view" data-view="sim">Simular a partir dela</button></div><div class="sc">${table}</div></section>
      <div><section class="cd"><div class="card-head"><h2>Próximos jogos</h2><button class="link-btn" data-act="show-view" data-view="live">Rodada completa</button></div>${upcoming.length ? `<div class="fixture-list">${upcoming.slice(0, 6).map(fixtureRow).join('')}</div>` : '<p class="mu">Sem jogos marcados.</p>'}</section>
      ${chances ? `<section class="cd"><div class="card-head"><h2>Chance de título</h2>${chances.label ? `<span class="mu xs">${chances.label}</span>` : ''}</div>${chanceList(chances, 'title', 'accent')}</section><section class="cd"><div class="card-head"><h2>Risco de rebaixamento</h2></div>${chanceList(chances, 'relegation', 'r')}</section>` : ''}
      <section class="cd"><h2>Seus clubes</h2>${favorites}</section></div></div>`;
    }
    function renderLiveHub() {
      const round = LIVE_ROUND?.number || DEFAULT_ROUND,
        fixtures = ALL_FIXTURES.filter((fixture) => fixture.round === round);
      const groups = { live: [], upcoming: [], finished: [] };
      for (const fixture of fixtures) {
        const result = rawResults.find(
          (item) => item.round === fixture.round && item.home === fixture.home && item.away === fixture.away,
        );
        const feed = feedMatchFor(fixture);
        const status =
          result || feed?.status === 'finished'
            ? 'finished'
            : feed?.status === 'live' && !liveFeed?.stale
              ? 'live'
              : 'upcoming';
        groups[status].push({ fixture, result, feed });
      }
      const card = ({ fixture, result, feed }) =>
        renderFixtureCard(
          fixture,
          result,
          feed,
          favoriteTeams.includes(fixture.home) || favoriteTeams.includes(fixture.away),
        );
      const section = (title, key) =>
        groups[key].length
          ? `<section class="cd"><h2>${title} <span class="mu">· ${groups[key].length}</span></h2><div class="grid">${groups[key].map(card).join('')}</div></section>`
          : '';
      const source = liveFeed
        ? `${escapeHtml(liveFeed.source.name)} · atualizado ${formatLiveTime(liveFeed.fetchedAt)}${liveFeed.stale ? ' · dados desatualizados' : ''}`
        : 'Fonte ao vivo indisponível; mostrando o calendário local';
      $('#v-live').innerHTML =
        `<div class="page-head"><div><h1>${round}ª rodada</h1><p class="mu sm">${source}. Atualiza sozinho; o minuto é estimado pelo horário de início.</p></div><button class="chip-btn" data-act="refresh-feed">Atualizar agora</button></div>${section('Ao vivo', 'live')}${section('Próximos', 'upcoming')}${section('Encerrados', 'finished')}`;
    }
    // ---- Histórico de chances (servidor; sem servidor, arquivo estático) ----
    let PROB_HISTORY = null,
      PROB_HISTORY_ERROR = '',
      MARKET = null,
      BACKTEST = null,
      trendMetric = 'title',
      trendClubs = null,
      splitMode = 'all';
    async function loadProbabilityHistory() {
      try {
        let response = await fetch('/api/probability-history', { cache: 'no-cache' });
        if (!response.ok) response = await fetch('data/probability-history-2026.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const entries = (await response.json()).entries;
        if (!Array.isArray(entries)) throw new Error('formato inválido');
        PROB_HISTORY = entries.filter((entry) => entry && Number.isFinite(entry.matches) && entry.chances);
        PROB_HISTORY_ERROR = '';
      } catch (error) {
        PROB_HISTORY_ERROR = `Histórico de chances indisponível (${error.message}).`;
      }
      if (['home', 'cor', 'clubs'].includes(view)) renderView(view);
    }
    const SERIES_COLORS = ['#E2C266', '#6AA8F0', '#3DD68C', '#F07360', '#B48CF2', '#4FD1C5', '#F59E0B', '#EC4899'];
    const TREND_METRICS = () => [
      ['title', 'Título'],
      ['libertadores', `G${Q.libertadoresLeaguePositions}`],
      ['sudamericana', 'Sul-Americana'],
      ['relegation', `Z${Q.relegationPlaces}`],
      ['meanPoints', 'Pontos projetados'],
    ];
    function historySeries(code, metric) {
      return (PROB_HISTORY || [])
        .filter((entry) => entry.chances[code] && Number.isFinite(entry.chances[code][metric]))
        .map((entry) => ({ x: entry.matches / (T.length / 2), y: entry.chances[code][metric] }));
    }
    function historyChart(series, metric, title) {
      const points = series.flatMap((item) => item.points);
      if (!points.length) return '<p class="empty">Ainda não há histórico suficiente.</p>';
      const isPoints = metric === 'meanPoints';
      return lineChart({
        series,
        xMin: Math.min(...points.map((point) => point.x)),
        xMax: Math.max(...points.map((point) => point.x)),
        yMax: isPoints ? Math.max(100, Math.ceil(Math.max(...points.map((point) => point.y)) / 10) * 10) : 100,
        yLabel: (value) => (isPoints ? `${value}` : `${value}%`),
        xLabel: (value) => `${Math.round(value)}ª`,
        title,
      });
    }

    // ---- Chances ----
    function chancesHead() {
      return `<div class="page-head"><div><h1>Chances</h1><p class="mu">${SIMULATIONS_LABEL} simulações do restante do campeonato${M.some((m) => val(m.k)) ? ', considerando os placares do seu cenário' : ''}.</p></div></div>${segmented(
        'cor',
        [
          ['race', 'Classificação final'],
          ['map', 'Mapa de posições'],
          ['trend', 'Evolução'],
          ['vagas', 'Vagas 2027'],
          ['model', 'Qualidade do modelo'],
        ],
        subView.cor,
        'Visões das chances',
      )}`;
    }
    function zoneOf(index) {
      return index < Q.libertadoresLeaguePositions
        ? 'g'
        : index >= Q.sudamericanaLeagueStart - 1 && index < Q.sudamericanaLeagueEnd
          ? 'b'
          : index >= T.length - Q.relegationPlaces
            ? 'r'
            : 'n';
    }
    function renderChances() {
      if (subView.cor === 'race') {
        renderCor();
        $('#v-cor').insertAdjacentHTML('afterbegin', chancesHead());
        return;
      }
      let body = '';
      if (subView.cor === 'map') {
        const order = MCR ? T.slice().sort((a, b) => (od(b)?.mean ?? 0) - (od(a)?.mean ?? 0)) : rankTeams(project());
        body = MCR
          ? `<section class="cd"><h2>Onde cada clube deve terminar</h2><p class="mu sm">Chance (%) de terminar em cada posição. Quanto mais forte a cor, maior a chance; células vazias ficam abaixo de 0,5%.</p>${positionMap(
              {
                order,
                positionsOf: (code) => od(code)?.pos || null,
                zoneOf,
                renderTeam: (code) =>
                  `<button class="tn" data-act="open-club" data-team="${code}">${lg(code)}<span class="fn">${escapeHtml(NM[code])}</span><span class="ab">${ab(code)}</span></button>`,
                highlight: team,
                nameOf: (code) => NM[code],
              },
            )}</section>`
          : '<p class="empty">Calculando as simulações…</p>';
      } else if (subView.cor === 'vagas') {
        body = renderSlots();
      } else if (subView.cor === 'trend') {
        if (!PROB_HISTORY) body = `<p class="empty">${PROB_HISTORY_ERROR || 'Carregando o histórico…'}</p>`;
        else {
          const last = PROB_HISTORY[PROB_HISTORY.length - 1];
          const metricName = TREND_METRICS().find(([key]) => key === trendMetric)[1];
          if (!trendClubs) {
            // Clubes que mais chegaram perto da meta em algum momento da temporada.
            const peak = (code) => Math.max(0, ...historySeries(code, trendMetric).map((point) => point.y));
            trendClubs = T.slice()
              .sort(
                (a, b) =>
                  peak(b) - peak(a) || (last?.chances[b]?.[trendMetric] ?? 0) - (last?.chances[a]?.[trendMetric] ?? 0),
              )
              .slice(0, 4);
          }
          const series = trendClubs.map((code, index) => ({
            label: ab(code),
            color: SERIES_COLORS[index % SERIES_COLORS.length],
            points: historySeries(code, trendMetric),
          }));
          const picker = T.slice()
            .sort((a, b) => NM[a].localeCompare(NM[b], 'pt-BR'))
            .map((code) => {
              const index = trendClubs.indexOf(code);
              return `<button type="button" data-act="trend-club" data-team="${code}" aria-pressed="${index >= 0}" style="${index >= 0 ? `--club-color:${SERIES_COLORS[index % SERIES_COLORS.length]}` : ''}">${lg(code)}${ab(code)}</button>`;
            })
            .join('');
          body = `<section class="cd"><div class="chart-controls"><label for="trendMetric">Mostrar</label><select id="trendMetric" data-change="trend-metric">${TREND_METRICS()
            .map(([key, label]) => `<option value="${key}" ${key === trendMetric ? 'selected' : ''}>${label}</option>`)
            .join(
              '',
            )}</select></div>${historyChart(series, trendMetric, `${metricName} ao longo da temporada`)}<div class="club-picker" role="group" aria-label="Clubes no gráfico">${picker}</div><p class="mu xs footnote">Chances sem palpites, calculadas ao fim de cada rodada com os resultados conhecidos até ela (rodadas anteriores reconstruídas com o modelo atual) e atualizadas a cada novo resultado.</p></section>`;
        }
      } else {
        if (!BACKTEST || BACKTEST.key !== `${SET.k}:${SET.rho}:${SET.ha}:${rawResults.length}`) {
          BACKTEST = {
            key: `${SET.k}:${SET.rho}:${SET.ha}:${rawResults.length}`,
            ...backtestModel(rawResults, T, { k: SET.k, rho: SET.rho, ha: SET.ha }),
          };
        }
        if (!MARKET) {
          MARKET = { loading: true };
          fetch('/api/model-vs-market')
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((data) => (MARKET = data))
            .catch(() => (MARKET = { configured: false, unavailable: true }))
            .finally(() => view === 'cor' && subView.cor === 'model' && renderChances());
        }
        const brierText = (value) => (value == null ? '–' : value.toFixed(3).replace('.', ','));
        const better = BACKTEST.brier < BACKTEST.naiveBrier;
        const market = MARKET?.loading
          ? '<p class="mu">Carregando…</p>'
          : !MARKET?.configured
            ? '<p class="mu sm">A comparação com as casas de apostas fica disponível quando o servidor tem uma chave da the-odds-api.com (variável ODDS_API_KEY). As odds são guardadas antes de cada jogo e comparadas com o resultado depois.</p>'
            : MARKET.matches
              ? `<div class="compare"><div class="${MARKET.modelBrier <= MARKET.marketBrier ? 'best' : ''}"><span class="mu sm">SimulaBR</span><b>${brierText(MARKET.modelBrier)}</b></div><div class="${MARKET.marketBrier < MARKET.modelBrier ? 'best' : ''}"><span class="mu sm">Casas de apostas</span><b>${brierText(MARKET.marketBrier)}</b></div></div><p class="mu sm">${MARKET.matches} jogos com odds registradas antes do início.</p>`
              : '<p class="mu sm">Coletando odds; a comparação aparece após os primeiros jogos encerrados.</p>';
        body = `<div class="g2"><section class="cd"><h2>Acerto do modelo nesta temporada</h2><p class="mu sm">Cada rodada desde a 8ª prevista só com os jogos anteriores a ela (${BACKTEST.matches} jogos). Brier score: 0 é perfeito, menor é melhor.</p><div class="compare"><div class="${better ? 'best' : ''}"><span class="mu sm">Modelo (k = ${SET.k})</span><b>${brierText(BACKTEST.brier)}</b></div><div class="${better ? '' : 'best'}"><span class="mu sm">Só a média da liga</span><b>${brierText(BACKTEST.naiveBrier)}</b></div><div><span class="mu sm">Resultado mais provável acertou</span><b>${pc(BACKTEST.accuracy * 100)}</b></div></div><p class="mu xs">A referência ignora os clubes e usa só a frequência de vitória do mandante, empate e vitória do visitante. O ajuste k foi escolhido por este mesmo teste; dar peso maior aos jogos recentes não melhorou o resultado.</p></section><section class="cd"><h2>Modelo x casas de apostas</h2>${market}</section></div><section class="cd"><h2>Os seus palpites</h2><p class="mu sm">A calibração das probabilidades dos jogos em que você palpitou está na aba Palpites.</p><button data-act="show-view" data-view="perf">Abrir Palpites</button></section>`;
      }
      $('#v-cor').innerHTML = chancesHead() + body;
    }

    // ---- Estatísticas ----
    function statsHead() {
      return `<div class="page-head"><div><h1>Estatísticas</h1><p class="mu">Números da temporada com os resultados conhecidos.</p></div></div>${segmented(
        'est',
        [
          ['season', 'Temporada'],
          ['splits', 'Por recorte'],
          ['rounds', 'Rodada a rodada'],
        ],
        subView.est,
        'Visões das estatísticas',
      )}`;
    }
    function renderStats() {
      if (subView.est === 'season') {
        renderEst();
        updateEstSource();
      } else if (subView.est === 'rounds') renderRoundHistory();
      else {
        const rows = buildSplitTable(rawResults, T, splitMode);
        $('#v-est').innerHTML =
          `<section class="cd"><div class="chart-controls"><label for="splitMode">Recorte</label><select id="splitMode" data-change="split-mode">${SPLIT_MODES.map(
            ([key, label]) => `<option value="${key}" ${key === splitMode ? 'selected' : ''}>${label}</option>`,
          ).join(
            '',
          )}</select></div><div class="sc"><table><thead><tr><th class="l">#</th><th class="l">Clube</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th><th>%</th></tr></thead><tbody>${rows
            .map(
              (row) =>
                `<tr><td class="l">${row.position}</td><td class="l"><button class="tn" data-act="open-club" data-team="${row.code}">${lg(row.code)}<span class="fn">${escapeHtml(NM[row.code])}</span><span class="ab">${ab(row.code)}</span></button></td><td class="n">${row.P}</td><td>${row.J}</td><td>${row.V}</td><td>${row.E}</td><td>${row.D}</td><td>${row.GP}</td><td>${row.GC}</td><td>${row.SG > 0 ? '+' : ''}${row.SG}</td><td>${row.rate == null ? '–' : `${Math.round(row.rate)}%`}</td></tr>`,
            )
            .join(
              '',
            )}</tbody></table></div><p class="mu xs footnote">Calculado só com os placares conhecidos jogo a jogo; pode divergir da tabela oficial se faltar algum resultado.</p></section>`;
      }
      $('#v-est').insertAdjacentHTML('afterbegin', statsHead());
    }

    // ---- Chances do clube ao longo da temporada (aba Clubes) ----
    function clubChanceCard(code) {
      if (!PROB_HISTORY) return '';
      const series = [
        ['title', 'Título', SERIES_COLORS[0]],
        ['libertadores', `G${Q.libertadoresLeaguePositions}`, '#3DD68C'],
        ['sudamericana', 'Sul-Am.', '#6AA8F0'],
        ['relegation', `Z${Q.relegationPlaces}`, '#F07360'],
      ]
        .map(([key, label, color]) => ({ label, color, points: historySeries(code, key) }))
        .filter((item) => item.points.some((point) => point.y >= 1));
      return `<section class="cd"><h2>Chances de ${escapeHtml(NM[code])} ao longo da temporada</h2>${historyChart(series, 'title', `Chances de ${NM[code]} por rodada`)}</section>`;
    }
    // ---- Copas (Libertadores, Sul-Americana, Copa do Brasil) ----
    const CUP_ADJUST_KEY = 'br26-cup-adjustments';
    const CUPS = {
      active: 'libertadores',
      data: {},
      errors: {},
      ratings: null,
      crestMap: null,
      fileOverrides: {},
      adjustments: (() => {
        try {
          const stored = JSON.parse(localStorage.getItem(CUP_ADJUST_KEY) || '{}');
          return Object.fromEntries(
            Object.entries(stored).filter(
              ([id, value]) => /^\d{1,8}$/.test(id) && Number.isInteger(value) && Math.abs(value) <= 400,
            ),
          );
        } catch {
          return {};
        }
      })(),
      sims: {},
      timer: null,
    };
    async function loadCupAssets() {
      if (CUPS.ratings) return;
      const [ratings, overrides, crestMap] = await Promise.all(
        ['data/club-ratings-2026.json', 'data/club-ratings-overrides.json', 'assets/crests/map.json'].map((file) =>
          fetch(file, { cache: 'no-cache' }).then((response) => (response.ok ? response.json() : null)),
        ),
      );
      if (!ratings?.teams || !ratings?.model) throw new Error('notas de força indisponíveis');
      CUPS.ratings = ratings;
      CUPS.fileOverrides = overrides?.adjustments || {};
      CUPS.crestMap = crestMap || { clubs: {}, competitions: {} };
    }
    async function loadCup(id) {
      try {
        const response = await fetch(`/api/competition/${id}`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        CUPS.data[id] = body;
        CUPS.errors[id] = '';
        CUPS.sims[id] = null;
      } catch (error) {
        CUPS.errors[id] = error.message;
      }
    }
    const cupStrength = () => {
      const overrides = { ...CUPS.fileOverrides };
      for (const [id, value] of Object.entries(CUPS.adjustments)) overrides[id] = (Number(overrides[id]) || 0) + value;
      return createStrength({ ratings: CUPS.ratings, overrides });
    };
    function cupSimulation(id) {
      if (!CUPS.data[id] || !CUPS.ratings) return null;
      CUPS.sims[id] ??= simulateKnockout(CUPS.data[id], cupStrength(), { iterations: SIMULATIONS, seed: SET.seed });
      return CUPS.sims[id];
    }
    const cupHasLive = (id) =>
      CUPS.data[id]?.stages.some((stage) => stage.ties.some((tie) => tie.legs.some((leg) => leg.state === 'in')));
    function scheduleCupRefresh() {
      clearTimeout(CUPS.timer);
      if (view !== 'copas') return;
      CUPS.timer = setTimeout(
        async () => {
          if (document.visibilityState === 'visible') {
            await loadCup(CUPS.active);
            if (view === 'copas') renderCups();
          }
          scheduleCupRefresh();
        },
        cupHasLive(CUPS.active) ? 30_000 : 120_000,
      );
    }
    async function ensureCups(ids) {
      try {
        await loadCupAssets();
      } catch (error) {
        for (const id of ids) CUPS.errors[id] = error.message;
        return;
      }
      await Promise.all(ids.filter((id) => !CUPS.data[id]).map(loadCup));
    }
    function applyCupTheme() {
      if (view === 'copas') document.documentElement.dataset.cup = CUPS.active;
      else delete document.documentElement.dataset.cup;
    }
    function renderCups() {
      applyCupTheme();
      const id = CUPS.active,
        format = COMPETITIONS[id],
        competition = CUPS.data[id];
      const switcher = `<div class="cup-switch" role="group" aria-label="Escolha a competição">${COMPETITION_IDS.map(
        (key) => {
          const logo = CUPS.crestMap?.competitions?.[key]?.file;
          return `<button type="button" data-act="cup-select" data-cup="${key}" aria-pressed="${key === id}" class="${key === id ? 'on' : ''}">${logo ? `<img src="${escapeHtml(logo)}" alt="" width="22" height="22">` : ''}${escapeHtml(COMPETITIONS[key].name)}</button>`;
        },
      ).join('')}</div>`;
      let body;
      if (!competition) {
        body = CUPS.errors[id]
          ? `<p class="empty">Não foi possível carregar a ${escapeHtml(format.name)}: ${escapeHtml(CUPS.errors[id])}.</p>`
          : '<p class="empty">Carregando…</p>';
      } else {
        const simulation = cupSimulation(id),
          strength = cupStrength();
        const stage = competition.stages.find((item) => item.id === competition.currentStage);
        const leaders = simulation
          ? Object.entries(simulation.probabilities)
              .sort((a, b) => (b[1].champion || 0) - (a[1].champion || 0))
              .slice(0, 4)
          : [];
        const championName = competition.champion ? competition.teams[competition.champion]?.name : null;
        body = `<section class="cup-hero cd"><div><span class="kicker">${escapeHtml(format.fullName)}</span><h2>${championName ? `Campeão: ${escapeHtml(championName)}` : stage ? `Em disputa: ${escapeHtml(stage.name)}` : 'Temporada encerrada'}</h2><p class="mu sm">Fonte: ESPN · atualizado ${formatLiveTime(competition.fetchedAt)}${competition.stale ? ' · dados desatualizados' : ''}</p></div>${
          leaders.length
            ? `<div class="chance-list cup-leaders">${leaders
                .map(
                  ([team, chances]) =>
                    `<div class="chance-row">${cupCrest(team, CUPS.crestMap)}<span class="name">${escapeHtml(competition.teams[team]?.name || '?')}</span><span class="value">${pc(chances.champion || 0)}</span>${meter(chances.champion || 0, 'accent')}</div>`,
                )
                .join('')}<p class="mu xs">Chance de título em ${SIMULATIONS_LABEL} simulações</p></div>`
            : ''
        }</section>
        <section class="cd"><h2>Chaveamento</h2><div class="sc">${cupBracket(competition, CUPS.crestMap)}</div></section>
        ${simulation?.stages.length > 1 ? `<section class="cd"><div class="card-head"><h2>Chance de cada clube</h2><button class="link-btn" data-act="cup-reset" ${Object.keys(CUPS.adjustments).length ? '' : 'hidden'}>Desfazer meus ajustes</button></div><p class="mu sm">Use − e + para mudar a força de um clube (lesões, fase, viagem). As chances são recalculadas na hora e o ajuste fica só neste navegador.</p>${cupChanceTable(competition, simulation, strength, CUPS.adjustments, CUPS.crestMap)}</section>` : ''}
        ${competition.groups.length ? `<section class="cd"><h2>Fase de grupos</h2>${cupGroupTables(competition, CUPS.crestMap)}</section>` : ''}
        <section class="cd"><h2>Regras e método</h2>${cupRules(id)}<p class="mu sm">Força dos clubes: Elo calculado com ${escapeHtml(CUPS.ratings?.sources?.elo || 'resultados recentes')}. Média de gols e mando: ${escapeHtml(CUPS.ratings?.sources?.prior || 'histórico das copas')}. Pênaltis: 50% para cada lado, como no histórico de 2012–2025.</p><button class="link-btn" data-act="show-view" data-view="src">Fontes e método</button></section>`;
      }
      $('#v-copas').innerHTML =
        `<div class="page-head"><div><h1>Copas</h1><p class="mu">Libertadores, Sul-Americana e Copa do Brasil: chaveamento, grupos e chances.</p></div></div>${switcher}${body}`;
      scheduleCupRefresh();
    }

    // Vagas na Libertadores 2027: Brasileirão + copas, simulação a simulação.
    function renderSlots() {
      if (!MCR) return '<p class="empty">Calculando as simulações do Brasileirão…</p>';
      if (COMPETITION_IDS.some((id) => !CUPS.data[id]) || !CUPS.ratings) {
        const failed = COMPETITION_IDS.filter((id) => CUPS.errors[id]);
        if (failed.length)
          return `<p class="empty">Copas indisponíveis agora (${escapeHtml(failed.map((id) => COMPETITIONS[id].name).join(', '))}).</p>`;
        ensureCups(COMPETITION_IDS).then(() => view === 'cor' && subView.cor === 'vagas' && renderChances());
        return '<p class="empty">Carregando as copas…</p>';
      }
      const N = MCR.N,
        teamCount = T.length,
        leagueOrders = new Array(N);
      for (let iteration = 0; iteration < N; iteration++) {
        const order = new Array(teamCount);
        for (let team = 0; team < teamCount; team++) order[MCR.finalPositions[iteration * teamCount + team]] = T[team];
        leagueOrders[iteration] = order;
      }
      const cups = Object.fromEntries(COMPETITION_IDS.map((id) => [id, cupSimulation(id)]));
      const toAppCode = (id) => (id ? CUPS.crestMap?.clubs?.[id]?.appCode || null : null);
      const result = libertadoresSlots({ leagueOrders, cups, toAppCode });
      const current = rankTeams(project());
      const rows = T.map((code) => ({ code, chance: result.chance[code] || 0, league: od(code)?.g ?? 0 }))
        .filter((row) => row.chance >= 0.5 || row.league >= 0.5)
        .sort((a, b) => b.chance - a.chance);
      const cutoff = Object.entries(result.cutoff)
        .map(([position, share]) => [Number(position), share])
        .sort((a, b) => a[0] - b[0]);
      const cupChance = (id, code) => {
        const sim = cups[id];
        const espnId = Object.entries(CUPS.crestMap.clubs).find(([, club]) => club.appCode === code)?.[0];
        return espnId && sim?.probabilities[espnId] ? sim.probabilities[espnId].champion || 0 : null;
      };
      return `<section class="cd"><h2>Até onde a vaga desce no Brasileirão</h2><p class="mu sm">O Brasil tem 7 vagas: 5 pelo Brasileirão e 2 pelos finalistas da Copa do Brasil, mais uma para cada brasileiro campeão da Libertadores ou da Sul-Americana. Quando um finalista já está no G5, a vaga desce na tabela.</p><div class="compare">${cutoff
        .map(([position, share]) => `<div><span class="mu sm">Vaga até o ${position}º</span><b>${pc(share)}</b></div>`)
        .join('')}</div></section>
      <section class="cd"><h2>Chance de vaga na Libertadores 2027</h2><div class="sc"><table><thead><tr><th class="l">Clube</th><th>Agora</th><th>Só pela tabela (G${Q.libertadoresLeaguePositions})</th><th>Com as copas</th><th>Título Libertadores</th><th>Título Sul-Am.</th><th>Título Copa do Brasil</th></tr></thead><tbody>${rows
        .map((row) => {
          const cell = (id) => {
            const value = cupChance(id, row.code);
            return `<td class="mu">${value == null ? '–' : pc(value)}</td>`;
          };
          return `<tr><td class="l"><button class="tn" data-act="open-club" data-team="${row.code}">${lg(row.code)}<span class="fn">${escapeHtml(NM[row.code])}</span><span class="ab">${ab(row.code)}</span></button></td><td class="mu">${current.indexOf(row.code) + 1}º</td><td>${pc(row.league)}</td><td><b>${pc(row.chance)}</b>${meter(row.chance, 'g')}</td>${cell('libertadores')}${cell('sudamericana')}${cell('copaDoBrasil')}</tr>`;
        })
        .join(
          '',
        )}</tbody></table></div><p class="mu xs footnote">Regra da CBF para 2026 (fonte em Copas › Regras). Não simula a exigência de estar na Série A no ano da Libertadores. As copas usam a força Elo e os seus ajustes da aba Copas.</p></section>`;
    }
    // ---- Contas matemáticas (aba Clubes) ----
    function mathCard(code) {
      const current = project({ includeScenario: false });
      const stats = Object.fromEntries(T.map((club) => [club, { P: current[club].P, J: current[club].J }]));
      const name = NM[code];
      const goals = [
        [{ verb: 'ser campeão', noun: 'o título' }, clinchTopN(stats, code, 1)],
        [
          { verb: `terminar no G${Q.libertadoresLeaguePositions}`, noun: `vaga no G${Q.libertadoresLeaguePositions}` },
          clinchTopN(stats, code, Q.libertadoresLeaguePositions),
        ],
        [
          {
            verb: `terminar até o ${Q.sudamericanaLeagueEnd}º`,
            noun: `vaga continental (até o ${Q.sudamericanaLeagueEnd}º)`,
          },
          clinchTopN(stats, code, Q.sudamericanaLeagueEnd),
        ],
        [
          { verb: `escapar do Z${Q.relegationPlaces}`, noun: 'a permanência na Série A' },
          clinchSafety(stats, code, Q.relegationPlaces),
        ],
      ];
      return `<section class="cd"><h2>Contas matemáticas</h2><ul class="math-list">${goals
        .map(
          ([goal, result]) =>
            `<li class="${result.clinched ? 'ok' : result.impossible ? 'no' : ''}">${escapeHtml(describeGoal(result, { ...goal, teamName: name }))}</li>`,
        )
        .join(
          '',
        )}</ul><p class="mu xs footnote">Conta garantida: supõe que todos os rivais vencem tudo o que falta e pede 1 ponto a mais para não depender de desempate. Quando os rivais ainda se enfrentam, o número exato pode ser menor. Jogos ao vivo não entram.</p></section>`;
    }

    // ---- Comparar cenários ----
    const runComparison = createSimulationRunner(new URL('./src/model/monte-carlo.worker.js', import.meta.url));
    function summaryOf(result, index) {
      return Object.fromEntries(
        T.map((code) => {
          const counts = result.PC[index[code]],
            share = (first, last) => {
              let total = 0;
              for (let position = first; position <= last; position++) total += counts[position];
              return (total / result.N) * 100;
            };
          let mean = 0;
          result.PH[index[code]].forEach((count, points) => (mean += count * points));
          return [
            code,
            {
              points: mean / result.N,
              title: share(0, 0),
              lib: share(0, Q.libertadoresLeaguePositions - 1),
              z: share(T.length - Q.relegationPlaces, T.length - 1),
            },
          ];
        }),
      );
    }
    function scoresOf(payload) {
      const scores = new Map();
      for (const m of M) {
        if (isLive(m.k)) continue;
        const value = payload?.scores?.[m.k];
        if (value && value[0] !== '' && value[1] !== '') scores.set(m.k, [Number(value[0]), Number(value[1])]);
      }
      return scores;
    }
    function openCompare() {
      modalReturnFocus = document.activeElement;
      const saved = savedScenarios
        .map((item) => `<option value="saved:${escapeHtml(item.id)}">Salvo: ${escapeHtml(item.name)}</option>`)
        .join('');
      $('#mb').innerHTML =
        `<div class="card-head"><h2 id="compare-title">Comparar cenários</h2><button class="ic" data-act="close-modal" aria-label="Fechar">${ic('x')}</button></div><p class="mu sm">Compare o seu cenário atual (A) com outro (B), nas mesmas ${SIMULATIONS_LABEL} simulações.</p><label for="compareWith">Cenário B</label><select id="compareWith" data-change="compare-with"><option value="base">Tabela atual, sem palpites</option>${saved}<option value="code">Colar código ou link</option></select><div id="compareCode" hidden><label for="compareCodeInput">Código B28 ou link compartilhado</label><textarea id="compareCodeInput" placeholder="Cole aqui o código ou o link"></textarea></div><div class="row" style="margin-top:10px"><button class="p" data-act="run-compare">Comparar</button></div><div id="compareResult" role="status" aria-live="polite"></div>`;
      $('#mod').setAttribute('aria-labelledby', 'compare-title');
      $('#mod').hidden = false;
      $('#compareWith').focus();
    }
    async function runCompare() {
      const choice = $('#compareWith').value,
        output = $('#compareResult');
      let payload = null,
        label = 'sem palpites';
      try {
        if (choice.startsWith('saved:')) {
          const saved = savedScenarios.find((item) => item.id === choice.slice(6));
          if (!saved) throw new Error('Cenário salvo não encontrado.');
          payload = saved.scenario;
          label = saved.name;
        } else if (choice === 'code') {
          const raw = $('#compareCodeInput').value.trim();
          const fromLink = /[?&]scenario=([A-Za-z0-9_-]+)/.exec(raw)?.[1];
          payload = payloadFromCode(fromLink ? `B28:${fromLink}` : raw);
          label = 'cenário colado';
        }
      } catch (error) {
        output.innerHTML = `<p class="warn sm">${escapeHtml(error.message)}</p>`;
        return;
      }
      output.innerHTML = '<p class="mu sm">Simulando…</p>';
      const mine = monteCarloInput({ scoresOverride: scoresOf(payloadFromState()) });
      const other = monteCarloInput({ scoresOverride: scoresOf(payload) });
      const [resultA, resultB] = [await runComparison(mine.input), await runComparison(other.input)];
      if (!resultA || !resultB) return;
      const a = summaryOf(resultA, mine.idx),
        b = summaryOf(resultB, other.idx);
      const rows = T.slice().sort((x, y) => b[y].points - b[x].points);
      const diff = (value, invert = false) => {
        const good = invert ? -value : value;
        return Math.abs(value) < 0.5
          ? '<span class="mu">=</span>'
          : `<span class="delta ${good > 0 ? 'up' : 'dn'}">${signed(value)}</span>`;
      };
      output.innerHTML = `<div class="sc" style="margin-top:12px"><table><thead><tr><th class="l">Clube</th><th>Pontos A</th><th>Pontos B</th><th>Título A / B</th><th>G${Q.libertadoresLeaguePositions} A / B</th><th>Z${Q.relegationPlaces} A / B</th></tr></thead><tbody>${rows
        .map(
          (code) =>
            `<tr><td class="l"><span class="tn">${lg(code)}${ab(code)}</span></td><td>${Math.round(a[code].points)}</td><td>${Math.round(b[code].points)} ${diff(b[code].points - a[code].points)}</td><td>${pc(a[code].title)} / ${pc(b[code].title)}</td><td>${pc(a[code].lib)} / ${pc(b[code].lib)}</td><td>${pc(a[code].z)} / ${pc(b[code].z)} ${diff(b[code].z - a[code].z, true)}</td></tr>`,
        )
        .join(
          '',
        )}</tbody></table></div><p class="mu xs">A = seu cenário atual · B = ${escapeHtml(label)}. Diferenças em pontos e em pontos percentuais.</p>`;
    }
    function renderClubProfile() {
      const code = statsTeam || T[0],
        entry = LIVE_STANDINGS?.get(code),
        matches = ALL_FIXTURES.filter((fixture) => fixture.home === code || fixture.away === code);
      const played = matches
        .map((fixture) => ({
          fixture,
          result: rawResults.find(
            (r) => r.round === fixture.round && r.home === fixture.home && r.away === fixture.away,
          ),
        }))
        .filter((item) => item.result)
        .sort((a, b) => b.fixture.round - a.fixture.round);
      const upcoming = matches
        .filter((fixture) => fixture.status !== 'played')
        .sort(
          (a, b) => (a.kickoff ? Date.parse(a.kickoff) : Infinity) - (b.kickoff ? Date.parse(b.kickoff) : Infinity),
        );
      const current = project()[code],
        position = rankTeams(project()).indexOf(code) + 1,
        probability = od(code);
      $('#v-clubs').innerHTML =
        `<div class="cd"><h2>Perfil do clube</h2><label for="clubProfileSelect">Escolha um clube</label> <select id="clubProfileSelect" data-change="club-profile">${T.map((club) => `<option value="${club}" ${club === code ? 'selected' : ''}>${escapeHtml(NM[club])} (${club})</option>`).join('')}</select> <button data-act="favorite-team" data-team="${code}" aria-pressed="${favoriteTeams.includes(code)}">${favoriteTeams.includes(code) ? '★ Acompanhando' : signedInUser ? '☆ Acompanhar clube' : 'Criar conta para acompanhar'}</button><p class="mu sm">Perfil público, disponível sem login.</p><div class="tile"><div><b>${entry?.position || position}º</b><span>Posição atual</span></div><div><b>${entry?.points ?? current.P}</b><span>Pontos</span></div><div><b>${entry?.wins ?? current.V}/${entry?.draws ?? current.E}/${entry?.losses ?? current.D}</b><span>V/E/D</span></div><div><b>${entry ? `${entry.goalsFor}–${entry.goalsAgainst}` : `${current.GP}–${current.GC}`}</b><span>Gols pró/contra</span></div><div><b>${probability ? pc(probability.t) : '–'}</b><span>Chance simulada de título</span></div><div><b>${probability ? pc(probability.z) : '–'}</b><span>Chance simulada de Z${Q.relegationPlaces}</span></div></div><p class="mu sm">${entry ? `Tabela consultada no GE em ${formatLiveTime(liveFeed?.fetchedAt)}; o GE não é fonte oficial da CBF.` : 'Classificação calculada dos resultados locais disponíveis; pode haver lacunas históricas.'}</p></div><div class="g2"><div class="cd"><h2>Resultados conhecidos</h2>${
          played.length
            ? `<div class="sc"><table><thead><tr><th>Rodada</th><th class="l">Partida</th><th>Placar</th><th class="l">Fonte declarada</th></tr></thead><tbody>${played
                .slice(0, 10)
                .map(
                  ({ fixture, result }) =>
                    `<tr><td>${fixture.round}</td><td class="l">${escapeHtml(NM[fixture.home])} x ${escapeHtml(NM[fixture.away])}</td><td>${result.homeGoals}–${result.awayGoals}</td><td class="l">${escapeHtml(result.source?.name || dataSource.name)}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<p class="mu">Nenhum resultado detalhado disponível.</p>'
        }</div><div class="cd"><h2>Próximos jogos</h2>${
          upcoming.length
            ? `<div class="sc"><table><thead><tr><th>Rodada</th><th class="l">Partida</th><th>Data</th><th>Estádio</th></tr></thead><tbody>${upcoming
                .slice(0, 8)
                .map(
                  (fixture) =>
                    `<tr><td>${fixture.round}</td><td class="l">${escapeHtml(NM[fixture.home])} x ${escapeHtml(NM[fixture.away])}</td><td>${fixture.kickoff ? formatLiveTime(fixture.kickoff) : 'A definir'}</td><td>${escapeHtml(fixture.stadium || STD[fixture.home] || '–')}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<p class="mu">Não há jogos futuros conhecidos no calendário local.</p>'
        }</div></div>`;
      const favoriteButton = $('#v-clubs [data-act="favorite-team"]');
      favoriteButton.setAttribute(
        'aria-label',
        signedInUser ? 'Alternar clube favorito' : `Criar uma conta para acompanhar ${NM[code]}`,
      );
      const favoriteHelp = $('#v-clubs .cd p.mu.sm');
      if (favoriteHelp)
        favoriteHelp.textContent = signedInUser
          ? 'Perfil público. Seus clubes favoritos e lembretes são salvos na sua conta.'
          : 'Perfil público, disponível sem login. Entre ou crie uma conta para salvar clubes favoritos e receber lembretes personalizados.';
    }
    function clubPositionHistory(code) {
      const stats = Object.fromEntries(
        T.map((club) => [club, { points: 0, wins: 0, goalsFor: 0, goalsAgainst: 0, matches: 0 }]),
      );
      const maximumRound = Math.max(0, ...rawResults.map((result) => result.round)),
        history = [];
      for (let round = 1; round <= maximumRound; round++) {
        rawResults
          .filter((result) => result.round === round)
          .forEach((result) => {
            const home = stats[result.home],
              away = stats[result.away];
            home.matches++;
            away.matches++;
            home.goalsFor += result.homeGoals;
            home.goalsAgainst += result.awayGoals;
            away.goalsFor += result.awayGoals;
            away.goalsAgainst += result.homeGoals;
            if (result.homeGoals > result.awayGoals) {
              home.points += 3;
              home.wins++;
            } else if (result.homeGoals < result.awayGoals) {
              away.points += 3;
              away.wins++;
            } else {
              home.points++;
              away.points++;
            }
          });
        const ranking = T.slice().sort(
          (a, b) =>
            stats[b].points - stats[a].points ||
            stats[b].wins - stats[a].wins ||
            stats[b].goalsFor - stats[b].goalsAgainst - (stats[a].goalsFor - stats[a].goalsAgainst) ||
            stats[b].goalsFor - stats[a].goalsFor,
        );
        if (stats[code].matches)
          history.push({ round, position: ranking.indexOf(code) + 1, points: stats[code].points });
      }
      return history;
    }
    function renderClubProgress(code) {
      const history = clubPositionHistory(code),
        form = rawResults
          .filter((result) => result.home === code || result.away === code)
          .sort((a, b) => b.round - a.round)
          .slice(0, 5)
          .reverse();
      const chart =
        history.length > 1
          ? (() => {
              const width = 720,
                height = 210,
                padding = { left: 38, right: 14, top: 14, bottom: 26 },
                innerWidth = width - padding.left - padding.right,
                innerHeight = height - padding.top - padding.bottom;
              const x = (index) => padding.left + (index * innerWidth) / (history.length - 1),
                y = (position) => padding.top + ((position - 1) * innerHeight) / (T.length - 1);
              const path = history
                .map((entry, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(entry.position).toFixed(1)}`)
                .join(' ');
              const grid = [1, 5, 10, 15, 20]
                .map(
                  (position) =>
                    `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y(position)}" y2="${y(position)}" class="chart-grid"/><text x="${padding.left - 8}" y="${y(position) + 3}" text-anchor="end">${position}º</text>`,
                )
                .join('');
              const points = history
                .map(
                  (entry, index) =>
                    `<circle cx="${x(index)}" cy="${y(entry.position)}" r="3.5"><title>${entry.round}ª rodada · ${entry.position}º lugar · ${entry.points} pontos</title></circle>`,
                )
                .join('');
              return `<svg class="ch club-progress-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Posição aproximada de ${escapeHtml(NM[code])} por rodada, reconstruída dos resultados locais disponíveis"><g>${grid}</g><path d="${path}" class="chart-line"/>${points}<text x="${padding.left}" y="${height - 4}">1ª rodada</text><text x="${width - padding.right}" y="${height - 4}" text-anchor="end">${history.at(-1).round}ª rodada conhecida</text></svg>`;
            })()
          : '<p class="mu">Ainda não há resultados suficientes para desenhar a evolução.</p>';
      const outcomes = form
        .map((result) => {
          const isHome = result.home === code,
            forGoals = isHome ? result.homeGoals : result.awayGoals,
            againstGoals = isHome ? result.awayGoals : result.homeGoals;
          return forGoals > againstGoals ? 'V' : forGoals < againstGoals ? 'D' : 'E';
        })
        .join(' · ');
      const pointsChart =
        history.length > 1
          ? `<h3>Pontos acumulados por rodada conhecida</h3>${bars(
              history.map((entry) => entry.points),
              history.map((entry) => entry.round),
              {
                h: 70,
                col: () => 'var(--b)',
                fmt: (value) => `${value} pontos`,
                step: Math.max(1, Math.ceil(history.length / 10)),
              },
            )}`
          : '';
      return `<div class="cd"><h2>Evolução na tabela e forma recente</h2><h3>Posição reconstruída por rodada</h3>${chart}${pointsChart}<p class="mu sm">Posições e pontos reconstruídos apenas dos placares conhecidos até cada rodada, com desempate simplificado. Podem faltar jogos e a ordem pode divergir da tabela oficial.</p><p>Últimos resultados conhecidos: <span class="fm" role="img" aria-label="${escapeHtml(outcomes || 'Sem resultados recentes')}">${form.map((result, index) => `<i class="${outcomes.split(' · ')[index]}" title="${escapeHtml(outcomes.split(' · ')[index])} · rodada ${result.round}"></i>`).join('')}</span> <span class="mu sm">${escapeHtml(outcomes || 'Sem resultados recentes')}</span></p></div>`;
    }
    function renderClubPage() {
      renderClubProfile();
      const profile = $('#v-clubs').firstElementChild;
      if (profile)
        profile.insertAdjacentHTML(
          'afterend',
          mathCard(statsTeam || T[0]) + clubChanceCard(statsTeam || T[0]) + renderClubProgress(statsTeam || T[0]),
        );
    }
    function renderRoundHistory() {
      const round = selectedHistoryRound,
        fixtures = ALL_FIXTURES.filter((fixture) => fixture.round === round),
        results = rawResults.filter((result) => result.round === round);
      const stats = Object.fromEntries(T.map((code) => [code, { P: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0, J: 0 }]));
      rawResults
        .filter((result) => result.round <= round)
        .forEach((result) => {
          const h = stats[result.home],
            a = stats[result.away];
          h.J++;
          a.J++;
          h.GP += result.homeGoals;
          h.GC += result.awayGoals;
          a.GP += result.awayGoals;
          a.GC += result.homeGoals;
          if (result.homeGoals > result.awayGoals) {
            h.P += 3;
            h.V++;
            a.D++;
          } else if (result.homeGoals < result.awayGoals) {
            a.P += 3;
            a.V++;
            h.D++;
          } else {
            h.P++;
            a.P++;
            h.E++;
            a.E++;
          }
        });
      const order = T.slice().sort(
        (a, b) =>
          stats[b].P - stats[a].P ||
          stats[b].V - stats[a].V ||
          stats[b].GP - stats[b].GC - (stats[a].GP - stats[a].GC) ||
          stats[b].GP - stats[a].GP,
      );
      const cards = fixtures
        .map((fixture) => {
          const result = results.find((item) => item.home === fixture.home && item.away === fixture.away);
          return result ? resultCard(fixture, result) : missingResultCard(fixture);
        })
        .join('');
      $('#v-est').innerHTML =
        `<div class="cd"><h2>Histórico por rodada</h2><label for="historyRound">Rodada</label> <select id="historyRound" data-change="history-round">${ROUND_OPTIONS.map((value) => `<option value="${value}" ${value === round ? 'selected' : ''}>${value}ª rodada</option>`).join('')}</select><p class="mu sm">${results.length} de ${fixtures.length} placares disponíveis. Tabela reconstruída somente com resultados conhecidos até esta rodada; em caso de empate, critérios e ordem históricos podem divergir do oficial.</p><p class="mu sm">Fonte do snapshot: ${escapeHtml(dataSource.name)}. Resultados observados podem identificar GE ou a fonte declarada na conferência.</p></div><div class="g2"><div class="cd"><h2>Resultados da ${round}ª rodada</h2><div class="grid">${cards || '<p class="mu">Nenhum jogo cadastrado.</p>'}</div></div><div class="cd"><h2>Classificação após a ${round}ª rodada (dados conhecidos)</h2><div class="sc"><table><thead><tr><th>Pos.</th><th class="l">Clube</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>P</th></tr></thead><tbody>${order.map((code, index) => `<tr><td>${index + 1}º</td><td class="l"><button class="tn" data-act="open-club" data-team="${code}">${lg(code)}${escapeHtml(NM[code])}</button></td><td>${stats[code].J}</td><td>${stats[code].V}</td><td>${stats[code].E}</td><td>${stats[code].D}</td><td>${stats[code].GP}</td><td>${stats[code].GC}</td><td><b>${stats[code].P}</b></td></tr>`).join('')}</tbody></table></div></div></div>`;
    }
    function renderSearch() {
      const query = siteSearch.trim().toLocaleLowerCase('pt-BR');
      const teamMatches = T.filter(
        (code) => !query || NM[code].toLocaleLowerCase('pt-BR').includes(query) || code.toLowerCase().includes(query),
      ).slice(0, 10);
      const fixtureMatches = ALL_FIXTURES.filter(
        (fixture) =>
          !query ||
          `${NM[fixture.home]} ${NM[fixture.away]} ${fixture.round} ${fixture.stadium || ''}`
            .toLocaleLowerCase('pt-BR')
            .includes(query),
      ).slice(0, 30);
      $('#v-search').innerHTML =
        `<div class="cd"><h2>Buscar clube, partida ou rodada</h2><label for="siteSearch">Digite um nome, sigla, estádio ou número da rodada</label><input id="siteSearch" type="search" value="${escapeHtml(siteSearch)}" maxlength="80" autocomplete="off" aria-controls="searchResults"><div id="searchResults" class="g2"><div><h3>Clubes (${teamMatches.length})</h3>${teamMatches.map((code) => `<p><button data-act="open-club" data-team="${code}">${lg(code)}${escapeHtml(NM[code])}</button></p>`).join('')}</div><div><h3>Partidas (${fixtureMatches.length})</h3>${fixtureMatches
          .map((fixture) => {
            const result = rawResults.find(
              (item) => item.round === fixture.round && item.home === fixture.home && item.away === fixture.away,
            );
            return `<p><button data-act="open-round" data-round="${fixture.round}">${fixture.round}ª · ${escapeHtml(NM[fixture.home])} ${result ? `${result.homeGoals}–${result.awayGoals}` : 'x'} ${escapeHtml(NM[fixture.away])} · ${fixture.kickoff ? formatLiveTime(fixture.kickoff) : 'data a definir'}</button></p>`;
          })
          .join('')}</div></div></div>`;
      const input = $('#siteSearch');
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    function renderGuide() {
      $('#v-guide').innerHTML =
        `<section class="cd help-intro" id="help-start" tabindex="-1"><span class="hero-kicker">CENTRAL DE AJUDA · SIMULABR</span><h2>Entenda o site e encontre respostas</h2><p>Dados da temporada, cenários, conta e privacidade explicados sem jargão.</p><div class="help-shortcuts"><button data-act="start-tour">Fazer visita guiada</button><button data-act="show-help-section" data-section="help-data">Dados e simulações</button><button data-act="show-help-section" data-section="help-privacy">Privacidade</button><button data-act="show-help-section" data-section="terms-of-use">Termos de uso</button></div><div class="help-columns"><article><h3>Como começar</h3><ol><li>Veja a partida em destaque ou abra <b>Ao vivo</b> para consultar a rodada.</li><li>Em <b>Simular</b>, escolha uma rodada e ajuste placares ou use uma simulação automática.</li><li>Confira como o cenário altera a classificação e as probabilidades.</li><li>Crie uma conta para sincronizar palpites, salvar cenários, escolher favoritos e configurar lembretes.</li></ol></article><article id="help-data" tabindex="-1"><h3>Fontes e probabilidades</h3><p>A classificação atual é consultada no GE quando o feed está disponível; o GE é uma fonte jornalística, não oficial da CBF. Resultados anteriores, calendário completo e histórico usam o snapshot local identificado em <b>Fontes</b>.</p><p>Probabilidades são estimativas do modelo e simulações reproduzíveis, não previsões oficiais, odds, garantia de resultado ou aconselhamento de apostas. Desempates e vagas continentais podem usar aproximações.</p><button data-act="show-view" data-view="src">Consultar fontes e método</button></article></div></section>
 <details class="cd help-legal" id="help-privacy"><summary><span>Privacidade</span><span>Quais dados usamos e como cuidar deles</span></summary><div class="legal-content"><p><b>Última atualização: 11/10/2026.</b> Esta página explica o funcionamento de privacidade previsto nesta versão do SimulaBR. O serviço de autenticação e banco é fornecido pelo Supabase, e a hospedagem pode ter seus próprios registros e políticas.</p><h3>Dados que podem ser tratados</h3><ul><li><b>Conta:</b> e-mail e nome informado no cadastro, processados pelo Supabase Auth.</li><li><b>Palpites:</b> placares escolhidos, instante do registro, partida e, quando disponível, fotografia dos parâmetros e probabilidades do modelo.</li><li><b>Dados de conta:</b> cenários salvos, clubes favoritos e preferências de lembretes no site.</li><li><b>No seu navegador:</b> cenário ativo, histórico local de palpites e cópia da última consulta válida do feed podem ficar no armazenamento local; a sessão de login fica em armazenamento de sessão.</li><li><b>Dados técnicos:</b> a hospedagem e os provedores de autenticação podem registrar informações técnicas de acesso conforme suas configurações e políticas.</li></ul><h3>Para que são usados</h3><p>Os dados de conta servem para autenticar você, sincronizar recursos solicitados e exibir o painel pessoal. Favoritos e lembretes são opcionais; lembretes são avisos dentro do site enquanto ele está aberto, não mensagens push ou e-mails. O SimulaBR não processa doações: o link do Ko-fi leva a um serviço externo, que trata qualquer pagamento segundo as próprias regras.</p><h3>Armazenamento, compartilhamento e controle</h3><p>Dados sincronizados ficam no projeto Supabase configurado pelo operador, sob políticas de acesso por conta. O site não mostra seu e-mail, histórico ou preferências em links públicos de cenário; esses links contêm apenas o cenário compartilhado. Não inclua informações pessoais nos placares ou no conteúdo que compartilhar.</p><p>Você pode alterar dados de conta, sair e solicitar a exclusão pela seção <b>Minha conta</b>. A exclusão configurada remove a conta e os registros associados nas tabelas do projeto; dados guardados no navegador não são apagados automaticamente por isso e podem ser removidos limpando os dados locais do site no navegador. A hospedagem ou provedores podem manter cópias técnicas sujeitas às respectivas políticas e prazos.</p><p>Para dúvidas ou solicitações sobre dados, use o canal de contato informado pelo operador do site. Antes de publicar, substitua esta instrução por um endereço de contato monitorado e confira as configurações de retenção do Supabase e da hospedagem.</p></div></details>
 <details class="cd help-legal" id="terms-of-use"><summary><span>Termos de uso</span><span>Regras para usar o SimulaBR</span></summary><div class="legal-content"><p><b>Última atualização: 11/10/2026.</b> Ao acessar o SimulaBR, você concorda com estes termos. Se não concordar, não use os recursos de conta.</p><h3>O que o serviço oferece</h3><p>O SimulaBR é uma ferramenta independente de informação e entretenimento para acompanhar dados disponíveis e criar simulações da temporada. Não é afiliado à CBF, aos clubes, ao GE ou às competições citadas. Resultados e calendário podem conter lacunas, atrasos ou correções; consulte as fontes indicadas para confirmar informações.</p><h3>Simulações não são previsões oficiais</h3><p>Probabilidades, classificações projetadas e cenários dependem dos dados e das configurações escolhidas, usam aproximações e não garantem resultados. Não constituem aconselhamento financeiro, recomendação de apostas ou promessa de retorno. O usuário é responsável por suas decisões e deve observar as leis aplicáveis.</p><h3>Conta e uso aceitável</h3><p>Informe dados verdadeiros, proteja sua senha e use apenas a própria conta. Não tente acessar dados alheios, comprometer o serviço, contornar controles de segurança ou usar o site de forma ilegal. Recursos pessoais sincronizados dependem de uma conta e da disponibilidade dos provedores.</p><h3>Disponibilidade, conteúdo externo e apoio</h3><p>O serviço pode ficar temporariamente indisponível ou mudar para manutenção e atualização. Links para GE, Supabase e Ko-fi abrem serviços de terceiros sujeitos aos próprios termos e políticas. Apoio pelo Ko-fi é voluntário, externo e não é necessário para usar o simulador.</p><h3>Dados pessoais e encerramento</h3><p>O tratamento de dados é explicado na seção Privacidade. Você pode parar de usar o site a qualquer momento e solicitar a exclusão da conta pela área Minha conta, quando o recurso estiver configurado.</p><h3>Alterações e contato</h3><p>Estes termos podem ser atualizados quando o serviço mudar; a data no início indicará a revisão mais recente. Para questões sobre o serviço, use o canal de contato informado pelo operador. Este texto deve ser revisado com os dados de contato e as condições da operação antes da publicação comercial.</p></div></details>
 <section class="cd help-footer"><h2>Quer saber mais?</h2><p>Consulte a procedência e as limitações dos dados antes de usar uma simulação como referência.</p><button data-act="show-view" data-view="src">Abrir fontes e método</button></section>`;
    }
    // ---- Notificações push (gol, início e fim de jogo dos clubes favoritos) ----
    const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    function vapidKeyBytes(base64) {
      const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    }
    async function currentPushSubscription() {
      if (!pushSupported()) return null;
      const registration = await navigator.serviceWorker.ready;
      return registration.pushManager.getSubscription();
    }
    async function enablePush() {
      if (!signedInUser || !supabaseClient) throw new Error('Entre na conta para ativar as notificações.');
      if (!PUBLIC_CONFIG.vapidPublicKey) throw new Error('As notificações ainda não foram configuradas no servidor.');
      if (!favoriteTeams.length) throw new Error('Escolha pelo menos um clube favorito antes.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('O navegador não autorizou as notificações.');
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(PUBLIC_CONFIG.vapidPublicKey),
        }));
      const { endpoint, keys } = subscription.toJSON();
      const { error } = await supabaseClient
        .from('push_subscriptions')
        .upsert(
          { endpoint, user_id: signedInUser.id, p256dh: keys.p256dh, auth: keys.auth },
          { onConflict: 'endpoint' },
        );
      if (error) {
        await subscription.unsubscribe();
        throw new Error(`Não foi possível salvar a inscrição: ${error.message}`);
      }
    }
    async function disablePush() {
      const subscription = await currentPushSubscription();
      if (!subscription) return;
      if (supabaseClient)
        await supabaseClient.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
      await subscription.unsubscribe();
    }
    async function refreshPushCard() {
      const box = $('#pushStatus');
      if (!box) return;
      if (!pushSupported()) {
        box.innerHTML =
          '<p class="mu sm">Este navegador não aceita notificações. No iPhone, adicione o site à tela de início primeiro.</p>';
        return;
      }
      if (!PUBLIC_CONFIG.vapidPublicKey) {
        box.innerHTML = '<p class="mu sm">As notificações ainda não foram ativadas neste servidor.</p>';
        return;
      }
      const subscription = await currentPushSubscription();
      box.innerHTML = subscription
        ? `<p class="sm">Ativadas neste aparelho para ${favoriteTeams.length ? favoriteTeams.map((code) => escapeHtml(NM[code])).join(', ') : 'seus favoritos'}.</p><button data-act="push-disable">Desativar neste aparelho</button>`
        : `<p class="mu sm">Receba um aviso no celular ou no computador quando um clube favorito começar a jogar, marcar ou terminar a partida, mesmo com o site fechado.</p><button class="p" data-act="push-enable">${ic('bell')}Ativar notificações</button>`;
    }
    const pushCard = () =>
      '<section class="cd"><h2>Notificações de gol</h2><div id="pushStatus"><p class="mu sm">Verificando…</p></div></section>';
    function renderAccountWorkspace() {
      const root = $('#v-account');
      if (!root) return;
      if (!signedInUser) {
        root.innerHTML = `<div class="cd"><h2>Minha conta</h2><p>Crie uma conta grátis para salvar cenários e favoritos na nuvem, sincronizar seus palpites e configurar lembretes de clubes. O simulador, os perfis e os dados públicos continuam disponíveis sem login.</p><button class="p" data-act="open-account" data-mode="register">Criar conta</button> <button data-act="open-account">Já tenho conta</button></div>`;
        return;
      }
      const name = signedInUser.user_metadata?.display_name || signedInUser.user_metadata?.name || '';
      root.innerHTML = `<div class="cd"><h2>Minha conta</h2><p>Conectado como <b>${escapeHtml(signedInUser.email || '')}</b></p><form id="profileNameForm"><label for="profileName">Nome exibido</label><input id="profileName" maxlength="80" required value="${escapeHtml(name)}"><button class="p" type="submit">Salvar nome</button></form><form id="passwordChangeForm"><h3>Alterar senha</h3><label for="currentPassword">Senha atual</label><input id="currentPassword" type="password" autocomplete="current-password" required><label for="newPassword">Nova senha (mínimo 8 caracteres)</label><input id="newPassword" type="password" autocomplete="new-password" minlength="8" required><button type="submit">Atualizar senha</button></form><hr><button data-act="sign-out">Sair da conta</button></div><div class="cd"><h2>Cenários salvos</h2><p>Salve o cenário atual com seus placares, semente, método e ajustes para abrir em outro dispositivo ou comparar.</p><button class="p" data-act="save-current-scenario">Salvar cenário atual</button><div class="grid" style="margin-top:10px">${savedScenarios.length ? savedScenarios.map((item) => `<article class="mc"><h3>${escapeHtml(item.name)}</h3><p class="mu sm">Atualizado ${formatLiveTime(item.updatedAt)}</p><div class="row"><button data-act="load-saved-scenario" data-id="${escapeHtml(item.id)}">Abrir</button><button data-act="duplicate-saved-scenario" data-id="${escapeHtml(item.id)}">Duplicar</button><button data-act="compare-saved-scenario" data-id="${escapeHtml(item.id)}">Comparar</button><button data-act="delete-saved-scenario" data-id="${escapeHtml(item.id)}">Excluir</button></div></article>`).join('') : '<p class="mu">Você ainda não salvou cenários.</p>'}</div></div><div class="cd"><h2>Clubes favoritos e lembretes no site</h2><p>Lembretes aparecem dentro do simulador enquanto esta página está aberta; não enviamos e-mail ou notificações quando o site está fechado.</p><div class="ctl"><label for="reminderEnabled"><input id="reminderEnabled" type="checkbox" data-change="reminder-enabled" ${accountPreferences.inSiteReminders ? 'checked' : ''}> Avisar antes dos próximos jogos dos clubes favoritos</label><label for="reminderMinutes">Avisar com antecedência<select id="reminderMinutes" data-change="reminder-minutes">${[5, 15, 30, 60, 120].map((minutes) => `<option value="${minutes}" ${minutes === accountPreferences.reminderMinutes ? 'selected' : ''}>${minutes} minutos</option>`).join('')}</select></label></div><div class="ctl">${T.map((code) => `<label><input type="checkbox" data-change="favorite-preference" data-team="${code}" ${favoriteTeams.includes(code) ? 'checked' : ''}> ${escapeHtml(NM[code])}</label>`).join('')}</div></div><div class="cd warn"><h2>Excluir conta</h2><p>Esta ação remove permanentemente a conta, palpites e cenários sincronizados. É irreversível e exige a senha atual. O serviço de exclusão precisa estar configurado no servidor de hospedagem.</p><form id="deleteAccountForm"><label for="deletePassword">Confirme sua senha</label><input id="deletePassword" type="password" autocomplete="current-password" required><label for="deleteConfirm">Digite EXCLUIR</label><input id="deleteConfirm" required pattern="EXCLUIR"><button type="submit">Excluir conta e dados</button></form></div>`;
      root
        .querySelector('[data-act="save-current-scenario"]')
        ?.insertAdjacentHTML(
          'beforebegin',
          '<label for="scenarioName">Nome do novo cenário (até 60 caracteres)</label><input id="scenarioName" maxlength="60" placeholder="Ex.: Rodada 30 — cenário otimista">',
        );
      const scenarios = root.querySelector('.cd:nth-child(2)');
      if (scenarios) {
        const description = scenarios.querySelector('p');
        if (description)
          description.textContent =
            'Guarde seus placares, semente, método e ajustes para continuar sua simulação em outro dispositivo.';
        scenarios.querySelectorAll('[data-act="compare-saved-scenario"]').forEach((button) => button.remove());
      }
      root.querySelector('.cd.warn')?.insertAdjacentHTML('beforebegin', pushCard());
      refreshPushCard().catch((error) => {
        const box = $('#pushStatus');
        if (box) box.textContent = error.message;
      });
    }
    function nav() {
      for (const key of VIEWS)
        if (!$('#v-' + key)) {
          const panel = document.createElement('section');
          panel.id = 'v-' + key;
          panel.setAttribute('role', 'tabpanel');
          panel.hidden = true;
          $('#main').append(panel);
        }
      $('#nav').innerHTML = TABS.map(
        ([k, t]) =>
          `<a role="tab" id="tab-${k}" href="${pathFor({ view: k, sub: subView[k] }, NM)}" aria-controls="v-${k}" aria-selected="${view == k}" tabindex="${view == k ? '0' : '-1'}" class="${view == k ? 'on' : ''}" data-act="show-view" data-view="${k}">${t}${k === 'live' && LIVE_MATCHES.length ? '<i class="dot" aria-hidden="true"></i><span class="sr-only"> (jogos em andamento)</span>' : ''}</a>`,
      ).join('');
    }
    function renderView(v) {
      if (v == 'home') renderHome();
      if (v == 'perf') renderPerformance();
      if (v == 'est') renderStats();
      if (v == 'cor') renderChances();
      if (v == 'copas') {
        renderCups();
        ensureCups([CUPS.active]).then(() => view === 'copas' && renderCups());
      }
      if (v == 'src') {
        renderSrc();
        updateSourceAndRules();
        $('#v-src').insertAdjacentHTML(
          'afterbegin',
          `<div class="page-head"><div><h1>Fontes e método</h1><p class="mu">De onde vêm os dados, como o modelo funciona e os limites do simulador.</p></div></div>${sourceStatusCard()}`,
        );
      }
      if (v == 'sim') renderAll();
      if (v == 'live') renderLiveHub();
      if (v == 'clubs') renderClubPage();
      if (v == 'search') renderSearch();
      if (v == 'guide') renderGuide();
      if (v == 'account') renderAccountWorkspace();
    }
    // Endereço atual da tela (sem recarregar a página).
    function updateUrl({ push = false } = {}) {
      const path = pathFor(
        {
          view,
          sub: subView[view],
          team: view === 'clubs' ? statsTeam : null,
          round: selectedHistoryRound,
          cup: CUPS.active,
        },
        NM,
      );
      const names = {
        home: 'Brasileirão 2026: tabela, chances e simulador',
        live: 'Ao vivo',
        sim: 'Simulador',
        cor: 'Chances',
        copas: COMPETITIONS[CUPS.active]?.name || 'Copas',
        clubs: NM[statsTeam] || 'Clubes',
        est: subView.est === 'rounds' ? `${selectedHistoryRound}ª rodada` : 'Estatísticas',
        perf: 'Palpites',
        src: 'Fontes e método',
        guide: 'Ajuda',
        search: 'Buscar',
        account: 'Minha conta',
      };
      document.title = `${names[view] || 'Brasileirão 2026'} · SimulaBR`;
      if (path === location.pathname) return;
      try {
        history[push ? 'pushState' : 'replaceState']({ path }, '', path);
      } catch {
        // file:// ou navegador antigo: segue sem mudar o endereço
      }
    }
    function applyRoute(route) {
      if (route.sub && route.view in subView) subView[route.view] = route.sub;
      if (route.team) statsTeam = route.team;
      if (route.round) selectedHistoryRound = route.round;
      if (route.cup) CUPS.active = route.cup;
    }
    function show(v, { focus = true, push = true } = {}) {
      if (v === 'history') {
        subView.est = 'rounds';
        v = 'est';
      }
      view = v;
      VIEWS.forEach((k) => {
        $('#v-' + k).hidden = k != v;
        if (TABS.some(([key]) => key === k)) $('#v-' + k).setAttribute('aria-labelledby', 'tab-' + k);
      });
      nav();
      applyCupTheme();
      renderView(v);
      updateUrl({ push });
      scrollTo(0, 0);
      if (focus) ($('#tab-' + v) || $('#main'))?.focus({ preventScroll: true });
    }
    function updateEstSource() {
      const paragraph = Array.from($('#v-est').querySelectorAll('p')).find((element) =>
        element.textContent.includes('Referência histórica 2025'),
      );
      if (paragraph)
        paragraph.textContent = `Estes indicadores são calculados dos resultados detalhados disponíveis no snapshot local, atualizado em ${updatedLabel}; a API anexada informa somente a rodada atual, não o histórico completo. Referência histórica 2025 (ogol): 50% mandante, 26% empates, 24% visitante e 2,52 gols por jogo.`;
    }
    function renderEst() {
      const L = LG,
        n = L.n,
        ps = (x) => f1((x / n) * 100) + '%';
      const sample = rawResults.filter(
        (result) =>
          (snapshotStatsRound === 'all' || result.round === Number(snapshotStatsRound)) &&
          (snapshotStatsTeam === 'all' || result.home === snapshotStatsTeam || result.away === snapshotStatsTeam),
      );
      const sampleGoals = sample.reduce((sum, result) => sum + result.homeGoals + result.awayGoals, 0),
        sampleDraws = sample.filter((result) => result.homeGoals === result.awayGoals).length,
        sampleHome = sample.filter((result) => result.homeGoals > result.awayGoals).length,
        sampleAway = sample.length - sampleDraws - sampleHome;
      const sampleTeam =
        snapshotStatsTeam === 'all'
          ? null
          : sample.reduce(
              (stats, result) => {
                const home = result.home === snapshotStatsTeam,
                  scored = home ? result.homeGoals : result.awayGoals,
                  conceded = home ? result.awayGoals : result.homeGoals;
                stats.played++;
                stats.goalsFor += scored;
                stats.goalsAgainst += conceded;
                stats.points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
                return stats;
              },
              { played: 0, goalsFor: 0, goalsAgainst: 0, points: 0 },
            );
      const rows = T.map((c) => {
        const t = TS[c],
          e = t.h.d + t.a.d,
          J = t.h.n + t.a.n;
        return {
          c,
          e,
          pe: (e / J) * 100,
          ph: (3 * t.h.w + t.h.d) / t.h.n,
          pa: (3 * t.a.w + t.a.d) / t.a.n,
          gh: t.h.gf / t.h.n,
          ch: t.h.ga / t.h.n,
          ga: t.a.gf / t.a.n,
          ca: t.a.ga / t.a.n,
          cs: t.cs,
          gf: (t.h.gf + t.a.gf) / J,
          gc: (t.h.ga + t.a.ga) / J,
          pts: 3 * (t.h.w + t.a.w) + t.h.d + t.a.d,
        };
      });
      rows.sort((a, b) => sortD * ((a[sortK] || 0) - (b[sortK] || 0)));
      const best = (k, d) => rows.slice().sort((a, b) => d * (b[k] - a[k]))[0];
      const hl = [
        ['Mais empates', best('e', 1), (r) => r.e + ' (' + Math.round(r.pe) + '%)'],
        ['Melhor mandante', best('ph', 1), (r) => f1(r.ph) + ' pts/jogo'],
        ['Melhor visitante', best('pa', 1), (r) => f1(r.pa) + ' pts/jogo'],
        ['Melhor ataque', best('gf', 1), (r) => f1(r.gf) + ' gols/jogo'],
        ['Melhor defesa', best('gc', -1), (r) => f1(r.gc) + ' gols sofridos/jogo'],
      ];
      const liveTeam = LIVE_STANDINGS?.get(statsTeam),
        liveStats = LIVE_STANDINGS
          ? `<div class="cd"><h2>Estatísticas atualizadas por clube</h2><p class="mu sm">Classificação e totais conforme a última consulta ao GE. Não são dados oficiais da CBF.</p><label for="statsTeamSelect">Escolha um clube:</label> <select id="statsTeamSelect" data-change="stats-team">${[
              ...LIVE_STANDINGS,
            ]
              .sort((a, b) => a[1].position - b[1].position)
              .map(
                ([code, entry]) =>
                  `<option value="${code}" ${code === statsTeam ? 'selected' : ''}>${entry.position}º · ${NM[code]}</option>`,
              )
              .join(
                '',
              )}</select>${liveTeam ? `<div class="tile"><div><b>${liveTeam.position}º</b><span>Posição</span></div><div><b>${liveTeam.points}</b><span>Pontos</span></div><div><b>${liveTeam.matches}</b><span>Jogos</span></div><div><b>${liveTeam.wins}/${liveTeam.draws}/${liveTeam.losses}</b><span>V/E/D</span></div><div><b>${liveTeam.goalsFor}–${liveTeam.goalsAgainst}</b><span>Gols pró/contra</span></div><div><b>${liveTeam.goalDifference > 0 ? '+' : ''}${liveTeam.goalDifference}</b><span>Saldo</span></div><div><b>${liveTeam.efficiency == null ? '–' : liveTeam.efficiency + '%'}</b><span>Aproveitamento</span></div></div><p class="sm">Últimos resultados: ${(liveTeam.recentForm || []).map((result) => ({ W: 'V', D: 'E', L: 'D' })[result] || result).join(' · ') || 'sem dados'}.</p>` : ''}<p class="mu sm">${liveFeed?.stale ? 'Cache desatualizado' : 'Atualizado em ' + formatLiveTime(liveFeed?.fetchedAt)} · Rodada consultada: ${LIVE_ROUND?.number || '–'}.${liveFeed?.historyWarning ? ` ${escapeHtml(liveFeed.historyWarning)}` : ''}</p></div>`
          : `<div class="cd warn"><h2>Estatísticas ao vivo indisponíveis</h2><p>Exibindo os números do snapshot local; não foi possível consultar o GE. ${escapeHtml(liveFeedError || '')}</p></div>`;
      const sc = Object.entries(L.sc)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
        fut = Array.from({ length: 38 }, (_, r) =>
          M.filter((m) => m.r === r + 1 && !m.late).reduce((q, m) => q + grid(m.h, m.a).D, 0),
        ),
        dv = L.dr.map((draws, i) => draws + fut[i]),
        lb = dv.map((_, i) => i + 1),
        ref = (L.D / n) * 10;
      const th = (k, t) =>
        `<th class="so" scope="col"><button class="sort-button" data-act="sort-stats" data-key="${k}">${t}</button></th>`;
      $('#v-est').innerHTML =
        `${liveStats}<div class="cd stats-filter"><h2>Explore os resultados por clube e rodada</h2><div class="row"><label for="snapshotStatsTeam">Clube:</label><select id="snapshotStatsTeam" data-change="snapshot-stats-team"><option value="all" ${snapshotStatsTeam === 'all' ? 'selected' : ''}>Todos os clubes</option>${T.map((code) => `<option value="${code}" ${snapshotStatsTeam === code ? 'selected' : ''}>${escapeHtml(NM[code])}</option>`).join('')}</select><label for="snapshotStatsRound">Rodada:</label><select id="snapshotStatsRound" data-change="snapshot-stats-round"><option value="all" ${snapshotStatsRound === 'all' ? 'selected' : ''}>Todas</option>${ROUND_OPTIONS.map((round) => `<option value="${round}" ${snapshotStatsRound === String(round) ? 'selected' : ''}>${round}ª rodada</option>`).join('')}</select></div><p class="mu sm">Amostra: ${sample.length} ${sample.length === 1 ? 'partida' : 'partidas'} com resultado no snapshot.${snapshotStatsTeam !== 'all' ? ` ${escapeHtml(NM[snapshotStatsTeam])}: ${sampleTeam.played} jogos, ${sampleTeam.points} pontos e ${sampleTeam.goalsFor} gols marcados.` : ''}</p><div class="tile"><div><b>${sample.length ? f1(sampleGoals / sample.length) : '–'}</b><span>Gols por jogo</span></div><div><b>${sample.length ? f1((sampleHome / sample.length) * 100) + '%' : '–'}</b><span>Vitória mandante</span></div><div><b>${sample.length ? f1((sampleDraws / sample.length) * 100) + '%' : '–'}</b><span>Empates</span></div><div><b>${sample.length ? f1((sampleAway / sample.length) * 100) + '%' : '–'}</b><span>Vitória visitante</span></div></div>${sample.length ? bars([sampleHome, sampleDraws, sampleAway], ['Casa', 'Empate', 'Fora'], { h: 70, max: sample.length, fmt: (value) => `${value} jogo(s)` }) : '<p class="mu">Não há resultados disponíveis para esses filtros.</p>'}</div><div class="cd"><h2>Panorama do snapshot de resultados (${n} partidas disponíveis)</h2><div class="tile"><div><b>${ps(L.H)}</b><span>Mandante vence</span></div><div><b>${ps(L.D)}</b><span>Empates</span></div><div><b>${ps(L.A)}</b><span>Visitante vence</span></div><div><b>${f1(L.gols / n)}</b><span>Gols por jogo</span></div><div><b>${ps(L.o25)}</b><span>3+ gols</span></div><div><b>${ps(L.btts)}</b><span>Ambas marcam</span></div><div><b>${L.z}</b><span>Jogos 0x0</span></div></div>
 <p class="mu sm" style="margin:0">Estes indicadores são calculados dos resultados detalhados disponíveis no snapshot; a API anexada informa somente a rodada atual, não o histórico completo. Referência histórica 2025 (ogol): 50% mandante, 26% empates, 24% visitante e 2,52 gols por jogo.</p></div>
 <div class="g2"> <div class="cd"><h2>Empates por rodada</h2>${bars(dv, lb, { h: 100, max: 6, col: (i) => (i < 29 ? 'var(--mu2)' : 'var(--ac)'), op: (i) => (i < 29 ? 1 : 0.55), ref: ref, step: 2 })}<p class="mu sm" style="margin:4px 0 0">Cinza: empates dos resultados detalhados disponíveis. Dourado: empates já registrados mais a expectativa do modelo para jogos ainda não realizados nas rodadas 30–38. Linha tracejada: média dos resultados detalhados disponíveis (${f1(ref)} por rodada).</p></div>
 <div class="cd"><h2>Gols por jogo em cada rodada</h2>${bars(
   L.gr,
   L.gr.map((_, i) => i + 1),
   { h: 100, max: 4, ref: L.gols / n, fmt: (v) => f1(v), step: 2 },
 )}<p class="mu sm" style="margin:4px 0 0">Linha: média de ${f1(L.gols / n)} gols por jogo.</p><h2 style="margin-top:12px">Placares mais comuns</h2>${bars(
   sc.map((x) => x[1]),
   sc.map((x) => x[0]),
   { h: 70, fmt: (v) => v + ' jogos' },
 )}</div></div>
 <div class="cd"><h2>Destaques da temporada</h2><div class="tile">${hl.map(([t, r, f]) => `<div>${lg(r.c)}<b style="font-size:.95rem">${NM[r.c]}</b><span>${t}: ${f(r)}</span></div>`).join('')}</div></div>
 <div class="cd"><h2>Desempenho detalhado do snapshot por time (clique no cabeçalho para ordenar)</h2><div class="sc"><table><tr><th class="l">Time</th>${th('pts', 'P')}${th('e', 'Emp.')}${th('pe', '% emp.')}${th('ph', 'Pts/jogo casa')}${th('pa', 'Pts/jogo fora')}${th('gh', 'GP casa')}${th('ch', 'GC casa')}${th('ga', 'GP fora')}${th('ca', 'GC fora')}${th('cs', 'Jogos sem sofrer gol')}<th>Forma</th></tr>${rows.map((r) => `<tr><td class="l"><span class="tn">${lg(r.c)}${NM[r.c]}</span></td><td class="n">${r.pts}</td><td>${r.e}</td><td>${Math.round(r.pe)}%</td><td>${f1(r.ph)}</td><td>${f1(r.pa)}</td><td>${f1(r.gh)}</td><td>${f1(r.ch)}</td><td>${f1(r.ga)}</td><td>${f1(r.ca)}</td><td>${r.cs}</td><td>${form(r.c, { [r.c]: { sim: [] } })}</td></tr>`).join('')}</table></div></div>`;
    }
    function renderPerformance() {
      const completed = predictionHistory.filter((entry) => entry.actual),
        userHistory = completed.filter((entry) => entry.prediction.type === 'u'),
        summary = summarizePredictionPerformance(userHistory, T),
        automatic = completed.length - userHistory.length,
        calibration = summarizePredictionCalibration(completed),
        fmtRate = (value) => (value == null ? '–' : `${(value * 100).toFixed(1).replace('.', ',')}%`),
        difference = (value) => `${value > 0 ? '+' : ''}${value}`;
      const rows = summary.clubs
        .map(
          (club) =>
            `<tr><td class="l">${lg(club.code)}${NM[club.code]}</td><td>${club.matches}</td><td>${club.predictedPoints}</td><td>${club.actualPoints}</td><td class="${club.pointsDifference === 0 ? '' : club.pointsDifference > 0 ? 'gain' : 'dn'}">${difference(club.pointsDifference)}</td></tr>`,
        )
        .join('');
      const matches = completed
        .slice()
        .sort((a, b) => b.round - a.round || b.recordedAt.localeCompare(a.recordedAt))
        .map((entry) => {
          const predicted = entry.prediction,
            actual = entry.actual,
            exact = predicted.home === actual.home && predicted.away === actual.away,
            source = entry.resultSource,
            snapshot = entry.modelSnapshot,
            sourceDate = source.type === 'verified-backfill' ? source.verifiedAt : source.observedAt;
          const model = snapshot
            ? `Casa ${fmtRate(snapshot.probabilities.home)} · Empate ${fmtRate(snapshot.probabilities.draw)} · Fora ${fmtRate(snapshot.probabilities.away)} · semente ${snapshot.settings.seed} · ${formatLiveTime(snapshot.recordedAt)}`
            : 'Sem snapshot histórico';
          return `<tr><td>${entry.round}</td><td class="l">${escapeHtml(NM[entry.home])} ${predicted.home}–${predicted.away} ${escapeHtml(NM[entry.away])}</td><td class="l">${actual.home}–${actual.away}</td><td>${exact ? 'Sim' : 'Não'}</td><td>${predicted.type === 'a' ? 'Automático' : 'Seu palpite'}</td><td class="l">${escapeHtml(source.name)}${sourceDate ? ` · ${formatLiveTime(sourceDate)}` : ''}${safeUrl(source.url) ? ` · <a href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">fonte</a>` : ''}</td><td class="l">${model}</td></tr>`;
        })
        .join('');
      const calibrationRows = calibration.bins
        .map(
          (bin) =>
            `<tr><td>${Math.round(bin.min * 100)}–${Math.round(bin.max * 100)}%</td><td>${bin.matches}</td><td>${fmtRate(bin.meanConfidence)}</td><td>${fmtRate(bin.observedAccuracy)}</td></tr>`,
        )
        .join('');
      const calibrationTrend = summarizeCalibrationByRound(completed),
        trendRows = calibrationTrend
          .map(
            (row) =>
              `<tr><td>${row.round}</td><td>${row.matches}</td><td>${row.brierScore.toFixed(3).replace('.', ',')}</td></tr>`,
          )
          .join('');
      const savedStatus = signedInUser
        ? `Sincronização da conta ${escapeHtml(signedInUser.email)}. O histórico permanece vinculado à conta.`
        : 'Salvo somente neste navegador. Crie uma conta grátis para sincronizar seus palpites e cenários entre dispositivos.';
      $('#v-perf').innerHTML =
        `<div class="cd"><h2>Precisão dos seus palpites</h2><p class="mu sm">${savedStatus} A taxa de acerto usa apenas placares que você digitou; previsões automáticas são listadas separadamente. Resultados anteriores ao início da captura não têm snapshot e não entram na calibração.</p>${signedInUser ? '' : `<button class="p" data-act="open-account" data-mode="register">Criar conta grátis</button>`}${summary.matches ? `<div class="tile"><div><b>${summary.matches}</b><span>Seus palpites avaliados</span></div><div><b>${summary.exactScoreHits}</b><span>Placar exato</span></div><div><b>${fmtRate(summary.outcomeRate)}</b><span>Acerto casa/empate/fora</span></div><div><b>${automatic}</b><span>Preenchidos pelo modelo</span></div><div><b>${summary.predictedGoals}–${summary.actualGoals}</b><span>Gols previstos–reais</span></div></div><p>Acertou o placar exato em <b>${summary.exactScoreHits}</b> de ${summary.matches} jogos (${fmtRate(summary.exactScoreRate)}); acertou o resultado em <b>${summary.correctOutcomeHits}</b> (${fmtRate(summary.outcomeRate)}).</p>` : `<div class="cd warn"><p><b>Nenhum palpite seu concluído foi registrado ainda.</b></p><p>Faça palpites para jogos futuros; quando um resultado confirmado entrar no simulador, a comparação aparecerá aqui.</p><p>Palpites antigos sem fotografia do modelo não podem ser reconstruídos nem avaliados na calibração.</p>${automatic ? `<p>${automatic} previsão(ões) automática(s) já foram avaliadas; elas não entram na sua taxa de acerto.</p>` : ''}</div>`}</div>
 <div class="cd"><h2>Calibração das probabilidades do modelo</h2><p>O <b>Brier score</b> é a média da soma dos erros quadráticos nas probabilidades de casa, empate e visitante: <b>0 é perfeito</b> e valores menores são melhores (máximo 2). Cada palpite entra com a fotografia das probabilidades salva quando foi preenchido.</p>${calibration.matches ? `<div class="tile"><div><b>${calibration.brierScore.toFixed(3).replace('.', ',')}</b><span>Brier score · ${calibration.matches} jogos</span></div></div><div class="sc" role="region" aria-label="Calibração por faixa de confiança" tabindex="0"><table><thead><tr><th>Confiança prevista</th><th>Jogos</th><th>Confiança média</th><th>Resultado mais provável ocorreu</th></tr></thead><tbody>${calibrationRows}</tbody></table></div><p class="mu sm">Nas faixas, comparamos a confiança média do resultado mais provável com a frequência em que ele ocorreu. Amostras pequenas oscilam bastante; esta métrica descreve os palpites registrados, não prova que o modelo seja confiável.</p>` : `<p class="mu">Ainda não há resultados concluídos com snapshot de probabilidades. Novos palpites terão seus parâmetros e probabilidades salvos para iniciar essa avaliação.</p>`}</div>
 ${calibrationTrend.length ? `<div class="cd"><h2>Evolução da calibração por rodada</h2><p class="mu sm">Cada linha mostra somente os palpites concluídos com snapshot naquela rodada. Compare com cautela: poucas partidas produzem métricas instáveis.</p><div class="sc" role="region" aria-label="Brier score por rodada" tabindex="0"><table><thead><tr><th>Rodada</th><th>Jogos avaliados</th><th>Brier score (menor é melhor)</th></tr></thead><tbody>${trendRows}</tbody></table></div></div>` : ''}
 ${rows ? `<div class="cd"><h2>Pontos projetados por clube nos jogos avaliados</h2><p class="mu sm">Compara os pontos que seus placares dariam a cada clube com os pontos dos resultados reais, somente nos jogos em que havia um palpite salvo.</p><div class="sc" role="region" aria-label="Pontos previstos e reais por clube" tabindex="0"><table><thead><tr><th class="l">Clube</th><th>Jogos avaliados</th><th>Pontos previstos</th><th>Pontos reais</th><th>Diferença</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : ''}
 ${matches ? `<div class="cd"><h2>Palpites comparados com resultados</h2><div class="sc" role="region" aria-label="Histórico de palpites e resultados" tabindex="0"><table><thead><tr><th>Rodada</th><th class="l">Palpite</th><th class="l">Resultado</th><th>Placar exato</th><th>Origem do palpite</th><th class="l">Fonte do resultado</th><th class="l">Snapshot do modelo</th></tr></thead><tbody>${matches}</tbody></table></div></div>` : ''}`;
    }
    function sortT(k) {
      if (sortK == k) sortD *= -1;
      else {
        sortK = k;
        sortD = -1;
      }
      renderStats();
    }
    function renderCor() {
      const s = project(),
        o = rankTeams(s);
      const cut = (k) =>
          MCR ? [pct(MCR.CP[k], MCR.N, 0.5), pct(MCR.CP[k], MCR.N, 0.1), pct(MCR.CP[k], MCR.N, 0.9)] : null,
        cf = (k, hist) => {
          const c = cut(k);
          return `<tr><td class="l">${hist[0]}</td><td><b>${c ? c[0] : '–'}</b> ${c ? `<span class="mu">(${c[1]}–${c[2]})</span>` : ''}</td><td class="mu">${hist[1]}</td></tr>`;
        };
      const maxPoints = (c) => s[c].P + 3 * (38 - s[c].J);
      // Situação matemática: conta direta com os pontos máximos, sem desempate.
      const sit = (c) => {
        const P = s[c].P,
          mxc = maxPoints(c),
          oth = T.filter((d) => d != c),
          b = [];
        if (oth.every((d) => maxPoints(d) < P)) b.push(['Campeão', 'g']);
        if (oth.filter((d) => s[d].P > mxc).length >= T.length - Q.relegationPlaces) b.push(['Rebaixado', 'r']);
        else if (oth.filter((d) => maxPoints(d) < P).length >= Q.relegationPlaces)
          b.push(['Livre do Z' + Q.relegationPlaces, 'g']);
        if (
          oth.filter((d) => maxPoints(d) >= P).length < Q.libertadoresLeaguePositions &&
          !b.some((q) => q[0] == 'Campeão')
        )
          b.push(['G' + Q.libertadoresLeaguePositions + ' garantido', 'g']);
        return b.map((q) => `<span class="tag ${q[1]}">${q[0]}</span>`).join(' ');
      };
      // Dificuldade: média de pontos por jogo dos adversários que faltam.
      const difficulty = (c) => {
        const ms = M.filter((m) => m.h == c || m.a == c);
        const sum = ms.reduce((total, m) => {
          const op = m.h == c ? m.a : m.h;
          return total + base[op].P / Math.max(1, base[op].J);
        }, 0);
        return ms.length ? sum / ms.length : 0;
      };
      const order = MCR ? o.slice().sort((a, b) => (od(b)?.mean ?? 0) - (od(a)?.mean ?? 0)) : o;
      const cell = (value, tone) =>
        `<td class="${MCR ? '' : 'dim'}"><b>${MCR ? pc(value) : '–'}</b>${MCR ? meter(value, tone) : ''}</td>`;
      const rows = order
        .map((c) => {
          const q = od(c) || { t: 0, g: 0, s: 0, z: 0, mean: 0, lo: 0, hi: 0 };
          return `<tr class="${c == team ? 'hl' : ''}"><td class="l mu">${o.indexOf(c) + 1}º</td><td class="l"><button class="tn" data-act="team-and-sim" data-team="${c}">${lg(c)}<span class="fn">${escapeHtml(NM[c])}</span><span class="ab">${ab(c)}</span></button></td><td class="n">${s[c].P}</td><td>${MCR ? `<b>${Math.round(q.mean)}</b> <span class="mu xs">${q.lo}–${q.hi}</span>` : '–'}</td>${cell(q.t, 'accent')}${cell(q.g, 'g')}${cell(q.s, 'b')}${cell(q.z, 'r')}<td class="mu">${f1(difficulty(c))}</td><td class="l">${sit(c)}</td></tr>`;
        })
        .join('');
      const rel = [];
      for (let p = 37; p <= 47; p++) {
        const q = MCR && MCR.RN[p] >= 15 ? (MCR.RL[p] / MCR.RN[p]) * 100 : null;
        rel.push(`<tr><td>${p}</td><td class="mu">${UF[p]}%</td><td><b>${q == null ? '–' : f1(q) + '%'}</b></td></tr>`);
      }
      $('#v-cor').innerHTML =
        `<section class="cd"><div class="card-head"><h2>Classificação final provável</h2><span class="mu xs">ordenada pelos pontos projetados</span></div><div class="sc"><table><thead><tr><th class="l">Agora</th><th class="l">Clube</th><th>P</th><th>Proj. (10–90%)</th><th>Título</th><th>G${Q.libertadoresLeaguePositions}</th><th>Sul-Am.</th><th>Z${Q.relegationPlaces}</th><th title="Média de pontos por jogo dos adversários que faltam">Dificuldade</th><th class="l">Situação</th></tr></thead><tbody>${rows}</tbody></table></div><p class="mu xs footnote">Dificuldade: média de pontos por jogo dos próximos adversários (maior = calendário mais duro). Situação: conta direta com os pontos máximos, sem critérios de desempate.</p></section>
      <div class="g2"><section class="cd"><h2>Pontos necessários</h2><div class="sc"><table><thead><tr><th class="l">Posição final</th><th>Mediana (10–90%)</th><th>Histórico</th></tr></thead><tbody>${cf(0, ['Campeão', 'média 77 (67–90)'])}${cf(1, [`${Q.libertadoresLeaguePositions}º lugar`, '—'])}${cf(2, [`${Q.sudamericanaLeagueEnd}º lugar`, '—'])}${cf(3, [`${T.length - Q.relegationPlaces}º, último fora do Z${Q.relegationPlaces}`, Q.relegationPlaces === 4 ? 'média 43,2' : '—'])}</tbody></table></div><p class="mu xs footnote">Históricos de 2006 a 2025 (Olympics.com, Goal.com, Betway).</p></section>
      <section class="cd"><h2>Risco de queda por pontuação final</h2><div class="sc"><table><thead><tr><th>Pontos</th><th>Histórico (UFMG)</th><th>Simulações</th></tr></thead><tbody>${rel.join('')}</tbody></table></div><p class="mu xs footnote">Histórico: Departamento de Matemática da UFMG, via No Ataque (2025). “–” = poucas simulações com essa pontuação.</p></section></div>
      <section class="cd"><h2>Pontos dos campeões desde 2006</h2>${bars(
        CH.map((c) => c[2]),
        CH.map((c) => c[0]),
        { h: 70, max: 95, ref: MCR ? cut(0)[0] : null, col: () => 'var(--mu2)', fmt: (v) => v + ' pts', step: 2 },
      )}<p class="mu xs footnote">Linha tracejada: pontuação mediana do campeão nas simulações deste cenário.</p></section>`;
    }
    function renderSrc() {
      const S = [
        [
          'Classificação e rodada atualizadas · GE',
          'https://ge.globo.com/futebol/brasileirao-serie-a/',
          'Fonte consultada pelo campeonato-brasileiro-api. É uma extração do GE, não um feed oficial da CBF; disponibiliza a classificação e a rodada atual, não o histórico completo.',
        ],
        [
          'Classificação, 289 resultados e jogos (ESPN, atualizado em 08/10/2026 23:33)',
          'https://aquiesportes.com.br/futebol/tabela-do-brasileirao/',
          'Snapshot local: resultados das rodadas 1–29, calendário com datas e estádios da 30ª à 38ª, artilharia e critérios de desempate do regulamento.',
        ],
        [
          'CBF · jogos da 30ª rodada',
          'https://www.cbf.com.br/futebol-brasileiro/noticias/campeonato-brasileiro-serie-a/a/confira-o-retrospecto-dos-confrontos-da-30-rodada-do-brasileirao',
          'Conferência de datas e horários da 30ª rodada.',
        ],
        [
          'Wikipedia · Série A 2026',
          'https://en.wikipedia.org/wiki/2026_Campeonato_Brasileiro_S%C3%A9rie_A',
          'Formato: 5 primeiros na Libertadores (mais finalistas da Copa do Brasil), 6 seguintes na Sul-Americana, 4 rebaixados.',
        ],
        [
          'Olympics.com · pontos dos campeões',
          'https://www.olympics.com/pt/noticias/brasileirao-pontos-campeao-torneio',
          'Pontuação dos campeões 2006–2025 (gráfico da aba Corrida).',
        ],
        [
          'Goal.com · média dos campeões',
          'https://www.goal.com/br/listas/quantos-pontos-um-time-precisa-fazer-para-ser-campeao-do-campeonato-brasileiro/bltdf0c8d03837a3825',
          'Média de 77 pontos e mínimo de 67 pontos.',
        ],
        [
          'Olympics.com · 16º e 17º colocados',
          'https://www.olympics.com/pt/noticias/brasileirao-2024-pontos-escapar-rebaixamento',
          'Maior rebaixado (45 pontos) e menor pontuação de quem se salvou (39).',
        ],
        [
          'Betway · pontos para não cair',
          'https://blog.betway.com/pt/futebol/brasileirao/brasileirao-quantos-pontos-um-time-precisa-fazer-para-nao-cair-para-a-serie-b/',
          'Média do 16º colocado (43,2) e "nenhum clube com 46 pontos caiu".',
        ],
        [
          'No Ataque · risco por pontuação (UFMG)',
          'https://noataque.com.br/futebol/brasileirao-serie-a/time/atletico-mg/noticia/2025/09/22/de-quantos-pontos-o-atletico-precisa-para-escapar-do-rebaixamento-no-brasileiro/',
          'Probabilidade de queda por pontos finais, usada só como referência.',
        ],
        [
          'ogol · estatísticas de 2025',
          'https://www.ogol.com.br/edicao/brasileirao-serie-a-2025/194851/estatisticas',
          'Referência: 50% mandante, 26% empates, 24% visitante, 2,52 gols por jogo.',
        ],
        [
          'Escudos',
          'https://github.com/Lobobinho/Escudos-dos-Clubes-do-Brasileirao-2026',
          'Imagens dos escudos. As marcas pertencem aos respectivos clubes.',
        ],
      ];
      const k = SET.k;
      $('#v-src').innerHTML =
        `<div class="cd warn"><h2>Leia antes de usar</h2><p style="margin:0">Este é um simulador de cenários, <b>não uma previsão oficial</b>. Você pode digitar qualquer placar: o que você define é hipótese sua, e a página marca como "seu palpite". Jogos preenchidos automaticamente aparecem como "automático" e usam o método que você escolheu. O modelo não conhece lesões, suspensões, escalações, calendário de copas nem arbitragem.</p></div>
 <div class="g2"><div class="cd"><h2>Dados e fontes</h2><ul class="src">${S.map((x) => `<li><a href="${x[1]}" target="_blank" rel="noopener">${x[0]}</a><br><span class="mu sm">${x[2]}</span></li>`).join('')}</ul></div>
 <div class="cd"><h2>Como o modelo funciona</h2><p class="sm" style="margin-top:0">1. <b>Gols esperados:</b> para cada jogo, calcula-se quantos gols o mandante e o visitante devem marcar usando só a campanha de 2026 (${LG.n} jogos): ataque e defesa de cada time <i>em casa</i> e <i>fora</i>, relativos à média da liga (${f1(gH)} gols do mandante e ${f1(gA)} do visitante por jogo).</p><p class="sm">2. <b>Regressão à média:</b> cada time recebe ${k} jogos "fictícios" na média da liga para evitar exageros com poucos jogos.</p><p class="sm">3. <b>Placares:</b> distribuição de Poisson para cada lado, com a correção de Dixon-Coles (ρ = ${SET.rho.toFixed(2)}) para 0x0, 1x0, 0x1 e 1x1 (Dixon e Coles, 1997).</p><p class="sm">4. <b>Chances:</b> as ${M.filter((m) => !val(m.k)).length} partidas em branco são sorteadas ${SIMULATIONS_LABEL} vezes; os jogos que você definiu valem como resultado certo e os jogos ao vivo partem do placar atual. Tít., G${Q.libertadoresLeaguePositions}, Z${Q.relegationPlaces} e Proj. são as frequências dessas simulações.</p><p class="sm">5. <b>Desempate:</b> pontos, vitórias, saldo de gols e gols pró.</p><p class="sm" style="margin-bottom:0"><b>Dá para mudar tudo isso</b> em Ajustes do modelo (aba Simulador) e no ajuste de força de cada time. Na versão atual os dados do modelo são: mando ×${SET.ha.toFixed(2)}, k = ${k}, ρ = ${SET.rho.toFixed(2)}.</p></div></div>
 <div class="cd"><h2>Transparência dos dados</h2><div class="row"><button data-act="copy-csv">${ic('copy')}Copiar os ${LG.n} resultados (CSV)</button></div><div id="csvo"></div><p class="mu sm" style="margin:8px 0 0">Calendário e estádios da 35ª à 38ª rodada: horários podem mudar por decisão da CBF. O retrato de dados tem fonte e data de atualização informadas no cabeçalho.</p></div>`;
    }
    function updateSourceAndRules() {
      const sourceList = $('#v-src .src'),
        liveUrl = liveFeed?.source.url || 'https://ge.globo.com/futebol/brasileirao-serie-a/';
      sourceList?.insertAdjacentHTML(
        'afterbegin',
        `<li><a href="${escapeHtml(safeUrl(liveUrl) || 'https://ge.globo.com/futebol/brasileirao-serie-a/')}" target="_blank" rel="noopener">GE · classificação atual e rodada consultada</a><br><span class="mu sm">API anexada; consulta automática em segundo plano a cada 1–2 minutos. O pacote extrai a tabela e a rodada atual do GE, não é uma API oficial da CBF nem fornece o histórico completo.</span></li>`,
      );
      const snapshotItem = sourceList?.querySelectorAll('li')[1];
      if (snapshotItem) {
        const link = snapshotItem.querySelector('a'),
          description = snapshotItem.querySelector('.mu');
        link.textContent = `Snapshot local · ${rawResults.length} resultados`;
        link.href = dataSource.url;
        description.textContent = `${dataSource.method} Atualizado em ${updatedLabel}.`;
      }
      const modelIntro = $('#v-src .g2 .cd:nth-child(2) p');
      if (modelIntro && LIVE_STANDINGS)
        modelIntro.textContent = `1. Gols esperados: ataque e defesa totais por clube vêm da classificação ao vivo do GE (${LIVE_ROUND?.number || '–'}ª rodada). Como a fonte não informa separação casa/fora, o modelo aplica a proporção de gols mandante/visitante do snapshot histórico e o ajuste de mando configurável.`;
      $('#v-src')
        .querySelectorAll('p')
        .forEach((paragraph) => {
          if (paragraph.textContent.startsWith('4. Chances:'))
            paragraph.textContent = `4. Chances: ${M.filter((match) => !val(match.k)).length} jogos em branco são simulados ${SIMULATIONS_LABEL} vezes com a semente ${SET.seed}; placares definidos são tratados como certos e jogos ao vivo simulam só o tempo restante.`;
          if (paragraph.textContent.startsWith('5. Desempate:'))
            paragraph.textContent =
              '5. Desempate: pontos, vitórias, saldo de gols e gols pró; confronto direto se exatamente dois clubes seguem empatados. Dados disciplinares e sorteio não são modelados.';
        });
      const sourceHref = new URL(dataSource.url).href;
      $('#v-src').insertAdjacentHTML(
        'afterbegin',
        `<div class="cd warn"><h2>Critérios e limites do simulador</h2><p>Classificação: pontos, vitórias, saldo de gols e gols pró; o confronto direto é aplicado quando exatamente dois clubes continuam empatados nesses critérios. Não há dados de cartões nem sorteio; um empate residual conserva uma ordem estável, que não representa o critério oficial faltante.</p><p><b>Regulamento 2026:</b> não foi possível confirmar aqui um documento oficial específico da temporada com publicação e data verificáveis. Portanto, este site não declara as faixas continentais abaixo como classificação oficial nem informa uma data de regulamento que não foi comprovada.</p><p><b>Cenário de posições usado pelo modelo:</b> top ${Q.libertadoresLeaguePositions} para a faixa Libertadores e ${Q.sudamericanaLeagueStart}º–${Q.sudamericanaLeagueEnd}º para a faixa Sul-Americana; são cortes simplificados da liga, não vagas garantidas. Vagas definidas por Copa do Brasil ou outros campeonatos podem alterar as posições; o simulador não determina os classificados por esses torneios. O Z${Q.relegationPlaces} representa as ${Q.relegationPlaces} últimas posições do cenário.</p><p>A tabela e os totais por clube são consultados automaticamente no GE a cada 1–2 minutos, sem recarregar a página. O pacote fornece somente classificação e rodada atual; resultados passados que o servidor não observou precisam ser reconciliados com uma fonte conferida. GE é uma fonte jornalística, não oficial da CBF.</p><p>Resultados adicionais verificados: ${VERIFIED_BACKFILL_COUNT}. Para recuperar jogos ausentes, confirme cada placar em uma fonte confiável e use um CSV com cabeçalho <code>round,home,away,homeGoals,awayGoals</code> e siglas dos clubes do snapshot. Importe com <code>node scripts/import-verified-results.mjs resultados.csv https://fonte-conferida.example "Nome da fonte"</code>. O comando valida rodada, confronto, placar, duplicatas e divergências; não autentica a fonte nem inventa resultados. Revise e publique <code>data/historical-backfill-2026.json</code> junto ao site. Consulte o estado de cobertura abaixo.</p><p>Snapshot detalhado: <a href="${sourceHref}" target="_blank" rel="noopener">${escapeHtml(dataSource.name)}</a>. Para conferir a integridade dos arquivos, rode <code>npm run validate:data</code>.</p></div>`,
      );
      const coverageDetails =
        HISTORY_COVERAGE.status === 'unavailable'
          ? 'A classificação ao vivo está indisponível; a cobertura não pode ser comparada.'
          : HISTORY_COVERAGE.status === 'consistent'
            ? `Os ${HISTORY_COVERAGE.knownMatches} placares disponíveis correspondem aos totais atuais publicados na tabela do GE. Isso é uma verificação de totais, não uma certificação oficial jogo a jogo.`
            : `Foram encontrados ${HISTORY_COVERAGE.knownMatches} placares para ${HISTORY_COVERAGE.expectedMatches} partidas contabilizadas na tabela do GE. Diferença estimada: ${HISTORY_COVERAGE.missingMatches} jogo(s); divergências por clube: ${
                HISTORY_COVERAGE.clubs
                  .slice(0, 6)
                  .map(
                    (club) =>
                      `${escapeHtml(club.name)} (${club.missingMatches > 0 ? `${club.missingMatches} jogo(s) sem placar` : 'totais diferentes'})`,
                  )
                  .join(', ') || 'nenhuma identificada por clube'
              }.`;
      const backfillSources = [
        ...new Map(
          backfill.results.map((result) => [`${result.source.name}:${result.source.url}`, result.source]),
        ).values(),
      ];
      $('#v-src').insertAdjacentHTML(
        'afterbegin',
        `<div class="cd"><h2>Conferência e reconciliação do histórico</h2><p>${coverageDetails}</p><p class="mu sm">A comparação detecta diferença entre os resultados locais e os totais por clube publicados pelo GE. Ela não recupera sozinha placares passados nem transforma o GE em fonte oficial.</p><p>Correções verificadas incorporadas: <b>${VERIFIED_BACKFILL_COUNT}</b>. ${backfillSources.length ? `Fontes registradas: ${backfillSources.map((source) => `<a href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a> (conferido em ${escapeHtml(formatLiveTime(source.verifiedAt))})`).join('; ')}.` : 'Nenhuma correção manual foi importada.'}</p><p class="sm">Procedimento: confira os jogos ausentes em uma fonte confiável; prepare um CSV com <code>round,home,away,homeGoals,awayGoals</code> (use siglas como FLA e PAL); execute <code>npm run import:results -- resultados.csv https://sua-fonte-verificada.example "Nome da fonte"</code>; revise o arquivo <code>data/historical-backfill-2026.json</code>, rode <code>npm test</code> e publique o arquivo junto com a página. O importador rejeita placares que contradizem resultados existentes e exige correspondência exata com o calendário.</p><details><summary>Relatório de procedência dos ${rawResults.length} resultados carregados</summary><div class="sc" role="region" aria-label="Relatório de procedência dos resultados por partida" tabindex="0"><table><thead><tr><th>Rodada</th><th class="l">Partida</th><th>Placar</th><th>Registro</th><th class="l">Fonte e data</th></tr></thead><tbody>${rawResults
          .slice()
          .sort((a, b) => a.round - b.round || a.home.localeCompare(b.home))
          .map((result) => {
            const source = result.source || dataSource,
              type = source.type || 'snapshot',
              label =
                type === 'verified-backfill'
                  ? 'Correção conferida'
                  : type === 'feed-observed'
                    ? 'Observado no feed GE'
                    : 'Snapshot local · sem confirmação individual',
              sourceDate = type === 'feed-observed' ? source.observedAt : source.verifiedAt,
              when = sourceDate ? ` · ${escapeHtml(formatLiveTime(sourceDate))}` : '';
            return `<tr><td>${result.round}</td><td class="l">${escapeHtml(NM[result.home])} x ${escapeHtml(NM[result.away])}</td><td>${result.homeGoals}–${result.awayGoals}</td><td>${label}</td><td class="l">${safeUrl(source.url) ? `<a href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a>` : escapeHtml(source.name)}${when}</td>`;
          })
          .join(
            '',
          )}</tbody></table></div><p class="mu sm">“Correção conferida” registra a procedência declarada durante a importação; o simulador não autentica a fonte externa. Resultados do snapshot não têm prova de conferência individual. Resultados observados no GE não são confirmação oficial da CBF.</p></details></div>`,
      );
    }
    async function csv() {
      const t =
        'rodada,mandante,gols_mandante,gols_visitante,visitante\n' +
        RES.map((m) => `${m.r + 1},${NM[m.h]},${m.x},${m.y},${NM[m.a]}`).join('\n');
      try {
        await navigator.clipboard.writeText(t);
        $('#csvo').textContent = 'CSV copiado.';
      } catch (error) {
        const field = document.createElement('textarea');
        field.value = t;
        field.setAttribute('aria-label', 'Resultados em CSV para copiar');
        $('#csvo').replaceChildren(field);
        notify(`N\u00e3o foi poss\u00edvel copiar automaticamente: ${error.message}`);
      }
    }
    /* ---- compartilhar ---- */
    let modalReturnFocus = null;
    const code = () => `B28:${encodeScenarioPayload(payloadFromState())}`;
    async function shareM() {
      const value = code(),
        longLink = new URL('/', location.origin);
      longLink.searchParams.set('scenario', value.slice(4));
      modalReturnFocus = document.activeElement;
      const defined = M.filter((m) => val(m.k)).length;
      $('#mb').innerHTML =
        `<div class="card-head"><h2 id="share-title">Compartilhar cenário</h2><button class="ic" data-act="close-modal" aria-label="Fechar">${ic('x')}</button></div>
      <p class="mu sm">Quem abrir o link vê os seus ${defined} ${defined === 1 ? 'placar' : 'placares'} e a mesma tabela. A prévia do link mostra o campeão e a classificação do seu cenário.</p>
      <label for="shareLink">Link</label><div class="row"><input id="shareLink" readonly value="${escapeHtml(longLink.href)}" style="flex:1;min-width:0"><button class="p" data-act="copy-link">${ic('copy')}Copiar</button>${navigator.share ? `<button data-act="native-share">${ic('share')}Enviar</button>` : ''}</div>
      <p class="mu xs" id="shareLinkStatus">${PUBLIC_CONFIG.shortLinks ? 'Gerando link curto…' : ''}</p>
      <img id="sharePreview" class="share-preview" alt="Prévia da imagem que aparece ao compartilhar" width="1200" height="630" style="width:100%;height:auto;border-radius:12px;border:1px solid var(--ln)" hidden>
      <details style="margin-top:12px"><summary class="sm">Mais opções</summary><div class="row" style="margin:10px 0"><button data-act="copy-code">${ic('copy')}Copiar código</button><button data-act="backup-export">${ic('down')}Baixar backup</button><button data-act="copy-table">${ic('list')}Tabela em texto</button><button data-act="make-image">${ic('img')}Imagem da tabela</button></div>
      <label for="cd">Código do cenário</label><textarea id="cd" readonly>${value}</textarea>
      <label for="imp">Importar código</label><textarea id="imp" placeholder="Cole aqui um código B28:..."></textarea><div class="row" style="margin-top:8px"><button data-act="import-scenario">${ic('down')}Importar código</button><label for="backupFile" class="btn">Restaurar backup<input id="backupFile" type="file" accept="application/json,.json" data-change="backup-file" hidden></label></div></details>
      <div id="out" role="status" aria-live="polite"></div>`;
      $('#mod').setAttribute('aria-labelledby', 'share-title');
      $('#mod').hidden = false;
      $('#mb [data-act="copy-link"]')?.focus();
      const preview = $('#sharePreview');
      preview.addEventListener('load', () => (preview.hidden = false));
      preview.addEventListener('error', () => (preview.hidden = true));
      if (!PUBLIC_CONFIG.shortLinks) {
        if (longLink.href.length < 6000) preview.src = `/api/og/scenario.png?s=${value.slice(4)}`;
        return;
      }
      try {
        const response = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: payloadFromState() }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        const input = $('#shareLink');
        if (!input) return;
        input.value = body.url.startsWith('http') ? body.url : new URL(body.url, location.origin).href;
        $('#shareLinkStatus').textContent = 'Link curto pronto.';
        preview.src = `/api/og/c/${body.id}.png`;
      } catch (error) {
        const status = $('#shareLinkStatus');
        if (status) status.textContent = `Usando o link completo (${error.message}).`;
        preview.src = `/api/og/scenario.png?s=${value.slice(4)}`;
      }
    }
    async function copyText(value, message) {
      try {
        await navigator.clipboard.writeText(value);
        notify(message);
      } catch (error) {
        const output = $('#out');
        if (output) {
          const field = document.createElement('textarea');
          field.value = value;
          field.setAttribute('aria-label', 'Texto para copiar manualmente');
          output.replaceChildren(field);
          field.select();
        }
        notify(`N\u00e3o foi poss\u00edvel copiar automaticamente: ${error.message}`);
      }
    }
    async function cp() {
      await copyText(code(), 'C\u00f3digo copiado.');
    }
    function validatedPayload(payload) {
      const pruned = pruneCompletedScenarioScores(
          payload?.scores,
          ALL_FIXTURES,
          LIVE_ROUND?.number,
          M.map((m) => m.k),
        ),
        normalizedPayload = { ...payload, scores: pruned.scores },
        check = validateScenarioPayload(
          normalizedPayload,
          M.map((m) => m.k),
          T,
        );
      if (check.errors.length) throw new Error(check.errors.join(' '));
      if (pruned.removed)
        notify(`${pruned.removed} palpite(s) de partidas já concluídas foram removidos; os demais foram importados.`);
      return normalizedPayload;
    }
    function payloadFromCode(value) {
      if (value.length > 30000) throw new Error('O c\u00f3digo ultrapassa o tamanho permitido.');
      if (value.startsWith('B28:')) return validatedPayload(decodeScenarioPayload(value.slice(4)));
      if (!value.startsWith('B27:')) throw new Error('Formato de c\u00f3digo inv\u00e1lido.');
      const entries = value.slice(4).split('.');
      if (entries.length !== LEGACY_MATCHES.length) throw new Error('O c\u00f3digo pertence a outro calend\u00e1rio.');
      const scores = {};
      entries.forEach((entry, index) => {
        if (!entry) return;
        const match = /^(0|[1-9]|1[0-9]|20)-(0|[1-9]|1[0-9]|20)(a)?$/.exec(entry);
        if (!match) throw new Error(`Placar inv\u00e1lido na partida ${index + 1}.`);
        scores[LEGACY_MATCHES[index].id] = [match[1], match[2], match[3] ? 'a' : 'u'];
      });
      return validatedPayload({
        version: 1,
        scores,
        settings: { k: 6, ha: 1, rho: -0.1, seed: 20261010, adjustments: {} },
        options: { full: true, odds: true, method: 'ml' },
      });
    }
    function applyPayload(payload) {
      SC = payload.scores;
      SET = {
        k: payload.settings.k,
        ha: payload.settings.ha,
        rho: payload.settings.rho,
        seed: payload.settings.seed,
        adj: payload.settings.adjustments,
      };
      opt = { full: payload.options.full, odds: payload.options.odds, meth: payload.options.method };
      Object.keys(SC).forEach(recordPredictionSnapshot);
      save();
      renderAll();
      closeModal();
    }
    function importCode() {
      try {
        applyPayload(payloadFromCode($('#imp').value.trim()));
        notify('Cen\u00e1rio importado.');
      } catch (error) {
        $('#out').textContent = error.message;
        $('#out').setAttribute('role', 'alert');
      }
    }
    async function importBackup(file) {
      try {
        if (file.size > 100000) throw new Error('O arquivo de backup \u00e9 grande demais.');
        const backup = JSON.parse(await file.text());
        if (backup.format !== 'brasileirao-simulator-backup' || backup.version !== 1)
          throw new Error('Formato de backup inv\u00e1lido.');
        applyPayload(validatedPayload(backup));
        notify('Backup restaurado.');
      } catch (error) {
        $('#out').textContent = error.message;
        $('#out').setAttribute('role', 'alert');
      }
    }
    function exportBackup() {
      const blob = new Blob([JSON.stringify(makeBackup(payloadFromState()), null, 2)], { type: 'application/json' }),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'simulabr-brasileirao-2026-cenario.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function txt() {
      const s = project(),
        o = rankTeams(s),
        text =
          'SimulaBR · Brasileirão 2026 · classificação de um cenário personalizado (não é previsão oficial)\n' +
          o.map((c, i) => `${i + 1}. ${NM[c]} - ${s[c].P} pts, SG ${s[c].GP - s[c].GC}`).join('\n');
      await copyText(text, 'Tabela copiada.');
    }
    const li = (c) =>
      new Promise((r) => {
        const i = new Image();
        i.onload = () => r(i);
        i.onerror = () => r(null);
        i.src = LOGO[c];
      });
    async function mkimg() {
      const s = project(),
        o = rankTeams(s),
        done = M.filter((m) => val(m.k)).length,
        W = 860,
        rh = 40,
        H = 130 + o.length * rh + 36,
        cv = document.createElement('canvas');
      cv.width = W * 2;
      cv.height = H * 2;
      const x = cv.getContext('2d');
      x.scale(2, 2);
      const ims = {};
      await Promise.all(o.map(async (c) => (ims[c] = await li(c))));
      x.fillStyle = '#0A0F0D';
      x.fillRect(0, 0, W, H);
      x.fillStyle = '#EAF1ED';
      x.font = '700 24px system-ui,sans-serif';
      x.fillText('SimulaBR · Brasileirão 2026 · cenário personalizado', 28, 48);
      x.fillStyle = '#8CA297';
      x.font = '13px system-ui,sans-serif';
      x.fillText(
        done + ' de ' + M.length + ' jogos definidos por simulação do usuário · não é previsão oficial',
        28,
        70,
      );
      const cx = [430, 480, 530, 590, 650, 720, 790];
      x.font = '600 11px system-ui,sans-serif';
      x.textAlign = 'center';
      ['P', 'J', 'V', 'E', 'D', 'SG', 'GP'].forEach((t, i) => x.fillText(t, cx[i], 110));
      x.textAlign = 'left';
      o.forEach((c, i) => {
        const y = 122 + i * rh,
          t = s[c],
          z =
            i < Q.libertadoresLeaguePositions
              ? '#38C98B'
              : i < Q.sudamericanaLeagueEnd
                ? '#5B9BE6'
                : i >= T.length - Q.relegationPlaces
                  ? '#EC6A57'
                  : '#22332B';
        x.fillStyle = i % 2 ? '#0E1511' : '#111A16';
        x.fillRect(20, y, W - 40, rh);
        x.fillStyle = z;
        x.fillRect(20, y, 4, rh);
        x.fillStyle = '#EAF1ED';
        x.font = '700 15px system-ui,sans-serif';
        x.fillText(i + 1, 40, y + 25);
        if (ims[c]) x.drawImage(ims[c], 76, y + 6, 28, 28);
        x.font = '600 15px system-ui,sans-serif';
        x.fillText(NM[c], 116, y + 25);
        x.textAlign = 'center';
        const sg = t.GP - t.GC;
        [t.P, t.J, t.V, t.E, t.D, sg > 0 ? '+' + sg : sg, t.GP].forEach((v, j) => {
          x.font = (j == 0 ? '800 ' : '500 ') + '15px system-ui,sans-serif';
          x.fillStyle = j == 0 ? '#D9B65C' : '#EAF1ED';
          x.fillText(v, cx[j], y + 25);
        });
        x.textAlign = 'left';
      });
      x.fillStyle = '#8CA297';
      x.font = '11px system-ui,sans-serif';
      x.fillText(
        `Verde: G${Q.libertadoresLeaguePositions} · Azul: Sul-Americana · Vermelho: Z${Q.relegationPlaces} · Base: ${liveFeed ? `classificação GE após a ${LIVE_ROUND?.number || '–'}ª rodada` : 'snapshot local'}`,
        28,
        H - 14,
      );
      $('#out').innerHTML =
        `<img src="${cv.toDataURL('image/png')}" alt="Tabela simulada"><p class="mu sm">Clique com o botão direito (ou segure no celular) para salvar.</p>`;
    }
    function closeModal() {
      const modal = $('#mod');
      if (modal.hidden) return;
      modal.hidden = true;
      $('#mb').replaceChildren();
      modalReturnFocus?.focus();
    }
    const TOUR_STEPS = [
      {
        view: 'home',
        title: 'Acompanhe a rodada',
        text: 'Na página inicial, veja a próxima partida, jogos ao vivo e a classificação consultada. O horário e a fonte ajudam a entender quando os dados foram atualizados.',
      },
      {
        view: 'sim',
        title: 'Monte seu cenário',
        text: 'Escolha uma rodada, digite placares ou use as opções rápidas. “Preencher faltantes” preserva seus palpites e completa somente os jogos sem placar.',
      },
      {
        view: 'est',
        title: 'Explore os números',
        text: 'Filtre resultados por clube e rodada. A contagem da amostra mostra quantas partidas sustentam cada indicador; probabilidades continuam sendo estimativas do modelo.',
      },
      {
        view: 'account',
        title: 'Use uma conta se quiser',
        text: 'O conteúdo público continua aberto. Uma conta opcional permite sincronizar palpites, favoritos e lembretes entre sessões.',
      },
    ];
    function renderTour() {
      const step = TOUR_STEPS[tourStep];
      show(step.view);
      $('#mb').innerHTML =
        `<span class="hero-kicker">VISITA GUIADA · ${tourStep + 1} DE ${TOUR_STEPS.length}</span><h2>${step.title}</h2><p>${step.text}</p><div class="row" style="justify-content:flex-end"><button data-act="tour-close">Pular visita</button><button class="p" data-act="tour-next">${tourStep === TOUR_STEPS.length - 1 ? 'Concluir' : 'Próximo'}</button></div>`;
      $('#mod').hidden = false;
      $('#mb button[data-act="tour-next"]').focus();
    }
    function startTour() {
      modalReturnFocus = document.activeElement;
      tourStep = 0;
      renderTour();
    }
    function advanceTour() {
      if (tourStep >= TOUR_STEPS.length - 1) {
        closeModal();
        return;
      }
      tourStep++;
      renderTour();
    }
    function updateSeed(value) {
      CUPS.sims = {};
      const seed = Number(value);
      if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        notify('A semente precisa ser um inteiro entre 0 e 4.294.967.295.');
        return;
      }
      setS('seed', seed);
      setSE();
    }
    // Atualiza os dados sem recarregar a página: recalcula o estado, mantém o
    // cenário do usuário, a rolagem e o foco, e redesenha só a aba aberta.
    let lastLiveRefresh = Date.now(),
      liveRefreshTimer;
    function rerenderCurrentView() {
      const scrollPosition = scrollY,
        active = document.activeElement,
        activeId = active?.id,
        match = active?.dataset?.match,
        side = active?.dataset?.side;
      if (view === 'sim') {
        renderTab();
        renderSide();
      } else if (['home', 'live', 'est', 'cor', 'clubs', 'perf'].includes(view)) renderView(view);
      nav();
      if (match && side !== undefined) {
        const input = $(`#side [data-input="score"][data-match="${match}"][data-side="${side}"]`);
        input?.focus({ preventScroll: true });
      } else if (activeId && document.getElementById(activeId) !== active)
        document.getElementById(activeId)?.focus({ preventScroll: true });
      scrollTo(0, scrollPosition);
    }
    function announceScoreChanges(previous) {
      const before = new Map(previous.map((match) => [match.fixtureId, match])),
        messages = [];
      for (const match of LIVE_MATCHES) {
        const old = before.get(match.fixtureId);
        if (!old) messages.push(`Começou: ${NM[match.home]} x ${NM[match.away]}`);
        else if (old.homeGoals !== match.homeGoals || old.awayGoals !== match.awayGoals)
          messages.push(`Gol! ${NM[match.home]} ${match.homeGoals} x ${match.awayGoals} ${NM[match.away]}`);
      }
      for (const old of previous)
        if (!LIVE_BY_ID.has(old.fixtureId)) {
          const result = rawResults.find(
            (item) => item.home === old.home && item.away === old.away && item.round === old.round,
          );
          if (result)
            messages.push(
              `Fim de jogo: ${NM[result.home]} ${result.homeGoals} x ${result.awayGoals} ${NM[result.away]}`,
            );
        }
      if (messages.length) notify(messages.join(' · '));
      return messages.length > 0;
    }
    function applyLiveUpdate(nextSeason) {
      const previousLive = LIVE_MATCHES,
        resultsBefore = rawResults.length;
      applySeasonState(nextSeason);
      resetModel();
      // Resultado novo: o servidor grava uma nova foto das chances.
      if (rawResults.length !== resultsBefore) setTimeout(loadProbabilityHistory, 5_000);
      const captured = archiveCompletedPredictions(
        predictionHistory,
        SC,
        ALL_FIXTURES,
        rawResults,
        new Date().toISOString(),
        dataSource,
      );
      if (captured.added || captured.updated) {
        predictionHistory = captured.history;
        savePredictionHistory();
      }
      const pruned = pruneCompletedScenarioScores(
        SC,
        ALL_FIXTURES,
        LIVE_ROUND?.number,
        M.map((m) => m.k),
      );
      if (pruned.removed) {
        SC = pruned.scores;
        save();
      }
      const announced = announceScoreChanges(previousLive);
      updateSourceStatus();
      rerenderCurrentView();
      sched();
      return announced;
    }
    async function refreshLive(force = false) {
      const button = $('#refreshLive');
      if (button && force) button.disabled = true;
      lastLiveRefresh = Date.now();
      try {
        const response = await fetch(`/api/live-season${force ? '?refresh=1' : ''}`, { cache: 'no-store' }),
          payload = await response.json();
        if (!response.ok) throw new Error(payload.details || payload.error || `HTTP ${response.status}`);
        const checkedSeason = mergeLiveSeason(reconciledSnapshot, payload),
          checked = validateSeasonData(checkedSeason.seasonData, logoData);
        if (checked.errors.length) throw new Error(checked.errors.join(' '));
        if (!payload.stale) {
          try {
            localStorage.setItem(LIVE_FEED_CACHE_KEY, JSON.stringify(payload));
          } catch (error) {
            liveFeedCacheWarning = `Não foi possível guardar a última consulta válida neste navegador: ${error.message || String(error)}`;
            console.error(liveFeedCacheWarning, error);
            notify(`Feed atualizado, mas não foi possível guardar uma cópia local: ${error.message || String(error)}`);
          }
        }
        liveFeed = payload;
        liveFeedError = '';
        // Mesmo sem mudança de placar o minuto estimado avança, então o estado é sempre recalculado.
        const announced = applyLiveUpdate(checkedSeason);
        checkInSiteReminders();
        if (force && !announced) notify('A consulta ao GE foi atualizada.');
      } catch (error) {
        liveFeedError = error.message || String(error);
        if (liveFeed)
          liveFeed = { ...liveFeed, stale: true, warning: 'Não foi possível confirmar uma atualização recente.' };
        updateSourceStatus();
        if (view === 'live') renderLiveHub();
        if (force) notify(`Atualização indisponível: ${liveFeedError}`);
      } finally {
        if (button) button.disabled = false;
        scheduleLiveRefresh();
      }
    }
    // A cada minuto com jogo em andamento; a cada 2 minutos fora disso. Com a aba
    // escondida a consulta espera até a página voltar a ficar visível.
    function scheduleLiveRefresh() {
      clearTimeout(liveRefreshTimer);
      const delay = LIVE_MATCHES.length ? 60_000 : 120_000;
      liveRefreshTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') refreshLive(false);
        else scheduleLiveRefresh();
      }, delay);
    }
    function checkInSiteReminders() {
      if (
        !signedInUser ||
        !accountPreferences.inSiteReminders ||
        !favoriteTeams.length ||
        document.visibilityState !== 'visible'
      )
        return;
      const now = Date.now(),
        due = [];
      for (const fixture of ALL_FIXTURES) {
        if (
          fixture.status === 'played' ||
          !fixture.kickoff ||
          (!favoriteTeams.includes(fixture.home) && !favoriteTeams.includes(fixture.away))
        )
          continue;
        const kickoff = Date.parse(fixture.kickoff),
          minutes = (kickoff - now) / 60_000;
        if (!Number.isFinite(kickoff) || minutes <= 0 || minutes > accountPreferences.reminderMinutes) continue;
        const key = `br26-reminded:${signedInUser.id}:${fixture.id}`;
        if (remindedFixtures.has(key)) continue;
        try {
          if (localStorage.getItem(key)) continue;
          localStorage.setItem(key, new Date().toISOString());
        } catch (error) {
          if (!reminderStorageWarningShown) {
            reminderStorageWarningShown = true;
            notify(`Não foi possível persistir o estado dos lembretes neste navegador: ${error.message}`);
          }
        }
        remindedFixtures.add(key);
        due.push(`${NM[fixture.home]} x ${NM[fixture.away]} (${formatLiveTime(fixture.kickoff)})`);
      }
      if (due.length)
        notify(
          `Próximo${due.length === 1 ? '' : 's'} jogo${due.length === 1 ? '' : 's'} de clube favorito: ${due.join('; ')}`,
        );
    }
    function historyCoverageMessage() {
      if (HISTORY_COVERAGE.status === 'unavailable')
        return 'Não foi possível comparar o histórico com uma classificação ao vivo.';
      const gap = HISTORY_COVERAGE.missingMatches,
        affected = HISTORY_COVERAGE.clubs
          .slice(0, 3)
          .map(
            (club) =>
              `${club.name} (${club.missingMatches > 0 ? `+${club.missingMatches} jogo(s) sem placar conhecido` : 'totais divergentes'})`,
          )
          .join(', ');
      if (HISTORY_COVERAGE.status === 'consistent')
        return `Os ${HISTORY_COVERAGE.knownMatches} placares locais conferem com os totais atuais da tabela GE; isso não certifica cada partida como fonte oficial.`;
      return `Histórico ${HISTORY_COVERAGE.status === 'incomplete' ? 'incompleto' : 'divergente'}: tabela GE indica ${HISTORY_COVERAGE.expectedMatches} partidas contabilizadas e há ${HISTORY_COVERAGE.knownMatches} placares locais${gap ? `; diferença estimada: ${gap} jogo(s)` : ''}${affected ? `. Verificar: ${affected}` : ''}. Confira e importe resultados verificados pela aba Fontes e método.`;
    }
    // Pílula de status no cabeçalho; o detalhe completo fica em Fontes e método.
    function updateSourceStatus() {
      const pill = $('#statusPill');
      if (!pill) return;
      pill.classList.remove('ok', 'live', 'stale');
      let text, detail;
      if (liveFeed) {
        const time = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(
          new Date(liveFeed.fetchedAt),
        );
        if (liveFeed.stale) {
          pill.classList.add('stale');
          text = `Desatualizado · ${time}`;
        } else if (LIVE_MATCHES.length) {
          pill.classList.add('live');
          text = `Ao vivo · ${time}`;
        } else {
          pill.classList.add('ok');
          text = `Atualizado ${time}`;
        }
        detail = `Fonte: ${liveFeed.source.name}, última consulta ${formatLiveTime(liveFeed.fetchedAt)}.`;
      } else {
        text = 'Fonte indisponível';
        detail = `Mostrando os dados locais de ${updatedLabel}.`;
      }
      pill.querySelector('span').textContent = text;
      pill.title = `${detail} Clique para ver fontes e método.`;
      pill.setAttribute('aria-label', `${text}. ${detail} Abrir fontes e método.`);
    }
    function sourceStatusCard() {
      const lines = [
        liveFeed
          ? `Classificação e rodada: ${escapeHtml(liveFeed.source.name)}, consultada em ${formatLiveTime(liveFeed.fetchedAt)} (rodada ${liveFeed.round.number})${liveFeed.stale ? ` · ${escapeHtml(liveFeed.warning || 'desatualizada')}` : ''}.`
          : `Fonte ao vivo indisponível (${escapeHtml(liveFeedError || 'sem resposta')}); usando o snapshot de ${updatedLabel}.`,
        escapeHtml(historyCoverageMessage()),
        liveFeed?.historyWarning ? escapeHtml(liveFeed.historyWarning) : '',
        liveFeedCacheWarning ? escapeHtml(liveFeedCacheWarning) : '',
        ...validationWarnings.map((warning) => escapeHtml(warning)),
      ].filter(Boolean);
      return `<section class="cd"><h2>Situação dos dados agora</h2>${lines.map((line) => `<p class="sm">${line}</p>`).join('')}</section>`;
    }
    function runAction(button) {
      const { act } = button.dataset;
      switch (act) {
        case 'toggle-theme': {
          const order = ['auto', 'light', 'dark'];
          const current = document.documentElement.dataset.theme || 'auto';
          const next = order[(order.indexOf(current) + 1) % order.length];
          if (next === 'auto') delete document.documentElement.dataset.theme;
          else document.documentElement.dataset.theme = next;
          try {
            if (next === 'auto') localStorage.removeItem('br26-theme');
            else localStorage.setItem('br26-theme', next);
          } catch {
            // vale só nesta visita
          }
          updateThemeButton();
          notify(`Tema: ${{ auto: 'automático (segue o sistema)', light: 'claro', dark: 'escuro' }[next]}.`);
          break;
        }
        case 'open-compare':
          openCompare();
          break;
        case 'run-compare':
          runCompare();
          break;
        case 'cup-select':
          if (!COMPETITION_IDS.includes(button.dataset.cup)) throw new Error('Competição inválida.');
          CUPS.active = button.dataset.cup;
          renderCups();
          updateUrl();
          ensureCups([CUPS.active]).then(() => view === 'copas' && renderCups());
          break;
        case 'cup-adjust': {
          const id = button.dataset.team;
          if (!/^\d{1,8}$/.test(id)) throw new Error('Clube inválido.');
          const next = Math.max(-400, Math.min(400, (CUPS.adjustments[id] || 0) + Number(button.dataset.delta)));
          if (next) CUPS.adjustments[id] = next;
          else delete CUPS.adjustments[id];
          try {
            localStorage.setItem(CUP_ADJUST_KEY, JSON.stringify(CUPS.adjustments));
          } catch {
            // o ajuste continua valendo nesta visita
          }
          CUPS.sims = {};
          renderCups();
          break;
        }
        case 'cup-reset':
          CUPS.adjustments = {};
          try {
            localStorage.removeItem(CUP_ADJUST_KEY);
          } catch {
            // sem armazenamento local
          }
          CUPS.sims = {};
          renderCups();
          break;
        case 'sub-view':
          if (!(button.dataset.group in subView)) throw new Error('Visão inválida.');
          subView[button.dataset.group] = button.dataset.value;
          renderView(view);
          nav();
          updateUrl();
          break;
        case 'trend-club': {
          const code = button.dataset.team;
          if (!T.includes(code)) throw new Error('Clube inválido.');
          trendClubs = trendClubs.includes(code)
            ? trendClubs.filter((item) => item !== code)
            : [...trendClubs, code].slice(-SERIES_COLORS.length);
          renderChances();
          break;
        }
        case 'share':
          shareM();
          break;
        case 'toggle-full':
          opt.full = !opt.full;
          save();
          renderAll();
          break;
        case 'toggle-odds':
          opt.odds = !opt.odds;
          save();
          renderAll();
          break;
        case 'toggle-advanced':
          advOpen = !advOpen;
          renderAviso();
          break;
        case 'start-tour':
          startTour();
          break;
        case 'tour-next':
          advanceTour();
          break;
        case 'tour-close':
          closeModal();
          break;
        case 'reset-model':
          SET = { ...DEFAULT_SETTINGS, adj: {} };
          resetModel();
          save();
          renderAll();
          break;
        case 'quick-score':
          qk(button.dataset.match, Number(button.dataset.result));
          break;
        case 'auto-match':
          auto(button.dataset.match);
          break;
        case 'clear-match':
          clr(button.dataset.match);
          break;
        case 'toggle-match-info':
          open[button.dataset.match] = !open[button.dataset.match];
          renderSide();
          break;
        case 'fill-scope':
          fill(button.dataset.scope === 'all' ? null : button.dataset.scope);
          break;
        case 'fill-missing-scope':
          fillMissing(button.dataset.scope === 'all' ? null : button.dataset.scope);
          break;
        case 'clear-scope':
          clr(
            button.dataset.scope === 'all' ? null : button.dataset.scope,
            button.dataset.automatic === 'true' ? 'a' : undefined,
          );
          break;
        case 'show-rounds':
          setTeam('');
          break;
        case 'all-team':
          allT(button.dataset.result);
          break;
        case 'round-step':
          go(Number(button.dataset.step));
          break;
        case 'select-round':
          tab = Number(button.dataset.round);
          renderSide();
          break;
        case 'select-team':
          setTeam(button.dataset.team);
          break;
        case 'team-and-sim':
          setTeam(button.dataset.team);
          show('sim');
          break;
        case 'open-club':
          statsTeam = button.dataset.team;
          show('clubs');
          break;
        case 'open-round':
          team = '';
          tab = Number(button.dataset.round);
          show('sim');
          break;
        case 'show-view':
          show(button.dataset.view);
          break;
        case 'show-help-section': {
          const section = button.dataset.section;
          if (!['help-start', 'help-data', 'help-privacy', 'terms-of-use'].includes(section))
            throw new Error('Seção de ajuda inválida.');
          show('guide');
          requestAnimationFrame(() => {
            const target = document.getElementById(section);
            if (!target) return;
            if (target instanceof HTMLDetailsElement) target.open = true;
            target.scrollIntoView({
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
              block: 'start',
            });
            (target.querySelector('summary') || target).focus({ preventScroll: true });
          });
          break;
        }
        case 'open-account':
          openAccountDialog(button.dataset.mode === 'register' ? 'register' : 'login');
          break;
        case 'sign-out':
          supabaseClient.auth
            .signOut()
            .then(({ error }) => {
              if (error) throw error;
              notify('Você saiu da conta.');
            })
            .catch((error) => notify(`Não foi possível sair da conta: ${error.message}`));
          break;
        case 'refresh-feed':
          refreshLive(true);
          break;
        case 'favorite-team':
          toggleFavorite(button.dataset.team).catch((error) => notify(error.message));
          break;
        case 'save-current-scenario':
          saveNamedScenario($('#scenarioName')?.value).catch((error) => notify(error.message));
          break;
        case 'load-saved-scenario': {
          const saved = savedScenarios.find((item) => item.id === button.dataset.id);
          if (!saved) throw new Error('Cenário salvo não encontrado.');
          applyPayload(saved.scenario);
          show('sim');
          break;
        }
        case 'duplicate-saved-scenario': {
          const saved = savedScenarios.find((item) => item.id === button.dataset.id);
          if (!saved) throw new Error('Cenário salvo não encontrado.');
          applyPayload(saved.scenario);
          show('account');
          saveNamedScenario(`${saved.name} (cópia)`.slice(0, 60)).catch((error) => notify(error.message));
          break;
        }
        case 'delete-saved-scenario':
          removeSavedScenario(button.dataset.id).catch((error) => notify(error.message));
          break;
        case 'sort-stats':
          sortT(button.dataset.key);
          break;
        case 'copy-csv':
          csv();
          break;
        case 'close-modal':
          closeModal();
          break;
        case 'copy-code':
          cp();
          break;
        case 'push-enable':
          button.disabled = true;
          enablePush()
            .then(() => notify('Notificações ativadas.'))
            .catch((error) => notify(error.message))
            .finally(refreshPushCard);
          break;
        case 'push-disable':
          disablePush()
            .then(() => notify('Notificações desativadas neste aparelho.'))
            .catch((error) => notify(error.message))
            .finally(refreshPushCard);
          break;
        case 'native-share':
          navigator.share({ title: 'Meu cenário do Brasileirão 2026', url: $('#shareLink').value }).catch(() => {});
          break;
        case 'copy-link':
          copyText($('#shareLink').value, 'Link copiado.');
          break;
        case 'backup-export':
          exportBackup();
          break;
        case 'copy-table':
          txt();
          break;
        case 'make-image':
          mkimg();
          break;
        case 'import-scenario':
          importCode();
          break;
        default:
          throw new Error(`A\u00e7\u00e3o desconhecida: ${act}`);
      }
    }
    document.addEventListener('click', (event) => {
      if (event.target === $('#mod')) {
        closeModal();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (!button) return;
      if (button.tagName === 'A') {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
      }
      try {
        Promise.resolve(runAction(button)).catch((error) => {
          notify(`N\u00e3o foi poss\u00edvel concluir a a\u00e7\u00e3o: ${error.message}`);
          console.error(error);
        });
      } catch (error) {
        notify(`N\u00e3o foi poss\u00edvel concluir a a\u00e7\u00e3o: ${error.message}`);
        console.error(error);
      }
    });
    document.addEventListener('input', (event) => {
      const input = event.target;
      if (input.matches('[data-input="score"]')) sv(input.dataset.match, Number(input.dataset.side), input.value);
      if (input.matches('[data-input="model-setting"]')) setS(input.dataset.setting, Number(input.value));
      if (input.matches('[data-input="club-adjustment"]')) adjL(input.value);
      if (input.id === 'siteSearch') {
        siteSearch = input.value;
        renderSearch();
      }
    });
    document.addEventListener('change', (event) => {
      const input = event.target,
        action = input.dataset.change;
      if (action === 'method') {
        if (!METH[input.value]) {
          notify('Método de simulação inválido.');
          return;
        }
        opt.meth = input.value;
        save();
        renderAll();
      } else if (action === 'team') setTeam(input.value);
      else if (action === 'leverage-goal') {
        leverageGoal = input.value;
        renderSide();
      } else if (action === 'stats-team') {
        statsTeam = input.value;
        renderStats();
      } else if (action === 'snapshot-stats-team') {
        snapshotStatsTeam = input.value;
        renderStats();
      } else if (action === 'snapshot-stats-round') {
        snapshotStatsRound = input.value;
        renderStats();
      } else if (action === 'club-profile') {
        statsTeam = input.value;
        renderClubPage();
        updateUrl();
      } else if (action === 'history-round') {
        selectedHistoryRound = Number(input.value);
        renderStats();
        updateUrl();
      } else if (action === 'compare-with') {
        $('#compareCode').hidden = input.value !== 'code';
      } else if (action === 'trend-metric') {
        trendMetric = input.value;
        trendClubs = null;
        renderChances();
      } else if (action === 'split-mode') {
        splitMode = input.value;
        renderStats();
      } else if (action === 'favorite-preference') {
        toggleFavorite(input.dataset.team).catch((error) => notify(error.message));
      } else if (action === 'reminder-enabled') {
        updateReminderPreference('inSiteReminders', input.checked)
          .then(() => {
            notify(input.checked ? 'Lembretes no site ativados.' : 'Lembretes no site desativados.');
          })
          .catch((error) => notify(error.message));
      } else if (action === 'reminder-minutes') {
        updateReminderPreference('reminderMinutes', Number(input.value)).catch((error) => notify(error.message));
      } else if (action === 'backup-file' && input.files?.[0])
        importBackup(input.files[0]).finally(() => {
          input.value = '';
        });
      else if (input.matches('[data-input="model-setting"]')) setSE();
      else if (input.matches('[data-input="model-seed"]')) updateSeed(input.value);
      else if (input.matches('[data-input="club-adjustment"]')) {
        renderSide();
        sched();
      }
    });
    document.addEventListener('submit', (event) => {
      const handlers = Object.assign(Object.create(null), {
          profileNameForm: updateProfileName,
          passwordChangeForm: updateAccountPassword,
          deleteAccountForm: deleteSignedInAccount,
        }),
        handler = handlers[event.target.id];
      if (!handler) return;
      event.preventDefault();
      handler(event).catch((error) => notify(error.message || String(error)));
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && accountDialog && !accountDialog.hidden) {
        closeAccountDialog();
        return;
      }
      if (event.key === 'Escape' && !$('#mod').hidden) {
        closeModal();
        return;
      }
      if (accountDialog && !accountDialog.hidden && event.key === 'Tab') {
        const focusable = Array.from(
          accountDialog.querySelectorAll('button,input,[href],[tabindex]:not([tabindex="-1"])'),
        ).filter((element) => !element.disabled);
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (!$('#mod').hidden && event.key === 'Tab') {
        const focusable = Array.from(
          $('#mod').querySelectorAll('button,input,textarea,[href],[tabindex]:not([tabindex="-1"])'),
        ).filter((element) => !element.disabled);
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (
        event.target.matches('[data-input="score"]') &&
        (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Enter')
      ) {
        const fields = Array.from(event.target.closest('.mc').querySelectorAll('[data-input="score"]')),
          index = fields.indexOf(event.target),
          direction = event.key === 'ArrowLeft' || event.shiftKey ? -1 : 1,
          target = fields[index + direction];
        if (target) {
          event.preventDefault();
          target.focus();
          target.select();
        }
        return;
      }
      const tabButton = event.target.closest('[role="tab"]');
      if (!tabButton) return;
      const current = TABS.findIndex(([key]) => key === tabButton.dataset.view);
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = TABS.length - 1;
      else return;
      event.preventDefault();
      show(TABS[next][0]);
    });
    document.querySelectorAll('[data-i]').forEach((e) => (e.innerHTML = ic(e.dataset.i)));
    const updatedLabel = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(dataUpdatedAt));
    $('#accountButton').addEventListener('click', () => {
      if (signedInUser) show('account');
      else openAccountDialog();
    });
    updateSourceStatus();
    updateThemeButton();
    $('#leg-lib').textContent = `1º–${Q.libertadoresLeaguePositions}º Libertadores`;
    $('#leg-sud').textContent = `${Q.sudamericanaLeagueStart}º–${Q.sudamericanaLeagueEnd}º Sul-Americana`;
    $('#leg-releg').textContent = `${T.length - Q.relegationPlaces + 1}º–${T.length}º rebaixamento`;
    function adoptSharedPayload(payload) {
      SC = payload.scores;
      SET = {
        k: payload.settings.k,
        ha: payload.settings.ha,
        rho: payload.settings.rho,
        seed: payload.settings.seed,
        adj: payload.settings.adjustments,
      };
      opt = { full: payload.options.full, odds: payload.options.odds, meth: payload.options.method };
      resetModel();
      Object.keys(SC).forEach(recordPredictionSnapshot);
      save();
    }
    const params = new URLSearchParams(location.search);
    const sharedCode = params.get('scenario');
    const shortId = /^\/c\/([A-Za-z0-9_-]{10})$/.exec(location.pathname)?.[1];
    const initialRoute = routeFromPath(location.pathname, NM);
    if (initialRoute) applyRoute(initialRoute);
    let initialView =
      initialRoute?.view || (TABS.some(([key]) => key === params.get('view')) ? params.get('view') : 'home');
    if (sharedCode) {
      try {
        adoptSharedPayload(payloadFromCode(`B28:${sharedCode}`));
        initialView = 'sim';
      } catch (error) {
        notify(`Link de cenário ignorado: ${error.message}`);
      }
    } else if (shortId) {
      try {
        const response = await fetch(`/api/share/${shortId}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        adoptSharedPayload(validatedPayload(body.payload));
        initialView = 'sim';
        history.replaceState(null, '', '/');
      } catch (error) {
        notify(`Cenário compartilhado indisponível: ${error.message}`);
      }
    }
    nav();
    show(initialView, { focus: false, push: false });
    addEventListener('popstate', () => {
      const route = routeFromPath(location.pathname, NM);
      if (!route) return;
      applyRoute(route);
      show(route.view, { focus: false, push: false });
    });
    if (initialView !== 'sim') sched();
    loadProbabilityHistory();
    await initializeAccount();
    scheduleLiveRefresh();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLiveRefresh > 60_000) refreshLive(false);
    });
    setInterval(checkInSiteReminders, 60_000);
    document.addEventListener('visibilitychange', checkInSiteReminders);
    checkInSiteReminders();
    if ('serviceWorker' in navigator && location.protocol !== 'file:')
      navigator.serviceWorker
        .register('/sw.js')
        .catch((error) => console.warn('Service worker não registrado:', error));
  } catch (error) {
    showLoadError(error);
    console.error('Falha ao iniciar o simulador:', error);
  }
})();
