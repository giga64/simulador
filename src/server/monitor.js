// Monitoramento das fontes de dados e dos erros de JavaScript dos visitantes.
//
// Fonte fora do ar há mais de 30 min em dia de jogo (2 h nos outros dias):
// registra no log e, se ALERT_WEBHOOK_URL estiver configurada, avisa num
// webhook (formato aceito por Discord e Slack). Avisa de novo quando volta.
import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';

const MATCH_DAY_THRESHOLD_MS = 30 * 60_000;
const OTHER_DAY_THRESHOLD_MS = 2 * 60 * 60_000;

export function createSourceMonitor({
  webhookUrl = '',
  isMatchDay = () => false,
  clock = Date.now,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const sources = new Map();
  const validWebhook = (() => {
    try {
      return new URL(webhookUrl).protocol === 'https:' ? webhookUrl : '';
    } catch {
      return '';
    }
  })();

  async function alert(message) {
    logger.error(`[alerta] ${message}`);
    if (!validWebhook) return;
    try {
      await fetchImpl(validWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message, text: message }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.error(`Não foi possível enviar o alerta: ${error.message}`);
    }
  }

  const entry = (name) => {
    if (!sources.has(name)) sources.set(name, { lastSuccess: null, failingSince: null, lastError: '', alerted: false });
    return sources.get(name);
  };
  const threshold = () => (isMatchDay() ? MATCH_DAY_THRESHOLD_MS : OTHER_DAY_THRESHOLD_MS);

  return {
    success(name) {
      const source = entry(name);
      if (source.alerted) void alert(`✅ SimulaBR: a fonte ${name} voltou a responder.`);
      Object.assign(source, { lastSuccess: clock(), failingSince: null, lastError: '', alerted: false });
    },
    failure(name, error) {
      const source = entry(name);
      source.failingSince ??= clock();
      source.lastError = String(error?.message || error).slice(0, 200);
      const minutes = Math.round((clock() - source.failingSince) / 60_000);
      if (!source.alerted && clock() - source.failingSince >= threshold()) {
        source.alerted = true;
        void alert(`⚠️ SimulaBR: a fonte ${name} está falhando há ${minutes} min. Último erro: ${source.lastError}`);
      }
    },
    // Para /api/health: nada de segredos, só o estado de cada fonte.
    status() {
      const now = clock();
      const report = {};
      let degraded = false;
      for (const [name, source] of sources) {
        const down = source.failingSince !== null && now - source.failingSince >= threshold();
        degraded ||= down;
        report[name] = {
          ok: source.failingSince === null,
          lastSuccess: source.lastSuccess !== null ? new Date(source.lastSuccess).toISOString() : null,
          failingSince: source.failingSince !== null ? new Date(source.failingSince).toISOString() : null,
        };
      }
      return { status: degraded ? 'degraded' : 'ok', sources: report };
    },
  };
}

// Erros do navegador: normaliza, limita tamanho e grava em JSON Lines, com
// rotação simples ao passar de 1 MB.
const MAX_FIELD = 300;
const clean = (value, max = MAX_FIELD) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
        .slice(0, max)
    : '';

export function normalizeClientError(body) {
  if (!body || typeof body !== 'object') return null;
  const message = clean(body.message);
  if (!message) return null;
  let page = '';
  try {
    const url = new URL(body.url);
    page = url.pathname; // sem query string: pode conter o código do cenário
  } catch {
    page = '';
  }
  return {
    message,
    source: clean(body.source, 120).replace(/[?#].*$/, ''),
    line: Number.isInteger(body.line) ? body.line : null,
    column: Number.isInteger(body.column) ? body.column : null,
    stack: clean(body.stack, 1200),
    page,
    view: clean(body.view, 20),
  };
}

export function createClientErrorLog(filePath, { maxBytes = 1_000_000, logger = console } = {}) {
  let queue = Promise.resolve();
  return function record(entry) {
    queue = queue
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        try {
          if ((await stat(filePath)).size > maxBytes) await rename(filePath, `${filePath}.1`);
        } catch {
          // arquivo ainda não existe
        }
        await appendFile(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
      })
      .catch((error) => logger.error(`Não foi possível gravar erro do navegador: ${error.message}`));
    return queue;
  };
}
