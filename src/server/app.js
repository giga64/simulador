// Rotas do servidor. As dependências (feed, armazenamento, Supabase...) vêm de
// scripts/serve.mjs, o que permite testar o roteamento sem rede.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeScenarioPayload, pruneCompletedScenarioScores, validateScenarioPayload } from '../scenario.js';
import { isPublicPath } from '../static-paths.js';
import { clientIp, createRateLimiter, readJsonBody, securityHeaders, sendJson, sendText } from './http.js';
import { projectScenarioTable } from './og-image.js';
import { normalizeClientError } from './monitor.js';
import { applyMeta, describeRoute, escapeAttribute } from './seo.js';
import { allPaths, routeFromPath } from '../client/routes.js';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);
const LONG_CACHE = new Set(['.webp', '.png', '.svg', '.ico', '.woff2']);
const SHARE_ID = /^[A-Za-z0-9_-]{10}$/;
const MAX_SCENARIO_CODE = 30_000;

export function createRequestHandler({
  root,
  production = false,
  trustProxy = false,
  siteUrl = '',
  readLiveFeed,
  seasonService,
  publicConfig,
  deleteAccount,
  sharedScenarios,
  renderScenarioImage,
  oddsTracker,
  competitionService = null,
  monitor = null,
  recordClientError = null,
  logger = console,
}) {
  const limits = {
    api: createRateLimiter({ windowMs: 60_000, max: 60 }),
    forceRefresh: createRateLimiter({ windowMs: 60_000, max: 4 }),
    account: createRateLimiter({ windowMs: 10 * 60_000, max: 5 }),
    share: createRateLimiter({ windowMs: 60_000, max: 10 }),
    clientErrors: createRateLimiter({ windowMs: 60_000, max: 10 }),
    image: createRateLimiter({ windowMs: 60_000, max: 30 }),
  };
  // Consulta forçada à fonte no máximo a cada 20 s, para todos os visitantes juntos.
  let lastForcedRefresh = 0;
  const imageCache = new Map();
  const indexHtml = () => readFileSync(path.join(root, 'index.html'), 'utf8');
  const absolute = (pathname) => (siteUrl ? new URL(pathname, siteUrl).href : pathname);

  const tooMany = (response, retryAfter) =>
    sendJson(
      response,
      429,
      { error: 'Muitas requisições. Tente novamente em instantes.' },
      { 'Retry-After': String(retryAfter) },
    );

  function scenarioFromPayload(payload) {
    const { seasonData, round } = seasonService.state;
    const pruned = pruneCompletedScenarioScores(payload?.scores, seasonData.fixtures, round?.number, []);
    const normalized = { ...payload, scores: pruned.scores };
    const check = validateScenarioPayload(
      normalized,
      seasonData.fixtures.map((fixture) => fixture.id),
      seasonService.teams,
    );
    if (check.errors.length) throw Object.assign(new Error(check.errors[0]), { status: 400 });
    return normalized;
  }

  function scenarioImage(payload) {
    const { seasonData, standings, live, round, fetchedAt } = seasonService.state;
    const key = createHash('sha256').update(JSON.stringify(payload.scores)).update(String(fetchedAt)).digest('hex');
    if (imageCache.has(key)) return imageCache.get(key);
    const scores = new Map(
      Object.entries(payload.scores)
        .filter(([, value]) => value[0] !== '' && value[1] !== '')
        .map(([id, value]) => [id, [Number(value[0]), Number(value[1])]]),
    );
    const { rows, defined } = projectScenarioTable({
      seasonData,
      standings,
      live,
      currentRound: round?.number,
      scores,
    });
    const png = renderScenarioImage({
      rows,
      teamNames: seasonData.teams,
      qualification: seasonData.qualificationModel,
      defined,
    });
    if (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, png);
    return png;
  }

  // index.html com título, descrição, canonical e imagem de cada endereço.
  async function sendIndex(response, { route = null, path = '/', imagePath = null, title = null, description = null }) {
    let meta = { title, description };
    if (!title) {
      const history = await seasonService.probabilityHistory().catch(() => []);
      meta = describeRoute(route, {
        teams: seasonService.state.seasonData.teams,
        chances: history.at(-1)?.chances || null,
        round: seasonService.state.round?.number,
      });
    }
    const html = applyMeta(indexHtml(), {
      ...meta,
      url: siteUrl ? absolute(path) : null,
      image: imagePath ? absolute(imagePath) : siteUrl ? absolute('/assets/og-image.png') : null,
    });
    response
      .writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/html; charset=utf-8',
        ...securityHeaders({ production, html: true }),
      })
      .end(html);
  }

  // Endereço base para o sitemap: SITE_URL ou o Host da requisição (validado).
  function baseUrl(request) {
    if (siteUrl) return siteUrl;
    const host = String(request.headers.host || '');
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null;
    const proto = trustProxy && request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }

  function serveStatic(request, response, relative) {
    if (!isPublicPath(relative)) return sendText(response, 404, 'Not found', securityHeaders({ production }));
    const filePath = path.resolve(root, relative);
    if (!filePath.startsWith(`${root}${path.sep}`)) return sendText(response, 403, 'Forbidden');
    let stats;
    try {
      stats = statSync(filePath);
      if (!stats.isFile()) throw new Error('not a file');
    } catch {
      return sendText(response, 404, 'Not found', securityHeaders({ production }));
    }
    const extension = path.extname(filePath).toLowerCase();
    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const headers = {
      'Cache-Control': LONG_CACHE.has(extension) ? 'public, max-age=86400' : 'no-cache',
      'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
      ETag: etag,
      ...securityHeaders({
        production,
        html: extension === '.html',
        crossOriginResource: relative === 'assets/og-image.png',
      }),
    };
    if (request.headers['if-none-match'] === etag) return response.writeHead(304, headers).end();
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  }

  async function handle(request, response) {
    const method = request.method || '';
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) {
      return sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST, DELETE' });
    }
    let url;
    let pathname;
    try {
      url = new URL(request.url || '/', 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0')) throw new Error('null byte');
    } catch {
      return sendText(response, 400, 'Bad request');
    }
    const ip = clientIp(request, { trustProxy });
    const api = pathname.startsWith('/api/');
    if (api) {
      const { allowed, retryAfter } = limits.api(ip);
      if (!allowed) return tooMany(response, retryAfter);
    }
    const onlyGet = () => {
      if (method === 'GET' || method === 'HEAD') return false;
      sendText(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return true;
    };

    if (pathname === '/api/live-season') {
      if (method !== 'GET') return sendText(response, 405, 'Method not allowed', { Allow: 'GET' });
      let forceRefresh = url.searchParams.get('refresh') === '1';
      if (forceRefresh) {
        const { allowed, retryAfter } = limits.forceRefresh(ip);
        if (!allowed) return tooMany(response, retryAfter);
        if (Date.now() - lastForcedRefresh < 20_000) forceRefresh = false;
        else lastForcedRefresh = Date.now();
      }
      try {
        return sendJson(response, 200, await readLiveFeed({ forceRefresh }));
      } catch (error) {
        logger.error(`Feed ao vivo indisponível: ${error.message}`);
        return sendJson(response, 502, { error: 'Não foi possível consultar a fonte GE neste momento.' });
      }
    }

    // Para monitores externos (UptimeRobot etc.): 503 quando alguma fonte está fora do ar.
    if (pathname === '/api/health') {
      if (onlyGet()) return;
      const health = monitor ? monitor.status() : { status: 'ok', sources: {} };
      return sendJson(response, health.status === 'ok' ? 200 : 503, {
        ...health,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (pathname === '/api/client-errors') {
      if (method !== 'POST') return sendText(response, 405, 'Method not allowed', { Allow: 'POST' });
      const { allowed, retryAfter } = limits.clientErrors(ip);
      if (!allowed) return tooMany(response, retryAfter);
      try {
        const entry = normalizeClientError(await readJsonBody(request, { limit: 4096 }));
        if (entry && recordClientError) recordClientError(entry);
        return response.writeHead(204).end();
      } catch (error) {
        return sendJson(response, error.status || 400, { error: error.message });
      }
    }

    if (pathname === '/api/config') {
      if (onlyGet()) return;
      return sendJson(response, 200, publicConfig);
    }

    if (pathname === '/api/probability-history') {
      if (onlyGet()) return;
      return sendJson(
        response,
        200,
        { entries: await seasonService.probabilityHistory() },
        { 'Cache-Control': 'public, max-age=60' },
      );
    }

    const competitionMatch = /^\/api\/competition\/([A-Za-z]+)$/.exec(pathname);
    if (competitionMatch) {
      if (onlyGet()) return;
      if (!competitionService) return sendJson(response, 503, { error: 'Copas indisponíveis.' });
      try {
        return sendJson(response, 200, await competitionService.read(competitionMatch[1]), {
          'Cache-Control': 'no-store',
        });
      } catch (error) {
        return sendJson(response, error.status || 502, {
          error: error.status ? error.message : 'Não foi possível consultar a fonte das copas agora.',
        });
      }
    }

    if (pathname === '/api/model-vs-market') {
      if (onlyGet()) return;
      return sendJson(response, 200, await oddsTracker.comparison(seasonService.state.seasonData.results), {
        'Cache-Control': 'public, max-age=300',
      });
    }

    if (pathname === '/api/account') {
      if (method !== 'DELETE') return sendText(response, 405, 'Method not allowed', { Allow: 'DELETE' });
      const { allowed, retryAfter } = limits.account(ip);
      if (!allowed) return tooMany(response, retryAfter);
      const token = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(request.headers.authorization || '')?.[1];
      if (!token) return sendJson(response, 401, { error: 'Sessão inválida. Entre novamente para excluir a conta.' });
      const result = await deleteAccount(token);
      return sendJson(response, result.status, result.body);
    }

    if (pathname === '/api/share') {
      if (method !== 'POST') return sendText(response, 405, 'Method not allowed', { Allow: 'POST' });
      if (!sharedScenarios.enabled) return sendJson(response, 503, { error: 'Links curtos não estão configurados.' });
      const { allowed, retryAfter } = limits.share(ip);
      if (!allowed) return tooMany(response, retryAfter);
      try {
        const body = await readJsonBody(request, { limit: MAX_SCENARIO_CODE });
        const payload = scenarioFromPayload(body?.payload);
        const id = await sharedScenarios.save(payload);
        return sendJson(response, 200, { id, url: absolute(`/c/${id}`) });
      } catch (error) {
        return sendJson(response, error.status || 500, {
          error: error.status ? error.message : 'Não foi possível criar o link.',
        });
      }
    }

    const sharedMatch = /^\/api\/share\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (sharedMatch) {
      if (onlyGet()) return;
      if (!SHARE_ID.test(sharedMatch[1]) || !sharedScenarios.enabled)
        return sendJson(response, 404, { error: 'Cenário não encontrado.' });
      const payload = await sharedScenarios.load(sharedMatch[1]);
      if (!payload) return sendJson(response, 404, { error: 'Cenário não encontrado.' });
      return sendJson(response, 200, { payload }, { 'Cache-Control': 'public, max-age=300' });
    }

    if (pathname === '/api/og/scenario.png' || /^\/api\/og\/c\/[A-Za-z0-9_-]+\.png$/.test(pathname)) {
      if (onlyGet()) return;
      const { allowed, retryAfter } = limits.image(ip);
      if (!allowed) return tooMany(response, retryAfter);
      try {
        let payload;
        if (pathname === '/api/og/scenario.png') {
          const code = url.searchParams.get('s') || '';
          if (code.length > MAX_SCENARIO_CODE) throw Object.assign(new Error('Código grande demais.'), { status: 414 });
          payload = scenarioFromPayload(decodeScenarioPayload(code));
        } else {
          const id = pathname.slice('/api/og/c/'.length, -'.png'.length);
          payload = SHARE_ID.test(id) && sharedScenarios.enabled ? await sharedScenarios.load(id) : null;
          if (!payload) throw Object.assign(new Error('Cenário não encontrado.'), { status: 404 });
          payload = scenarioFromPayload(payload);
        }
        const png = scenarioImage(payload);
        response
          .writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=600',
            ...securityHeaders({ production, crossOriginResource: true }),
          })
          .end(png);
      } catch (error) {
        if (!error.status) logger.error(`Imagem de cenário: ${error.message}`);
        response.writeHead(302, { Location: '/assets/og-image.png', 'Cache-Control': 'no-store' }).end();
      }
      return;
    }

    if (pathname === '/vendor/supabase.js') {
      if (onlyGet()) return;
      return serveVendor(request, response);
    }

    const shortLink = /^\/c\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (shortLink) {
      if (onlyGet()) return;
      if (!SHARE_ID.test(shortLink[1])) return sendText(response, 404, 'Not found');
      return sendIndex(response, {
        imagePath: `/api/og/c/${shortLink[1]}.png`,
        title: 'Meu cenário do Brasileirão 2026 · SimulaBR',
        description: 'Veja a classificação e o campeão do meu cenário do Brasileirão 2026 e monte o seu no SimulaBR.',
        path: `/c/${shortLink[1]}`,
      });
    }

    if (api) return sendJson(response, 404, { error: 'Rota inexistente.' });
    if (onlyGet()) return;
    if (pathname === '/' || pathname === '/index.html') {
      const code = url.searchParams.get('scenario');
      if (code && code.length <= MAX_SCENARIO_CODE && /^[A-Za-z0-9_-]+$/.test(code)) {
        return sendIndex(response, {
          imagePath: `/api/og/scenario.png?s=${code}`,
          title: 'Meu cenário do Brasileirão 2026 · SimulaBR',
          description: 'Veja a classificação e o campeão do meu cenário do Brasileirão 2026 e monte o seu no SimulaBR.',
        });
      }
      return sendIndex(response, { route: { view: 'home' }, path: '/' });
    }
    if (pathname === '/robots.txt') {
      const base = baseUrl(request);
      return sendText(
        response,
        200,
        `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /c/\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`,
        { 'Cache-Control': 'public, max-age=3600' },
      );
    }
    if (pathname === '/sitemap.xml') {
      const base = baseUrl(request);
      if (!base) return sendText(response, 400, 'Bad request');
      const urls = allPaths(seasonService.state.seasonData.teams)
        .map((path) => `<url><loc>${escapeAttribute(base + path)}</loc></url>`)
        .join('');
      return response
        .writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' })
        .end(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
        );
    }
    const route = routeFromPath(pathname, seasonService.state.seasonData.teams);
    if (route) return sendIndex(response, { route, path: pathname.replace(/\/+$/, '') });
    return serveStatic(request, response, pathname.replace(/^[/\\]+/, ''));
  }

  const supabaseSdkPath = path.join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
  function serveVendor(request, response) {
    try {
      if (!statSync(supabaseSdkPath).isFile()) throw new Error('SDK unavailable');
    } catch {
      return sendText(response, 503, 'Supabase client SDK unavailable', { 'Cache-Control': 'no-store' });
    }
    response.writeHead(200, {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': 'text/javascript; charset=utf-8',
      ...securityHeaders({ production }),
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(supabaseSdkPath).pipe(response);
  }

  return async function requestHandler(request, response) {
    try {
      await handle(request, response);
    } catch (error) {
      logger.error(`Erro inesperado em ${request.method} ${request.url}: ${error.stack || error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'Erro interno.' });
      else response.destroy();
    }
  };
}
